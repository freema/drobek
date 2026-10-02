/**
 * Deleting a workspace and deleting an account, on PGlite with the core
 * migrations and every module migration in the repository: the foreign keys
 * to users and workspaces let both deletions through (read from the
 * catalogue, so a table added later is checked too), a deleted workspace
 * leaves no row of its own behind but its audit trail, and a deleted account
 * leaves the shared workspaces' history with a null author.
 */
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetDisk, createApp, createVersion, softDeleteApp, type Lease } from '@drobek/apps';
import {
  apiKeys,
  appVersions,
  apps,
  auditLog,
  memberships,
  oauthAccessTokens,
  oauthClients,
  oauthRefreshTokens,
  setDbForTests,
  upstreams,
  users,
  workspaceModules,
  workspaces,
} from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { TenancyFakeRedis } from './fake-redis.js';

let fake: TenancyFakeRedis;

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  return {
    ...actual,
    getRedis: () => fake as unknown as ReturnType<typeof actual.getRedis>,
  };
});

const sentCodes: { email: string; code: string }[] = [];
vi.mock('./email/account-delete-code.server.js', () => ({
  sendAccountDeleteCodeEmail: async (args: { email: string; code: string }) => {
    sentCodes.push(args);
  },
}));

import { createEmailLoginCode, createUserSession, getSessionUser } from '@drobek/auth';
import { ACCOUNT_DELETE_OTP_SCOPE, checkAccountDeleteCode, sendAccountDeleteCode } from './account-code.server.js';
import {
  DeletionError,
  accountDeletionPlan,
  assertWorkspaceDeletable,
  deleteAccount,
  deleteWorkspace,
  workspaceDeletionSummary,
  type AppDeletionHooks,
} from './deletion.server.js';
import { createInvite, getInvite, listPendingInvites } from './invites.server.js';
import { resolveWorkspaceAccess } from './membership.server.js';
import { changeMemberRole } from './members.server.js';
import type { WorkspaceRole } from './roles.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function moduleMigrationFolders(): [string, string][] {
  const out: [string, string][] = [];
  for (const parent of ['modules', 'examples']) {
    for (const d of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      const folder = join(ROOT, parent, d.name, 'migrations');
      if (d.isDirectory() && existsSync(join(folder, 'meta/_journal.json'))) out.push([d.name, folder]);
    }
  }
  return out;
}

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let disk: AssetDisk;

beforeAll(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: join(ROOT, 'packages/db/drizzle/migrations'),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  for (const [name, folder] of moduleMigrationFolders()) {
    await migrate(db, { migrationsFolder: folder, migrationsTable: `__drizzle_migrations_mod_${name}`, migrationsSchema: 'drizzle' });
  }
  setDbForTests(db);
  disk = new AssetDisk(mkdtempSync(join(tmpdir(), 'drobek-deletion-assets-')));
});

afterAll(async () => {
  setDbForTests(null);
  await pg.close();
});

beforeEach(() => {
  fake = new TenancyFakeRedis();
  sentCodes.length = 0;
});

let n = 0;

async function user(tag: string): Promise<{ id: string; email: string }> {
  n += 1;
  const email = `${tag}-${n}@example.test`;
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  return { id: u!.id, email };
}

async function workspace(kind: 'personal' | 'team', members: Record<string, WorkspaceRole>) {
  n += 1;
  const slug = `${kind}-ws-${n}`;
  const [w] = await db.insert(workspaces).values({ kind, slug, name: `${kind} ${n}` }).returning({ id: workspaces.id });
  for (const [userId, role] of Object.entries(members)) {
    await db.insert(memberships).values({ userId, workspaceId: w!.id, role });
  }
  return { id: w!.id, slug, kind };
}

async function app(workspaceId: string, authorId: string) {
  n += 1;
  const created = await createApp({ workspaceId, slug: `del-app-${n}`, actor: { userId: authorId, kind: 'agent' } });
  await createVersion(created.id, [{ path: 'index.html', content: `<p>${n}</p>` }], { actor: { userId: authorId, kind: 'agent' } });
  return created;
}

async function auditOf(workspaceId: string) {
  return db
    .select({ action: auditLog.action, actorUserId: auditLog.actorUserId, target: auditLog.target, meta: auditLog.meta })
    .from(auditLog)
    .where(eq(auditLog.workspaceId, workspaceId))
    .orderBy(auditLog.createdAt, auditLog.id);
}

async function rows(table: string, column: string, value: string): Promise<number> {
  const res = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, [value]);
  return res.rows[0]!.n;
}

function recordingHooks() {
  const deleted: string[] = [];
  const purged: string[] = [];
  const hooks: AppDeletionHooks = {
    onAppDelete: async (a) => {
      deleted.push(a.slug);
    },
    afterPurge: async (ids) => {
      purged.push(...ids);
    },
  };
  return { hooks, deleted, purged };
}

async function deletionError(p: Promise<unknown>): Promise<DeletionError> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DeletionError);
  return err as DeletionError;
}

describe('the foreign keys a deletion follows', () => {
  async function foreignKeys(referenced: string) {
    const res = await pg.query<{ tbl: string; col: string; on_delete: string }>(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col, c.confdeltype::text AS on_delete
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.confrelid = $1::regclass
        ORDER BY 1, 2`,
      [referenced]
    );
    return res.rows;
  }

  it('every reference to an account cascades or is set to null', async () => {
    const fks = await foreignKeys('public.users');
    expect(fks.length).toBeGreaterThan(0);
    for (const fk of fks) expect(['c', 'n'], `${fk.tbl}.${fk.col}`).toContain(fk.on_delete);
    const authored = Object.fromEntries(fks.map((fk) => [`${fk.tbl}.${fk.col}`, fk.on_delete]));
    expect(authored).toMatchObject({
      'app_versions.created_by_user_id': 'n',
      'audit_log.actor_user_id': 'n',
      'upstreams.created_by': 'n',
      'memberships.user_id': 'c',
      'api_keys.user_id': 'c',
      'oauth_access_tokens.user_id': 'c',
      'oauth_refresh_tokens.user_id': 'c',
    });
  });

  it('every reference to a workspace cascades, except its apps (purged first); the audit trail has no foreign key', async () => {
    const fks = await foreignKeys('public.workspaces');
    for (const fk of fks) {
      const where = `${fk.tbl}.${fk.col}`;
      if (where === 'apps.workspace_id') expect(fk.on_delete, where).toBe('a');
      else expect(fk.on_delete, where).toBe('c');
    }
    expect(fks.map((fk) => `${fk.tbl}.${fk.col}`)).not.toContain('audit_log.workspace_id');
  });
});

describe('deleteWorkspace', () => {
  it('refuses a personal workspace and anyone below workspace-admin, changing nothing', async () => {
    const owner = await user('owner');
    const personal = await workspace('personal', { [owner.id]: 'workspace-admin' });
    const err = await deletionError(
      deleteWorkspace({ workspace: personal, actor: { userId: owner.id, kind: 'user', role: 'workspace-admin' }, disk })
    );
    expect(err.code).toBe('personal_workspace');
    expect(err.message).toContain('only together with its owner’s account');

    const ed = await user('ed');
    const team = await workspace('team', { [owner.id]: 'workspace-admin', [ed.id]: 'editor' });
    expect((await deletionError(deleteWorkspace({ workspace: team, actor: { userId: ed.id, kind: 'agent', role: 'editor' }, disk }))).code).toBe(
      'forbidden'
    );
    expect(() => assertWorkspaceDeletable({ workspace: team, actor: { role: 'viewer' } })).toThrow(DeletionError);
    expect(() => assertWorkspaceDeletable({ workspace: team, actor: { role: 'workspace-admin' } })).not.toThrow();
    expect(await rows('workspaces', 'id', team.id)).toBe(1);
    expect(await rows('workspaces', 'id', personal.id)).toBe(1);
  });

  it('deletes a team with its apps (purged), members, invites, upstreams and module opt-ins; the audit trail stays', async () => {
    const admin = await user('admin');
    const member = await user('member');
    const adminHome = await workspace('personal', { [admin.id]: 'workspace-admin' });
    const team = await workspace('team', { [admin.id]: 'workspace-admin', [member.id]: 'editor' });
    const live = await app(team.id, member.id);
    const other = await app(team.id, admin.id);
    const gone = await app(team.id, admin.id);
    await softDeleteApp(gone.id, { userId: admin.id, kind: 'user' });
    const elsewhere = await app(adminHome.id, admin.id);
    const [up] = await db
      .insert(upstreams)
      .values({ workspaceId: team.id, name: 'crm', baseUrl: 'https://crm.example.com', allowedMethods: ['GET'], allowedPathPrefixes: ['/'], createdBy: admin.id })
      .returning({ id: upstreams.id });
    await db.insert(workspaceModules).values({ workspaceId: team.id, module: 'sync', enabledBy: admin.id });
    const invite = await createInvite({ workspaceId: team.id, role: 'viewer', invitedByUserId: admin.id, email: 'later@example.test' });

    expect(await workspaceDeletionSummary(team.id)).toEqual({ apps: 2, published: 0, members: 2, pendingInvites: 1, upstreams: 1 });

    const { hooks, deleted, purged } = recordingHooks();
    const out = await deleteWorkspace({ workspace: team, actor: { userId: admin.id, kind: 'user', role: 'workspace-admin' }, hooks, disk });
    expect(out).toMatchObject({ slug: team.slug, members: 2 });
    expect([...out.apps].sort()).toEqual([live.slug, other.slug].sort());
    expect([...deleted].sort()).toEqual([live.slug, other.slug].sort());
    expect([...purged].sort()).toEqual([live.id, other.id, gone.id].sort());

    for (const [table, column] of [
      ['workspaces', 'id'],
      ['apps', 'workspace_id'],
      ['memberships', 'workspace_id'],
      ['upstreams', 'workspace_id'],
      ['workspace_modules', 'workspace_id'],
    ] as const) {
      expect(await rows(table, column, team.id), `${table}.${column}`).toBe(0);
    }
    expect(await rows('upstream_secrets', 'upstream_id', up!.id)).toBe(0);
    expect(await rows('app_versions', 'app_id', live.id)).toBe(0);
    expect(await rows('apps', 'id', elsewhere.id)).toBe(1);
    expect(await getInvite(invite.token)).toBeNull();
    expect(await listPendingInvites(team.id)).toEqual([]);
    expect(await resolveWorkspaceAccess({ userId: member.id, superAdmin: false, workspaceSlug: team.slug })).toBeNull();

    const trail = await auditOf(team.id);
    const tally = (action: string) => trail.filter((a) => a.action === action).length;
    expect([tally('app.create'), tally('app.version.write'), tally('app.delete'), tally('app.purge')]).toEqual([3, 3, 3, 3]);
    expect(trail.filter((a) => a.action === 'workspace.delete')).toEqual([
      { action: 'workspace.delete', actorUserId: admin.id, target: team.slug, meta: { apps: 2, members: 2 } },
    ]);
    expect((await auditOf(adminHome.id)).filter((a) => a.action === 'workspace.delete')).toEqual([
      { action: 'workspace.delete', actorUserId: admin.id, target: team.slug, meta: { apps: 2, members: 2 } },
    ]);
  });

  it('an app created while the apps are purged is deleted too', async () => {
    const admin = await user('racer');
    const team = await workspace('team', { [admin.id]: 'workspace-admin' });
    await app(team.id, admin.id);
    let late: string | null = null;
    const hooks: AppDeletionHooks = {
      afterPurge: async () => {
        if (late === null) late = (await app(team.id, admin.id)).id;
      },
    };
    const out = await deleteWorkspace({ workspace: team, actor: { userId: admin.id, kind: 'agent', role: 'workspace-admin' }, hooks, disk });
    expect(out.apps).toHaveLength(2);
    expect(late).not.toBeNull();
    expect(await rows('apps', 'id', late!)).toBe(0);
    expect(await rows('workspaces', 'id', team.id)).toBe(0);
  });
});

describe('deleteAccount', () => {
  it('is refused while the user is the only workspace-admin of a team with other members; nothing changes', async () => {
    const owner = await user('sole');
    const helper = await user('helper');
    const personal = await workspace('personal', { [owner.id]: 'workspace-admin' });
    const team = await workspace('team', { [owner.id]: 'workspace-admin', [helper.id]: 'editor' });

    const plan = await accountDeletionPlan(owner.id);
    expect(plan.blockers.map((w) => w.slug)).toEqual([team.slug]);
    expect(plan.deletes.map((w) => w.slug)).toEqual([personal.slug]);

    const err = await deletionError(deleteAccount({ userId: owner.id, disk }));
    expect(err.code).toBe('sole_workspace_admin');
    expect(err.message).toContain('Make one of them a workspace-admin');
    expect(err.message).toContain('or delete the workspace');
    expect(err.blockers).toEqual([{ slug: team.slug, name: expect.any(String), members: 2 }]);
    expect(await rows('users', 'id', owner.id)).toBe(1);
    expect(await rows('workspaces', 'id', personal.id)).toBe(1);

    // Handing the role over lifts the block; the team stays with the helper.
    await changeMemberRole({ workspace: team, userId: helper.id, role: 'workspace-admin', actor: { userId: owner.id, kind: 'user', role: 'workspace-admin' } });
    expect((await accountDeletionPlan(owner.id)).blockers).toEqual([]);
    await deleteAccount({ userId: owner.id, disk });
    expect(await rows('workspaces', 'id', team.id)).toBe(1);
    expect(await rows('memberships', 'workspace_id', team.id)).toBe(1);
  });

  it('deletes the personal workspace and the teams nobody else uses, leaves the others, revokes access; history keeps a null author', async () => {
    const leaver = await user('leaver');
    const admin = await user('teamadmin');
    const personal = await workspace('personal', { [leaver.id]: 'workspace-admin' });
    const solo = await workspace('team', { [leaver.id]: 'workspace-admin' });
    const shared = await workspace('team', { [admin.id]: 'workspace-admin', [leaver.id]: 'editor' });
    const coAdmin = await workspace('team', { [admin.id]: 'workspace-admin', [leaver.id]: 'workspace-admin' });
    const mine = await app(personal.id, leaver.id);
    const soloApp = await app(solo.id, leaver.id);
    const sharedApp = await app(shared.id, leaver.id);
    await db.insert(upstreams).values({
      workspaceId: shared.id,
      name: 'feed',
      baseUrl: 'https://feed.example.com',
      allowedMethods: ['GET'],
      allowedPathPrefixes: ['/'],
      createdBy: leaver.id,
    });

    await db.insert(apiKeys).values({ userId: leaver.id, name: 'ci', keyHash: `kh-${n}`, scopes: 'read' });
    const [client] = await db
      .insert(oauthClients)
      .values({ clientId: `client-${n}`, clientName: 'Agent', redirectUris: ['http://127.0.0.1/cb'] })
      .returning({ id: oauthClients.id });
    const expires = new Date(Date.now() + 3600_000);
    const [next] = await db
      .insert(oauthRefreshTokens)
      .values({ tokenHash: `rt2-${n}`, userId: leaver.id, oauthClientId: client!.id, scope: 'read', audience: 'x', expiresAt: expires })
      .returning({ id: oauthRefreshTokens.id });
    await db.insert(oauthRefreshTokens).values({
      tokenHash: `rt1-${n}`,
      userId: leaver.id,
      oauthClientId: client!.id,
      scope: 'read',
      audience: 'x',
      rotatedTo: next!.id,
      usedAt: new Date(),
      expiresAt: expires,
    });
    await db.insert(oauthAccessTokens).values({ tokenHash: `at-${n}`, userId: leaver.id, oauthClientId: client!.id, scope: 'read', audience: 'x', expiresAt: expires });
    const session = await createUserSession(leaver.id, leaver.email);
    const otherSession = await createUserSession(admin.id, admin.email);

    const plan = await accountDeletionPlan(leaver.id);
    expect(plan.deletes.map((w) => [w.slug, w.apps])).toEqual([
      [personal.slug, 1],
      [solo.slug, 1],
    ]);
    expect(plan.leaves.map((w) => [w.slug, w.role])).toEqual([
      [shared.slug, 'editor'],
      [coAdmin.slug, 'workspace-admin'],
    ]);
    expect(plan.blockers).toEqual([]);

    const held = new Map([[sharedApp.id, leaver.id]]);
    const takeLease = async (appId: string, holder: string): Promise<Lease | null> => {
      if (held.get(appId) !== holder) return null;
      held.delete(appId);
      return { holder_user_id: holder, session_id: 's', expires_at: '2026-10-02T10:00:00.000Z' };
    };
    const { hooks, deleted, purged } = recordingHooks();
    const out = await deleteAccount({ userId: leaver.id, hooks, takeLease, disk });

    expect(out.deleted.map((d) => [d.slug, d.apps])).toEqual([
      [personal.slug, [mine.slug]],
      [solo.slug, [soloApp.slug]],
    ]);
    expect(out.left).toEqual([shared.slug, coAdmin.slug]);
    expect(out.sessions).toBe(1);
    expect(deleted).toEqual([mine.slug, soloApp.slug]);
    expect([...purged].sort()).toEqual([mine.id, soloApp.id].sort());
    expect(held.size).toBe(0);

    // The account and everything that only it used is gone.
    expect(await rows('users', 'id', leaver.id)).toBe(0);
    for (const ws of [personal, solo]) expect(await rows('workspaces', 'id', ws.id)).toBe(0);
    for (const table of ['memberships', 'api_keys', 'oauth_access_tokens', 'oauth_refresh_tokens', 'gallery_likes']) {
      expect(await rows(table, 'user_id', leaver.id), table).toBe(0);
    }
    expect(await getSessionUser(new Request('http://localhost/me', { headers: { Cookie: `drobek_session=${session.token}` } }))).toBeNull();
    expect(await getSessionUser(new Request('http://localhost/me', { headers: { Cookie: `drobek_session=${otherSession.token}` } }))).toMatchObject({
      id: admin.id,
    });

    // The shared workspaces keep their apps, versions, upstream and audit rows — the author is null now.
    expect(await rows('apps', 'id', sharedApp.id)).toBe(1);
    const [version] = await db.select({ by: appVersions.createdByUserId }).from(appVersions).where(eq(appVersions.appId, sharedApp.id));
    expect(version).toEqual({ by: null });
    const [feed] = await db.select({ by: upstreams.createdBy }).from(upstreams).where(eq(upstreams.workspaceId, shared.id));
    expect(feed).toEqual({ by: null });
    const sharedTrail = await auditOf(shared.id);
    expect(sharedTrail.map((a) => a.action).sort()).toEqual(['app.create', 'app.lock.release', 'app.version.write', 'member.leave']);
    expect(sharedTrail.every((a) => a.actorUserId === null)).toBe(true);
    expect(sharedTrail.find((a) => a.action === 'member.leave')).toMatchObject({
      target: leaver.id,
      meta: { role: 'editor', reason: 'account_deleted' },
    });
    expect((await auditOf(coAdmin.id)).map((a) => [a.action, a.meta])).toEqual([
      ['member.leave', { role: 'workspace-admin', reason: 'account_deleted' }],
    ]);
    expect(await rows('memberships', 'workspace_id', coAdmin.id)).toBe(1);

    // The personal workspace's trail ends with the workspace and account deletion; no e-mail-derived slug is kept.
    const personalTrail = await auditOf(personal.id);
    expect(personalTrail.filter((a) => a.action === 'workspace.delete' || a.action === 'account.delete')).toEqual([
      { action: 'workspace.delete', actorUserId: null, target: null, meta: { apps: 1, members: 1, with_account: true } },
      { action: 'account.delete', actorUserId: null, target: leaver.id, meta: { workspaces_deleted: 2, workspaces_left: 2 } },
    ]);
    expect((await auditOf(solo.id)).filter((a) => a.action === 'workspace.delete')).toEqual([
      { action: 'workspace.delete', actorUserId: null, target: solo.slug, meta: { apps: 1, members: 1, with_account: true } },
    ]);
    const anyUserRef = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.actorUserId, leaver.id));
    expect(anyUserRef).toEqual([]);
  });

  it('a personal workspace created again during the deletion goes with the account when it is empty', async () => {
    const racer = await user('again');
    const home = await workspace('personal', { [racer.id]: 'workspace-admin' });
    const first = await app(home.id, racer.id);
    let recreated: string | null = null;
    const hooks: AppDeletionHooks = {
      afterPurge: async () => {
        if (recreated === null) recreated = (await workspace('personal', { [racer.id]: 'workspace-admin' })).id;
      },
    };
    const out = await deleteAccount({ userId: racer.id, hooks, disk });
    expect(out.deleted.map((d) => d.apps)).toEqual([[first.slug], []]);
    expect(await rows('workspaces', 'id', recreated!)).toBe(0);
    expect(await rows('users', 'id', racer.id)).toBe(0);
  });

  it('a user without any workspace is deleted too', async () => {
    const lone = await user('lone');
    const out = await deleteAccount({ userId: lone.id, disk });
    expect(out).toEqual({ deleted: [], left: [], sessions: 0 });
    expect(await rows('users', 'id', lone.id)).toBe(0);
  });
});

describe('the account deletion code', () => {
  it('is its own scope: a deletion code confirms once, a sign-in code never does', async () => {
    const email = 'code@example.test';
    expect(await sendAccountDeleteCode({ email, ip: undefined })).toEqual({ ok: true, sent: true });
    expect(sentCodes).toHaveLength(1);
    const code = sentCodes[0]!.code;
    expect(code).toMatch(/^\d{6}$/);

    // A second request within the cooldown sends nothing new; the first code stays valid.
    expect(await sendAccountDeleteCode({ email, ip: undefined })).toEqual({ ok: true, sent: false });
    expect(sentCodes).toHaveLength(1);

    const login = await createEmailLoginCode(email, undefined);
    expect(await checkAccountDeleteCode({ email, code: login === code ? '000000' : login, ip: undefined })).toBe(false);
    expect(await checkAccountDeleteCode({ email, code: 'abc', ip: undefined })).toBe(false);
    expect(await checkAccountDeleteCode({ email, code: ` ${code} `, ip: undefined })).toBe(true);
    expect(await checkAccountDeleteCode({ email, code, ip: undefined })).toBe(false);
    expect([...fake.store.keys()].some((k) => k.startsWith(`drobek:otp:${ACCOUNT_DELETE_OTP_SCOPE}:`))).toBe(true);
  });
});

describe('workspaceDeletionSummary', () => {
  it('counts published apps, and leaves deleted apps out', async () => {
    const owner = await user('sum');
    const team = await workspace('team', { [owner.id]: 'workspace-admin' });
    const a = await app(team.id, owner.id);
    const b = await app(team.id, owner.id);
    await softDeleteApp(b.id, { userId: owner.id, kind: 'user' });
    const [v] = await db.select({ id: appVersions.id }).from(appVersions).where(eq(appVersions.appId, a.id));
    await db.update(apps).set({ publishedVersionId: v!.id }).where(eq(apps.id, a.id));
    expect(await workspaceDeletionSummary(team.id)).toEqual({ apps: 1, published: 1, members: 1, pendingInvites: 0, upstreams: 0 });
  });
});
