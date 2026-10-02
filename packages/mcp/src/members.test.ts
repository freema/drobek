/**
 * The member tools over a real MCP client on a real (PGlite) database: they
 * do what the dashboard's Members tab does, through the same @drobek/tenancy
 * operations — list for any member, change a role and remove for a
 * workspace admin, leave for anyone, remove only with the user's explicit
 * yes, never the last admin or a personal workspace, the removed member out
 * at once (not_found) with their leases released, and the audit rows
 * attributed to the agent.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, memberships, users, workspaces } from '@drobek/db';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
const P = {} as Record<'alice' | 'ed' | 'vic' | 'eve' | 'boss', ToolPrincipal>;
let deps: TestDeps;
let eveWorkspace: string;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  for (const k of ['alice', 'ed', 'vic', 'eve', 'boss'] as const) {
    const [u] = await db.insert(users).values({ email: `${k}@example.test` }).returning();
    P[k] = { userId: u!.id, email: `${k}@example.test`, superAdmin: k === 'boss' };
  }
  const [personal] = await db.insert(workspaces).values({ kind: 'personal', slug: 'eve-m', name: 'Eve' }).returning();
  eveWorkspace = personal!.slug;
  await db.insert(memberships).values({ userId: P.eve.userId, workspaceId: personal!.id, role: 'workspace-admin' });
});
afterAll(async () => close());
beforeEach(() => {
  deps = testDeps();
});

let n = 0;

/** A fresh team workspace: alice admin, ed editor, vic viewer. */
async function team(): Promise<{ id: string; slug: string }> {
  n += 1;
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: `team-m${n}`, name: `Members ${n}` }).returning();
  await db.insert(memberships).values([
    { userId: P.alice.userId, workspaceId: w!.id, role: 'workspace-admin' },
    { userId: P.ed.userId, workspaceId: w!.id, role: 'editor' },
    { userId: P.vic.userId, workspaceId: w!.id, role: 'viewer' },
  ]);
  return { id: w!.id, slug: w!.slug };
}

type Conn = Awaited<ReturnType<typeof connect>>;

async function as<T>(who: keyof typeof P, fn: (c: Conn) => Promise<T>): Promise<T> {
  const c = await connect(P[who], deps);
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}

function errorOf(r: { isError: boolean; text: string }): Record<string, unknown> {
  expect(r.isError, r.text).toBe(true);
  return JSON.parse(r.text) as Record<string, unknown>;
}

async function roleOf(workspaceId: string, who: keyof typeof P): Promise<string | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, P[who].userId)));
  return row?.role ?? null;
}

describe('list_members', () => {
  it('any member lists the members with their roles; a non-member gets not_found', async () => {
    const ws = await team();
    const out = await as('vic', (c) => c.call('list_members', { workspace: ws.slug }));
    expect(out.isError, out.text).toBe(false);
    expect(out.body).toEqual({
      workspace: ws.slug,
      kind: 'team',
      role: 'viewer',
      members: [
        { email: 'alice@example.test', role: 'workspace-admin', you: false },
        { email: 'ed@example.test', role: 'editor', you: false },
        { email: 'vic@example.test', role: 'viewer', you: true },
      ],
      can_manage: false,
      members_url: `http://localhost:3041/workspaces/${ws.slug}`,
    });
    expect((await as('alice', (c) => c.call('list_members', { workspace: ws.slug }))).body).toMatchObject({ can_manage: true });
    expect(errorOf(await as('eve', (c) => c.call('list_members', { workspace: ws.slug })))).toMatchObject({ code: 'not_found' });
  });
});

describe('set_member_role', () => {
  it('a workspace admin changes a role (audited as the agent); the same role again changes nothing', async () => {
    const ws = await team();
    const out = await as('alice', (c) => c.call('set_member_role', { workspace: ws.slug, email: 'VIC@example.test', role: 'editor' }));
    expect(out.body).toEqual({ workspace: ws.slug, email: 'vic@example.test', from: 'viewer', to: 'editor', changed: true, released_locks: [] });
    expect(await roleOf(ws.id, 'vic')).toBe('editor');
    const again = await as('alice', (c) => c.call('set_member_role', { workspace: ws.slug, email: 'vic@example.test', role: 'editor' }));
    expect(again.body).toMatchObject({ changed: false });
    const rows = await db
      .select({ action: auditLog.action, actorKind: auditLog.actorKind, actorUserId: auditLog.actorUserId, target: auditLog.target, meta: auditLog.meta })
      .from(auditLog)
      .where(eq(auditLog.workspaceId, ws.id));
    expect(rows).toEqual([{ action: 'member.role_change', actorKind: 'agent', actorUserId: P.alice.userId, target: P.vic.userId, meta: { from: 'viewer', to: 'editor' } }]);
  });

  it('an editor is forbidden; an unknown member is not_found; the only admin cannot be demoted', async () => {
    const ws = await team();
    expect(errorOf(await as('ed', (c) => c.call('set_member_role', { workspace: ws.slug, email: 'vic@example.test', role: 'editor' })))).toMatchObject({
      code: 'forbidden',
    });
    expect(errorOf(await as('alice', (c) => c.call('set_member_role', { workspace: ws.slug, email: 'eve@example.test', role: 'editor' })))).toMatchObject({
      code: 'not_found',
    });
    const last = errorOf(await as('alice', (c) => c.call('set_member_role', { workspace: ws.slug, email: 'alice@example.test', role: 'editor' })));
    expect(last).toMatchObject({ code: 'last_workspace_admin' });
    expect(String(last.hint)).toMatch(/Make another member a workspace-admin first/);
    expect((await as('alice', (c) => c.call('set_member_role', { workspace: ws.slug, email: 'vic@example.test', role: 'owner' }))).isError).toBe(true);
    expect(await roleOf(ws.id, 'alice')).toBe('workspace-admin');
  });

  it('a member demoted to viewer loses their edit lock at once; a super-admin acts as an admin', async () => {
    const ws = await team();
    const app = (await as('alice', (c) => c.call('create_app', { name: 'Locked', workspace: ws.slug }))).body as { app_id: string; slug: string };
    await deps.leases.acquire(app.app_id, { userId: P.ed.userId, sessionId: 'ed-session' }, 180_000);
    const blocked = errorOf(await as('alice', (c) => c.call('write_files', { app_id: app.app_id, files: [{ path: 'a.txt', content: 'x' }], reasoning: 'r' })));
    expect(blocked.code).toBe('app_locked');

    const out = await as('boss', (c) => c.call('set_member_role', { workspace: ws.slug, email: 'ed@example.test', role: 'viewer' }));
    expect(out.body).toMatchObject({ from: 'editor', to: 'viewer', released_locks: [app.slug] });
    expect((await deps.leases.get([app.app_id])).size).toBe(0);
    const write = await as('alice', (c) => c.call('write_files', { app_id: app.app_id, files: [{ path: 'a.txt', content: 'x' }], reasoning: 'r' }));
    expect(write.isError, write.text).toBe(false);
  });

  it('a personal workspace answers personal_workspace', async () => {
    expect(errorOf(await as('eve', (c) => c.call('set_member_role', { workspace: eveWorkspace, email: 'eve@example.test', role: 'editor' })))).toMatchObject({
      code: 'personal_workspace',
    });
  });
});

describe('remove_member', () => {
  it('asks for user_confirmed, then removes: the member is out at once (not_found), their lock released, audited as the agent', async () => {
    const ws = await team();
    const app = (await as('alice', (c) => c.call('create_app', { name: 'Shared', workspace: ws.slug }))).body as { app_id: string; slug: string };
    await deps.leases.acquire(app.app_id, { userId: P.ed.userId, sessionId: 'ed-session' }, 180_000);
    expect((await as('ed', (c) => c.call('get_app', { app_id: app.app_id }))).isError).toBe(false);

    const ask = errorOf(await as('alice', (c) => c.call('remove_member', { workspace: ws.slug, email: 'ed@example.test' })));
    expect(ask).toMatchObject({ code: 'user_confirmation_required', workspace: ws.slug, email: 'ed@example.test', role: 'editor', leaving: false });
    expect(await roleOf(ws.id, 'ed')).toBe('editor');

    const out = await as('alice', (c) => c.call('remove_member', { workspace: ws.slug, email: 'ed@example.test', user_confirmed: true }));
    expect(out.body).toMatchObject({ workspace: ws.slug, removed: 'ed@example.test', role: 'editor', left: false, released_locks: [app.slug] });
    expect(await roleOf(ws.id, 'ed')).toBeNull();

    expect(errorOf(await as('ed', (c) => c.call('get_app', { app_id: app.app_id })))).toMatchObject({ code: 'not_found' });
    expect(errorOf(await as('ed', (c) => c.call('list_members', { workspace: ws.slug })))).toMatchObject({ code: 'not_found' });
    const listed = (await as('ed', (c) => c.call('list_apps', {}))).body as { workspaces: { slug: string }[]; apps: { app_id: string }[] };
    expect(listed.workspaces.map((w) => w.slug)).not.toContain(ws.slug);
    expect(listed.apps.map((a) => a.app_id)).not.toContain(app.app_id);

    const [row] = await db
      .select({ actorKind: auditLog.actorKind, actorUserId: auditLog.actorUserId, meta: auditLog.meta })
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, 'member.remove')));
    expect(row).toEqual({ actorKind: 'agent', actorUserId: P.alice.userId, meta: { role: 'editor' } });

    expect(errorOf(await as('alice', (c) => c.call('remove_member', { workspace: ws.slug, email: 'ed@example.test', user_confirmed: true })))).toMatchObject({
      code: 'not_found',
    });
  });

  it('any member leaves with their own e-mail; an editor cannot remove someone else', async () => {
    const ws = await team();
    const refused = errorOf(await as('ed', (c) => c.call('remove_member', { workspace: ws.slug, email: 'vic@example.test', user_confirmed: true })));
    expect(refused).toMatchObject({ code: 'forbidden' });
    expect(String(refused.message)).toMatch(/pass your own e-mail/);

    const ask = errorOf(await as('vic', (c) => c.call('remove_member', { workspace: ws.slug, email: 'vic@example.test' })));
    expect(ask).toMatchObject({ code: 'user_confirmation_required', leaving: true });
    const out = await as('vic', (c) => c.call('remove_member', { workspace: ws.slug, email: 'vic@example.test', user_confirmed: true }));
    expect(out.body).toMatchObject({ removed: 'vic@example.test', role: 'viewer', left: true });
    expect(await roleOf(ws.id, 'vic')).toBeNull();
    const [row] = await db.select({ action: auditLog.action }).from(auditLog).where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.target, P.vic.userId)));
    expect(row).toEqual({ action: 'member.leave' });
  });

  it('refuses before asking: the only admin leaving, and a personal workspace', async () => {
    const ws = await team();
    expect(errorOf(await as('alice', (c) => c.call('remove_member', { workspace: ws.slug, email: 'alice@example.test' })))).toMatchObject({
      code: 'last_workspace_admin',
    });
    expect(errorOf(await as('eve', (c) => c.call('remove_member', { workspace: eveWorkspace, email: 'eve@example.test' })))).toMatchObject({
      code: 'personal_workspace',
    });
    expect(await roleOf(ws.id, 'alice')).toBe('workspace-admin');
  });
});
