/**
 * Membership changes on PGlite: role change, removal and leaving with the
 * rules both the dashboard and MCP rely on (workspace-admin only, never the
 * last admin, never a personal workspace), the audit rows, the release of the
 * member's app leases, and revoking a pending invite.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apps, auditLog, memberships, setDbForTests, users, workspaces } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import type { Lease } from '@drobek/apps';
import { TenancyFakeRedis } from './fake-redis.js';

let fake: TenancyFakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return {
    ...actual,
    getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis>,
  };
});

import { consumeInvite, createInvite, listPendingInvites, revokeInvite } from './invites.server.js';
import { resolveWorkspaceAccess } from './membership.server.js';
import { MembershipError, assertMemberRemovable, changeMemberRole, findWorkspaceMember, removeMember, type MembershipActor } from './members.server.js';
import type { WorkspaceRole } from './roles.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url));

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

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

beforeEach(() => {
  fake = new TenancyFakeRedis();
});

let n = 0;

async function user(tag: string): Promise<string> {
  n += 1;
  const [u] = await db.insert(users).values({ email: `${tag}-${n}@example.test` }).returning({ id: users.id });
  return u!.id;
}

async function team(members: Record<string, WorkspaceRole>): Promise<{ id: string; kind: 'team' }> {
  n += 1;
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: `team-${n}`, name: `Team ${n}` }).returning({ id: workspaces.id });
  for (const [userId, role] of Object.entries(members)) {
    await db.insert(memberships).values({ userId, workspaceId: w!.id, role });
  }
  return { id: w!.id, kind: 'team' };
}

const as = (userId: string, role: WorkspaceRole): MembershipActor => ({ userId, kind: 'user', role });

async function roleOf(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  return row?.role ?? null;
}

async function audit(workspaceId: string) {
  return db
    .select({ action: auditLog.action, actorUserId: auditLog.actorUserId, actorKind: auditLog.actorKind, target: auditLog.target, meta: auditLog.meta })
    .from(auditLog)
    .where(eq(auditLog.workspaceId, workspaceId))
    .orderBy(auditLog.createdAt);
}

/** An in-memory lease table with the compare-and-delete the Redis script does. */
function leaseTable(entries: Record<string, string> = {}) {
  const held = new Map(Object.entries(entries));
  return {
    held,
    take: async (appId: string, holderUserId: string): Promise<Lease | null> => {
      if (held.get(appId) !== holderUserId) return null;
      held.delete(appId);
      return { holder_user_id: holderUserId, session_id: 's', expires_at: '2026-10-02T10:03:00.000Z' };
    },
  };
}

async function errorOf(p: Promise<unknown>): Promise<MembershipError> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MembershipError);
  return err as MembershipError;
}

describe('changeMemberRole', () => {
  it('a workspace admin changes a role, audited from → to; the same role again changes nothing', async () => {
    const admin = await user('admin');
    const ed = await user('ed');
    const ws = await team({ [admin]: 'workspace-admin', [ed]: 'editor' });

    const out = await changeMemberRole({ workspace: ws, userId: ed, role: 'workspace-admin', actor: as(admin, 'workspace-admin'), takeLease: leaseTable().take });
    expect(out).toEqual({ changed: true, from: 'editor', to: 'workspace-admin', releasedLocks: [] });
    expect(await roleOf(ws.id, ed)).toBe('workspace-admin');

    const again = await changeMemberRole({ workspace: ws, userId: ed, role: 'workspace-admin', actor: as(admin, 'workspace-admin') });
    expect(again).toMatchObject({ changed: false, from: 'workspace-admin' });
    expect((await audit(ws.id)).map((a) => [a.action, a.target, a.meta])).toEqual([['member.role_change', ed, { from: 'editor', to: 'workspace-admin' }]]);
  });

  it('a member who becomes a viewer loses their app leases (audited), others keep theirs', async () => {
    const admin = await user('admin');
    const ed = await user('ed');
    const other = await user('other');
    const ws = await team({ [admin]: 'workspace-admin', [ed]: 'editor', [other]: 'editor' });
    const [a1] = await db.insert(apps).values({ workspaceId: ws.id, slug: `lease-a-${n}` }).returning();
    const [a2] = await db.insert(apps).values({ workspaceId: ws.id, slug: `lease-b-${n}` }).returning();
    const leases = leaseTable({ [a1!.id]: ed, [a2!.id]: other });

    const out = await changeMemberRole({ workspace: ws, userId: ed, role: 'viewer', actor: as(admin, 'workspace-admin'), takeLease: leases.take });
    expect(out.releasedLocks).toEqual([a1!.slug]);
    expect([...leases.held.entries()]).toEqual([[a2!.id, other]]);
    const rows = await audit(ws.id);
    expect(rows.find((r) => r.action === 'app.lock.release')).toMatchObject({ actorUserId: admin, target: a1!.slug, meta: { previousHolderUserId: ed } });

    // editor → workspace-admin keeps leases (still a writer).
    const leases2 = leaseTable({ [a2!.id]: other });
    expect((await changeMemberRole({ workspace: ws, userId: other, role: 'workspace-admin', actor: as(admin, 'workspace-admin'), takeLease: leases2.take })).releasedLocks).toEqual([]);
    expect(leases2.held.size).toBe(1);
  });

  it('only a workspace admin changes roles', async () => {
    const admin = await user('admin');
    const ed = await user('ed');
    const ws = await team({ [admin]: 'workspace-admin', [ed]: 'editor' });
    const err = await errorOf(changeMemberRole({ workspace: ws, userId: admin, role: 'viewer', actor: as(ed, 'editor') }));
    expect(err.code).toBe('forbidden');
    expect(await roleOf(ws.id, admin)).toBe('workspace-admin');
  });

  it('never demotes the last workspace admin; with a second admin it can', async () => {
    const admin = await user('admin');
    const ed = await user('ed');
    const ws = await team({ [admin]: 'workspace-admin', [ed]: 'editor' });
    const err = await errorOf(changeMemberRole({ workspace: ws, userId: admin, role: 'editor', actor: as(admin, 'workspace-admin') }));
    expect(err.code).toBe('last_workspace_admin');
    expect(err.message).toMatch(/Make another member a workspace-admin first/);

    await changeMemberRole({ workspace: ws, userId: ed, role: 'workspace-admin', actor: as(admin, 'workspace-admin') });
    await changeMemberRole({ workspace: ws, userId: admin, role: 'editor', actor: as(admin, 'workspace-admin') });
    expect(await roleOf(ws.id, admin)).toBe('editor');
  });

  it('a personal workspace and a non-member are refused', async () => {
    const owner = await user('owner');
    const [p] = await db.insert(workspaces).values({ kind: 'personal', slug: `personal-${n}`, name: 'Personal' }).returning();
    await db.insert(memberships).values({ userId: owner, workspaceId: p!.id, role: 'workspace-admin' });
    const personal = { id: p!.id, kind: 'personal' as const };
    expect((await errorOf(changeMemberRole({ workspace: personal, userId: owner, role: 'editor', actor: as(owner, 'workspace-admin') }))).code).toBe('personal_workspace');
    expect((await errorOf(removeMember({ workspace: personal, userId: owner, actor: as(owner, 'workspace-admin') }))).code).toBe('personal_workspace');

    const admin = await user('admin');
    const stranger = await user('stranger');
    const ws = await team({ [admin]: 'workspace-admin' });
    expect((await errorOf(changeMemberRole({ workspace: ws, userId: stranger, role: 'editor', actor: as(admin, 'workspace-admin') }))).code).toBe('not_found');
  });
});

describe('removeMember', () => {
  it('a workspace admin removes a member: access gone at once, leases released, audited member.remove', async () => {
    const admin = await user('admin');
    const ed = await user('ed');
    const ws = await team({ [admin]: 'workspace-admin', [ed]: 'editor' });
    const [app] = await db.insert(apps).values({ workspaceId: ws.id, slug: `rm-${n}` }).returning();
    const leases = leaseTable({ [app!.id]: ed });
    const [w] = await db.select({ slug: workspaces.slug }).from(workspaces).where(eq(workspaces.id, ws.id));
    expect(await resolveWorkspaceAccess({ userId: ed, superAdmin: false, workspaceSlug: w!.slug })).not.toBeNull();

    const out = await removeMember({ workspace: ws, userId: ed, actor: { userId: admin, kind: 'agent', role: 'workspace-admin' }, takeLease: leases.take });
    expect(out).toEqual({ role: 'editor', left: false, releasedLocks: [app!.slug] });
    expect(await roleOf(ws.id, ed)).toBeNull();
    expect(await resolveWorkspaceAccess({ userId: ed, superAdmin: false, workspaceSlug: w!.slug })).toBeNull();
    expect(leases.held.size).toBe(0);
    const rows = await audit(ws.id);
    expect(rows.find((r) => r.action === 'member.remove')).toEqual({ action: 'member.remove', actorUserId: admin, actorKind: 'agent', target: ed, meta: { role: 'editor' } });

    expect((await errorOf(removeMember({ workspace: ws, userId: ed, actor: as(admin, 'workspace-admin') }))).code).toBe('not_found');
  });

  it('an editor cannot remove someone else, but any member can leave (member.leave)', async () => {
    const admin = await user('admin');
    const ed = await user('ed');
    const viewer = await user('viewer');
    const ws = await team({ [admin]: 'workspace-admin', [ed]: 'editor', [viewer]: 'viewer' });
    expect((await errorOf(removeMember({ workspace: ws, userId: viewer, actor: as(ed, 'editor') }))).code).toBe('forbidden');

    const out = await removeMember({ workspace: ws, userId: viewer, actor: as(viewer, 'viewer'), takeLease: leaseTable().take });
    expect(out).toEqual({ role: 'viewer', left: true, releasedLocks: [] });
    expect((await audit(ws.id)).at(-1)).toMatchObject({ action: 'member.leave', actorUserId: viewer, target: viewer, meta: { role: 'viewer' } });
  });

  it('the last workspace admin can neither leave nor be removed; two admins removing each other at once leave one', async () => {
    const a = await user('a');
    const b = await user('b');
    const ws = await team({ [a]: 'workspace-admin', [b]: 'workspace-admin' });
    const results = await Promise.allSettled([
      removeMember({ workspace: ws, userId: b, actor: as(a, 'workspace-admin'), takeLease: leaseTable().take }),
      removeMember({ workspace: ws, userId: a, actor: as(b, 'workspace-admin'), takeLease: leaseTable().take }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'last_workspace_admin' });

    const remaining = (await roleOf(ws.id, a)) ? a : b;
    const leave = await errorOf(removeMember({ workspace: ws, userId: remaining, actor: as(remaining, 'workspace-admin') }));
    expect(leave.code).toBe('last_workspace_admin');
    expect(leave.message).toMatch(/then leave/);
  });
});

describe('assertMemberRemovable', () => {
  it('answers the refusal removeMember would, changing nothing', async () => {
    const admin = await user('admin');
    const ed = await user('ed');
    const stranger = await user('stranger');
    const ws = await team({ [admin]: 'workspace-admin', [ed]: 'editor' });
    await expect(assertMemberRemovable({ workspace: ws, userId: ed, actor: as(admin, 'workspace-admin') })).resolves.toBeUndefined();
    await expect(assertMemberRemovable({ workspace: ws, userId: ed, actor: as(ed, 'editor') })).resolves.toBeUndefined();
    expect((await errorOf(assertMemberRemovable({ workspace: ws, userId: admin, actor: as(ed, 'editor') }))).code).toBe('forbidden');
    expect((await errorOf(assertMemberRemovable({ workspace: ws, userId: admin, actor: as(admin, 'workspace-admin') }))).code).toBe('last_workspace_admin');
    expect((await errorOf(assertMemberRemovable({ workspace: ws, userId: stranger, actor: as(admin, 'workspace-admin') }))).code).toBe('not_found');
    expect((await errorOf(assertMemberRemovable({ workspace: { id: ws.id, kind: 'personal' }, userId: ed, actor: as(admin, 'workspace-admin') }))).code).toBe(
      'personal_workspace'
    );
    expect(await roleOf(ws.id, ed)).toBe('editor');
    expect(await audit(ws.id)).toEqual([]);
  });
});

describe('findWorkspaceMember', () => {
  it('finds a member by e-mail, case-insensitively, and only in that workspace', async () => {
    const ed = await user('findme');
    const ws = await team({ [ed]: 'editor' });
    const other = await team({});
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, ed));
    expect(await findWorkspaceMember(ws.id, `  ${u!.email.toUpperCase()} `)).toEqual({ userId: ed, email: u!.email, role: 'editor' });
    expect(await findWorkspaceMember(other.id, u!.email)).toBeNull();
  });
});

describe('revokeInvite', () => {
  it('revokes a pending invite: the link stops working, the list drops it, audited with the role only', async () => {
    const admin = await user('admin');
    const ws = await team({ [admin]: 'workspace-admin' });
    const { token, id } = await createInvite({ workspaceId: ws.id, role: 'editor', invitedByUserId: admin, email: 'new@example.com' });

    const revoked = await revokeInvite({ workspaceId: ws.id, inviteId: id, actor: { userId: admin, kind: 'user' } });
    expect(revoked).toMatchObject({ id, role: 'editor', email: 'new@example.com' });
    expect(await consumeInvite(token)).toBeNull();
    expect(await listPendingInvites(ws.id)).toEqual([]);
    expect((await audit(ws.id)).at(-1)).toEqual({ action: 'member.invite_revoke', actorUserId: admin, actorKind: 'user', target: null, meta: { role: 'editor' } });

    expect(await revokeInvite({ workspaceId: ws.id, inviteId: id, actor: { userId: admin, kind: 'user' } })).toBeNull();
    expect(await revokeInvite({ workspaceId: ws.id, inviteId: 'not-an-id', actor: { userId: admin, kind: 'user' } })).toBeNull();
  });

  it('never revokes another workspace\'s invite', async () => {
    const admin = await user('admin');
    const mine = await team({ [admin]: 'workspace-admin' });
    const theirs = await team({});
    const { token, id } = await createInvite({ workspaceId: theirs.id, role: 'viewer', invitedByUserId: admin });
    expect(await revokeInvite({ workspaceId: mine.id, inviteId: id, actor: { userId: admin, kind: 'user' } })).toBeNull();
    expect(await consumeInvite(token)).toMatchObject({ workspaceId: theirs.id });
  });
});
