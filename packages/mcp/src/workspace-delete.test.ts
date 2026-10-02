/**
 * delete_workspace over a real MCP client on a real (PGlite) database: a
 * workspace admin deletes a team workspace only with the user's explicit yes
 * (the first answer lists what would go and changes nothing), every app goes
 * with it and is announced as deleted, the members are out at once, the
 * audit row names the agent, and a personal workspace or a non-admin is
 * refused.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@drobek/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@drobek/core')>();
  const redis = {
    hgetall: async () => ({}),
    del: async (...keys: string[]) => keys.length * 0,
    scan: async (): Promise<[string, string[]]> => ['0', []],
  };
  return { ...actual, getRedis: () => redis as unknown as ReturnType<typeof actual.getRedis> };
});

import { apps, auditLog, memberships, upstreams, users, workspaces } from '@drobek/db';
import type { ToolPrincipal } from './context.js';
import { freshDb, type TestDb } from './test/db.js';
import { connect, testDeps, type TestDeps } from './test/harness.js';

let db: TestDb;
let close: () => Promise<void>;
const P = {} as Record<'alice' | 'ed' | 'eve', ToolPrincipal>;
let deps: TestDeps;
let alicePersonal: { id: string; slug: string };

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  for (const k of ['alice', 'ed', 'eve'] as const) {
    const [u] = await db.insert(users).values({ email: `${k}@example.test` }).returning();
    P[k] = { userId: u!.id, email: `${k}@example.test`, superAdmin: false };
  }
  const [personal] = await db.insert(workspaces).values({ kind: 'personal', slug: 'alice-d', name: 'Alice' }).returning();
  alicePersonal = { id: personal!.id, slug: personal!.slug };
  await db.insert(memberships).values({ userId: P.alice.userId, workspaceId: personal!.id, role: 'workspace-admin' });
});
afterAll(async () => close());
beforeEach(() => {
  deps = testDeps();
});

let n = 0;

async function team(): Promise<{ id: string; slug: string }> {
  n += 1;
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: `team-d${n}`, name: `Delete ${n}` }).returning();
  await db.insert(memberships).values([
    { userId: P.alice.userId, workspaceId: w!.id, role: 'workspace-admin' },
    { userId: P.ed.userId, workspaceId: w!.id, role: 'editor' },
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

describe('delete_workspace', () => {
  it('asks for user_confirmed with what would go, then deletes the workspace with its apps, audited as the agent', async () => {
    const ws = await team();
    const one = (await as('alice', (c) => c.call('create_app', { name: 'One', workspace: ws.slug }))).body as { app_id: string; slug: string };
    const two = (await as('ed', (c) => c.call('create_app', { name: 'Two', workspace: ws.slug }))).body as { app_id: string; slug: string };
    await db.insert(upstreams).values({
      workspaceId: ws.id,
      name: 'crm',
      baseUrl: 'https://crm.example.test',
      allowedMethods: ['GET'],
      allowedPathPrefixes: ['/'],
      createdBy: P.alice.userId,
    });

    const ask = errorOf(await as('alice', (c) => c.call('delete_workspace', { workspace: ws.slug })));
    expect(ask).toMatchObject({
      code: 'user_confirmation_required',
      workspace: ws.slug,
      apps: 2,
      published: 0,
      members: 2,
      pending_invites: 0,
      upstreams: 1,
    });
    expect(String(ask.message)).toMatch(/cannot be undone/);
    expect(await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(1);

    deps.events.length = 0;
    const out = await as('alice', (c) => c.call('delete_workspace', { workspace: ws.slug, user_confirmed: true }));
    expect(out.isError, out.text).toBe(false);
    expect(out.body).toMatchObject({ deleted: ws.slug, members: 2 });
    expect([...(out.body.apps as string[])].sort()).toEqual([one.slug, two.slug].sort());

    expect(await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, ws.id))).toEqual([]);
    expect(await db.select({ id: apps.id }).from(apps).where(eq(apps.workspaceId, ws.id))).toEqual([]);
    expect(await db.select({ id: memberships.userId }).from(memberships).where(eq(memberships.workspaceId, ws.id))).toEqual([]);
    expect(await db.select({ id: upstreams.id }).from(upstreams).where(eq(upstreams.workspaceId, ws.id))).toEqual([]);
    expect(deps.events.filter((e) => e.kind === 'delete').map((e) => e.app_id).sort()).toEqual([one.app_id, two.app_id].sort());

    const audit = await db
      .select({ workspaceId: auditLog.workspaceId, actorKind: auditLog.actorKind, actorUserId: auditLog.actorUserId, target: auditLog.target, meta: auditLog.meta })
      .from(auditLog)
      .where(eq(auditLog.action, 'workspace.delete'));
    expect(audit).toHaveLength(2);
    expect(audit.map((r) => r.workspaceId).sort()).toEqual([ws.id, alicePersonal.id].sort());
    for (const row of audit) {
      expect(row).toMatchObject({ actorKind: 'agent', actorUserId: P.alice.userId, target: ws.slug, meta: { apps: 2, members: 2 } });
    }

    expect(errorOf(await as('ed', (c) => c.call('get_app', { app_id: one.app_id })))).toMatchObject({ code: 'not_found' });
    const listed = (await as('ed', (c) => c.call('list_apps', {}))).body as { workspaces: { slug: string }[] };
    expect(listed.workspaces.map((w) => w.slug)).not.toContain(ws.slug);
    expect(errorOf(await as('alice', (c) => c.call('delete_workspace', { workspace: ws.slug, user_confirmed: true })))).toMatchObject({
      code: 'not_found',
    });
  });

  it('an editor is forbidden and a non-member gets not_found, even with user_confirmed', async () => {
    const ws = await team();
    expect(errorOf(await as('ed', (c) => c.call('delete_workspace', { workspace: ws.slug, user_confirmed: true })))).toMatchObject({
      code: 'forbidden',
    });
    expect(errorOf(await as('eve', (c) => c.call('delete_workspace', { workspace: ws.slug, user_confirmed: true })))).toMatchObject({
      code: 'not_found',
    });
    expect(await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(1);
  });

  it('a personal workspace answers personal_workspace before asking', async () => {
    const refused = errorOf(await as('alice', (c) => c.call('delete_workspace', { workspace: alicePersonal.slug })));
    expect(refused).toMatchObject({ code: 'personal_workspace' });
    expect(String(refused.message)).toMatch(/account/);
    expect(await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, alicePersonal.id))).toHaveLength(1);
  });
});
