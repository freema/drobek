/**
 * The workspace header on PGlite: two personal workspaces both named
 * "Personal" are told apart by slug and owner, and the access badge follows
 * the real source of access — a super-admin without a membership, a real
 * workspace admin and a plain member.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apps, appVersions, memberships, setDbForTests, users } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import type { WorkspaceAccess, WorkspaceSummary } from './membership.server.js';
import { personalWorkspaceOwners, workspaceAppCounts } from './membership.server.js';
import { ensurePersonalWorkspace } from './personal-workspace.server.js';
import { decideWorkspaceAccess, type WorkspaceRole } from './roles.js';
import { createTeamWorkspace } from './team-workspace.server.js';
import { workspaceNav } from './workspace-nav.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url));

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function user(email: string): Promise<{ id: string; email: string }> {
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  return { id: u!.id, email };
}

function access(
  u: { id: string; email: string },
  workspace: WorkspaceSummary,
  membershipRole: WorkspaceRole | null,
  superAdmin: boolean
): WorkspaceAccess {
  const decision = decideWorkspaceAccess({ membershipRole, superAdmin, minRole: 'viewer' });
  if (!decision.ok) throw new Error('no access');
  return {
    user: { id: u.id, email: u.email } as WorkspaceAccess['user'],
    workspace,
    membershipRole,
    superAdmin,
    effectiveRole: decision.effectiveRole,
  };
}

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(null);
  await pg.close();
});

describe('workspaceNav', () => {
  it('a super-admin in someone else’s "Personal" sees its slug, its owner and superadmin access', async () => {
    const admin = await user('root@example.test');
    const adminPersonal = await ensurePersonalWorkspace(admin.id, admin.email);
    const jana = await user('jana@example.test');
    const janaPersonal = await ensurePersonalWorkspace(jana.id, jana.email);
    expect(adminPersonal.name).toBe(janaPersonal.name);

    const nav = await workspaceNav(access(admin, janaPersonal, null, true));
    expect(nav).toMatchObject({
      name: 'Personal',
      slug: janaPersonal.slug,
      role: 'Superadmin access — not a member',
      roleSource: 'superadmin',
      ownerEmail: 'jana@example.test',
      canViewActivity: true,
    });
    expect(nav.slug).not.toBe(adminPersonal.slug);
    // the switcher offers the super-admin's own workspaces, not Jana's
    expect(nav.switchTo.map((w) => w.slug)).toEqual([adminPersonal.slug]);

    const own = await workspaceNav(access(admin, adminPersonal, 'workspace-admin', true));
    expect(own).toMatchObject({ role: 'workspace-admin', roleSource: 'member', ownerEmail: null });
  });

  it('a real workspace admin and a plain member see their membership role', async () => {
    const owner = await user('owner@example.test');
    const created = await createTeamWorkspace(owner.id, 'Acme', 'acme');
    if (!created.ok) throw new Error(created.message);
    const team = created.workspace;
    const member = await user('member@example.test');
    await db.insert(memberships).values({ userId: member.id, workspaceId: team.id, role: 'viewer' });

    const adminNav = await workspaceNav(access(owner, team, 'workspace-admin', false));
    expect(adminNav).toMatchObject({ role: 'workspace-admin', roleSource: 'member', ownerEmail: null, canViewActivity: true });
    expect(adminNav.switchTo.map((w) => w.slug)).toEqual(['acme']);

    const memberNav = await workspaceNav(access(member, team, 'viewer', false));
    expect(memberNav).toMatchObject({ role: 'viewer', roleSource: 'member', canViewActivity: false });
    expect(memberNav.switchTo).toEqual([{ slug: 'acme', name: 'Acme', kind: 'team', role: 'viewer' }]);
  });

  it('personalWorkspaceOwners names only personal workspaces', async () => {
    const owners = await personalWorkspaceOwners();
    const emails = [...owners.values()];
    expect(emails).toEqual(expect.arrayContaining(['root@example.test', 'jana@example.test']));
    expect(emails).not.toContain('owner@example.test');
    expect(await personalWorkspaceOwners([])).toEqual(new Map());
  });

  it('workspaceAppCounts counts live apps and the published ones, leaving deleted apps out', async () => {
    const owner = await user('counts@example.test');
    const created = await createTeamWorkspace(owner.id, 'Counts', 'counts');
    if (!created.ok) throw new Error(created.message);
    const ws = created.workspace;
    const empty = await createTeamWorkspace(owner.id, 'Empty', 'empty-ws');
    if (!empty.ok) throw new Error(empty.message);

    const [published, , deleted] = await db
      .insert(apps)
      .values([
        { workspaceId: ws.id, slug: 'counts-live' },
        { workspaceId: ws.id, slug: 'counts-draft' },
        { workspaceId: ws.id, slug: 'counts-gone~deleted-abc', deletedAt: new Date() },
      ])
      .returning({ id: apps.id });
    for (const app of [published!, deleted!]) {
      const [v] = await db
        .insert(appVersions)
        .values({ appId: app.id, number: 1, actorKind: 'agent' })
        .returning({ id: appVersions.id });
      await db.update(apps).set({ publishedVersionId: v!.id }).where(eq(apps.id, app.id));
    }

    const counts = await workspaceAppCounts();
    expect(counts.get(ws.id)).toEqual({ apps: 2, published: 1 });
    expect(counts.has(empty.workspace.id)).toBe(false);
  });
});
