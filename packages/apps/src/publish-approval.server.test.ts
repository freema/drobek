/**
 * Who may publish — the whole decision table (mode × workspace
 * state × super-admin member × super-admin publisher), the approval request
 * dedupe (never for a blocked workspace), setWorkspacePublishing (the state
 * transitions, audit, the block / unblock e-mails to editors and admins),
 * the publishing list, and migrations 0026 (grandfathering) and 0027 (the
 * block columns).
 */
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { apps, auditLog, memberships, users, workspaces } from '@drobek/db';
import {
  createApp,
  createVersion,
  listWorkspacePublishing,
  publish,
  publishPermissions,
  requestPublishApproval,
  setWorkspacePublishing,
  type Actor,
  type WorkspacePublishing,
} from './index.js';
import { freshDb, migrateTo, migrationsUpTo, type TestDb } from './test/db.js';

const APPROVAL = { PUBLISH_APPROVAL: 'approval', SUPERADMIN_EMAIL: 'boss@x.test', PUBLIC_APP_URL: 'https://dash.example.test' };
const OPEN = { SUPERADMIN_EMAIL: 'boss@x.test', PUBLIC_APP_URL: 'https://dash.example.test' };

let db: TestDb;
let close: () => Promise<void>;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
});
afterAll(async () => close());

let n = 0;
async function setup(opts: { memberEmail?: string; memberRole?: 'viewer' | 'editor' } = {}) {
  n += 1;
  const [u] = await db.insert(users).values({ email: `owner${n}@x.test` }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'personal', slug: `ws-${n}`, name: `WS ${n}` }).returning();
  await db.insert(memberships).values({ userId: u.id, workspaceId: w.id, role: 'workspace-admin' });
  if (opts.memberEmail) {
    const [m] = await db.insert(users).values({ email: opts.memberEmail }).onConflictDoNothing().returning();
    const id = m?.id ?? (await db.select().from(users).where(eq(users.email, opts.memberEmail)))[0].id;
    await db.insert(memberships).values({ userId: id, workspaceId: w.id, role: opts.memberRole ?? 'viewer' });
  }
  const actor: Actor = { userId: u.id, kind: 'agent' };
  const app = await createApp({ workspaceId: w.id, slug: `pa-app-${n}`, name: `App ${n}`, actor });
  const v = await createVersion(app.id, [{ path: 'index.html', content: `<h1>${n}</h1>` }], { actor, compile: { status: 'ok' } });
  return { user: u, ws: w, actor, app, v };
}

async function superAdmin(): Promise<Actor> {
  const [existing] = await db.select().from(users).where(eq(users.email, 'boss@x.test'));
  const u = existing ?? (await db.insert(users).values({ email: 'boss@x.test' }).returning())[0];
  return { userId: u.id, kind: 'user' };
}

const quiet = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('the publish decision', () => {
  const cases: Array<[mode: 'open' | 'approval', state: WorkspacePublishing, member: boolean, publisherIsAdmin: boolean, expected: 'ok' | 'publish_blocked' | 'publish_not_approved']> = [];
  for (const mode of ['open', 'approval'] as const) {
    for (const state of ['default', 'allowed', 'blocked'] as const) {
      for (const member of [false, true]) {
        for (const publisherIsAdmin of [false, true]) {
          const expected = publisherIsAdmin
            ? 'ok'
            : state === 'blocked'
              ? 'publish_blocked'
              : state === 'allowed' || member || mode === 'open'
                ? 'ok'
                : 'publish_not_approved';
          cases.push([mode, state, member, publisherIsAdmin, expected]);
        }
      }
    }
  }

  it.each(cases)('%s mode, %s workspace, super-admin member %s, super-admin publisher %s → %s', async (mode, state, member, publisherIsAdmin, expected) => {
    const env = mode === 'open' ? OPEN : APPROVAL;
    const s = await setup(member ? { memberEmail: 'boss@x.test' } : {});
    const boss = await superAdmin();
    if (state !== 'default') await setWorkspacePublishing({ workspaceId: s.ws.id, publishing: state, actor: boss, env, log: quiet(), send: async () => true });
    const actor = publisherIsAdmin ? boss : s.actor;
    const out = await publish(s.app.id, s.v.id, actor, { screen: false, env }).then(
      () => 'ok' as const,
      (e: { code: string; contact?: string; message: string }) => {
        expect(e.contact).toBe('boss@x.test');
        if (e.code === 'publish_blocked') {
          expect(e.message).toBe(
            'Publishing from this workspace was turned off by the operator of this server (boss@x.test). Previews, versions and everything else keep working; live apps keep serving unless taken down.'
          );
        }
        return e.code;
      }
    );
    expect(out).toBe(expected);
    const [row] = await db.select({ p: apps.publishedVersionId }).from(apps).where(eq(apps.id, s.app.id));
    expect(row.p).toBe(expected === 'ok' ? s.v.id : null);
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, s.ws.id));
    expect(w.publishApprovalRequestedAt !== null).toBe(expected === 'publish_not_approved');
  });

  it('publishPermissions says why, per workspace (no actor = a plain member)', async () => {
    const boss = await superAdmin();
    const plain = await setup();
    const blocked = await setup({ memberEmail: 'boss@x.test' });
    await setWorkspacePublishing({ workspaceId: blocked.ws.id, publishing: 'blocked', actor: boss, env: OPEN, log: quiet(), send: async () => true });
    const perms = await publishPermissions([plain.ws.id, blocked.ws.id], { env: { ...OPEN, OPERATOR_EMAIL: 'ops@x.test' } });
    expect(perms.get(plain.ws.id)).toMatchObject({ allowed: true, allowedBy: 'open', publishing: 'default', refusal: null, contact: null });
    expect(perms.get(blocked.ws.id)).toMatchObject({ allowed: false, publishing: 'blocked', refusal: 'blocked', contact: 'ops@x.test' });
    const asBoss = await publishPermissions([blocked.ws.id], { env: OPEN, actorUserId: boss.userId });
    expect(asBoss.get(blocked.ws.id)).toMatchObject({ allowed: true, allowedBy: 'super_admin', publishing: 'blocked' });
  });

  it('a rollback is gated the same way', async () => {
    const { app, v, actor, ws } = await setup();
    const boss = await superAdmin();
    await publish(app.id, v.id, actor, { screen: false, env: OPEN });
    const v2 = await createVersion(app.id, [{ path: 'index.html', content: 'two' }], { actor, compile: { status: 'ok' } });
    await publish(app.id, v2.id, actor, { screen: false, env: OPEN });
    await setWorkspacePublishing({ workspaceId: ws.id, publishing: 'blocked', actor: boss, env: OPEN, log: quiet(), send: async () => true });
    await expect(publish(app.id, v.id, actor, { screen: false, env: OPEN })).rejects.toMatchObject({ code: 'publish_blocked' });
    const [row] = await db.select({ p: apps.publishedVersionId }).from(apps).where(eq(apps.id, app.id));
    expect(row.p).toBe(v2.id);
  });
});

describe('requestPublishApproval', () => {
  it('e-mails every operator once per 24 h with the workspace, the requester, the app and the publishing link', async () => {
    const { ws, actor, user } = await setup();
    const send = vi.fn(async () => true);
    const env = { ...APPROVAL, SUPERADMIN_EMAIL: 'boss@x.test,two@x.test' };
    const now = new Date('2026-09-27T10:00:00Z');
    const first = await requestPublishApproval({ workspaceId: ws.id, actor, appName: 'Shop', env, send, now });
    expect(first).toMatchObject({ status: 'sent', mailed: 2, contact: 'boss@x.test' });
    expect(send.mock.calls.map((c) => (c as unknown as [{ to: string }])[0].to)).toEqual(['boss@x.test', 'two@x.test']);
    const mail = (send.mock.calls[0] as unknown as [{ subject: string; text: string; replyTo: string }])[0];
    expect(mail.subject).toBe(`Publish approval requested: ${ws.name} (${ws.slug})`);
    expect(mail.text).toContain(`Requested by: ${user.email}`);
    expect(mail.text).toContain('App: Shop');
    expect(mail.text).toContain('https://dash.example.test/admin/publishing');
    expect(mail.replyTo).toBe(user.email);

    const again = await requestPublishApproval({ workspaceId: ws.id, actor, env, send, now: new Date('2026-09-28T09:00:00Z') });
    expect(again).toMatchObject({ status: 'pending', mailed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    const later = await requestPublishApproval({ workspaceId: ws.id, actor, env, send, now: new Date('2026-09-28T10:00:01Z') });
    expect(later).toMatchObject({ status: 'sent', mailed: 2 });
  });

  it('is not needed for an allowed workspace or in open mode, never for a blocked one, and a mail failure never throws', async () => {
    const { ws, actor } = await setup();
    const send = vi.fn(async () => {
      throw new Error('smtp down');
    });
    const log = quiet();
    await expect(requestPublishApproval({ workspaceId: ws.id, actor, env: APPROVAL, send, log })).resolves.toMatchObject({ status: 'sent', mailed: 0 });
    expect(log.error).toHaveBeenCalledOnce();
    expect(await requestPublishApproval({ workspaceId: ws.id, actor, env: {}, send })).toMatchObject({ status: 'not_needed' });
    const boss = await superAdmin();
    await setWorkspacePublishing({ workspaceId: ws.id, publishing: 'allowed', actor: boss, env: APPROVAL, log: quiet(), send: async () => true });
    expect(await requestPublishApproval({ workspaceId: ws.id, actor, env: APPROVAL, send })).toMatchObject({ status: 'not_needed' });
    await setWorkspacePublishing({ workspaceId: ws.id, publishing: 'blocked', actor: boss, env: APPROVAL, log: quiet(), send: async () => true });
    send.mockClear();
    expect(await requestPublishApproval({ workspaceId: ws.id, actor, env: APPROVAL, send })).toMatchObject({ status: 'blocked', mailed: 0, contact: 'boss@x.test' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('setWorkspacePublishing', () => {
  it('moves between default / allowed / blocked, each clearing the other, audited once per change', async () => {
    const { ws, actor } = await setup();
    const boss = await superAdmin();
    const opts = { workspaceId: ws.id, actor: boss, env: APPROVAL, log: quiet(), send: async () => true };
    await requestPublishApproval({ workspaceId: ws.id, actor, env: APPROVAL, send: async () => true });

    expect(await setWorkspacePublishing({ ...opts, publishing: 'allowed' })).toMatchObject({ changed: true, previous: 'default', publishing: 'allowed', mailed: 0 });
    expect(await setWorkspacePublishing({ ...opts, publishing: 'allowed' })).toMatchObject({ changed: false, previous: 'allowed' });
    let [w] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(w).toMatchObject({ publishApprovedBy: boss.userId, publishBlockedAt: null });

    expect(await setWorkspacePublishing({ ...opts, publishing: 'blocked' })).toMatchObject({ changed: true, previous: 'allowed' });
    [w] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(w).toMatchObject({ publishApprovedAt: null, publishApprovedBy: null, publishBlockedBy: boss.userId, publishApprovalRequestedAt: null });
    expect(w.publishBlockedAt).toBeInstanceOf(Date);

    expect(await setWorkspacePublishing({ ...opts, publishing: 'allowed' })).toMatchObject({ changed: true, previous: 'blocked' });
    [w] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(w).toMatchObject({ publishBlockedAt: null, publishBlockedBy: null });
    expect(w.publishApprovedAt).toBeInstanceOf(Date);

    expect(await setWorkspacePublishing({ ...opts, publishing: 'default' })).toMatchObject({ changed: true, previous: 'allowed' });
    await setWorkspacePublishing({ ...opts, publishing: 'blocked' });
    await setWorkspacePublishing({ ...opts, publishing: 'default' });
    [w] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(w).toMatchObject({ publishApprovedAt: null, publishBlockedAt: null, publishApprovalRequestedAt: null });

    const rows = await db
      .select({ action: auditLog.action, meta: auditLog.meta, target: auditLog.target })
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.actorUserId, boss.userId!)));
    expect(rows.map((r) => [r.action, r.meta])).toEqual([
      ['workspace.publish_approve', { from: 'default', to: 'allowed' }],
      ['workspace.publish_block', { from: 'allowed', to: 'blocked' }],
      ['workspace.publish_unblock', { from: 'blocked', to: 'allowed' }],
      ['workspace.publish_revoke', { from: 'allowed', to: 'default' }],
      ['workspace.publish_block', { from: 'default', to: 'blocked' }],
      ['workspace.publish_unblock', { from: 'blocked', to: 'default' }],
    ]);
    expect(rows.every((r) => r.target === ws.slug)).toBe(true);
  });

  it('blocking and unblocking e-mail the editors and admins (not viewers) what happened and whom to contact', async () => {
    const { ws } = await setup({ memberEmail: `editor${n + 1}@x.test`, memberRole: 'editor' });
    const [viewer] = await db.insert(users).values({ email: `viewer${n}@x.test` }).returning();
    await db.insert(memberships).values({ userId: viewer.id, workspaceId: ws.id, role: 'viewer' });
    const boss = await superAdmin();
    const send = vi.fn(async () => true);
    const env = { ...OPEN, OPERATOR_EMAIL: 'ops@x.test' };
    const blocked = await setWorkspacePublishing({ workspaceId: ws.id, publishing: 'blocked', actor: boss, env, send, log: quiet() });
    expect(blocked.mailed).toBe(2);
    const mails = send.mock.calls.map((c) => (c as unknown as [{ to: string; subject: string; text: string; replyTo?: string }])[0]);
    expect(mails.map((m) => m.to).sort()).toEqual([`editor${n}@x.test`, `owner${n}@x.test`].sort());
    expect(mails[0].subject).toBe(`Publishing is turned off for your workspace ${ws.name}`);
    expect(mails[0].text).toContain(`turned publishing off for your workspace ${ws.name} (${ws.slug})`);
    expect(mails[0].text).toContain('apps that are live keep serving unless the operator takes them down');
    expect(mails[0].text).toContain('ops@x.test');
    expect(mails[0].replyTo).toBe('ops@x.test');

    send.mockClear();
    await setWorkspacePublishing({ workspaceId: ws.id, publishing: 'default', actor: boss, env, send, log: quiet() });
    const back = (send.mock.calls[0] as unknown as [{ subject: string; text: string }])[0];
    expect(back.subject).toBe(`Publishing is turned back on for your workspace ${ws.name}`);
    expect(back.text).toContain('You can publish from it again');

    send.mockClear();
    await setWorkspacePublishing({ workspaceId: ws.id, publishing: 'allowed', actor: boss, env, send, log: quiet() });
    expect(send).not.toHaveBeenCalled();
  });

  it('a failing mailbox never fails the change; an unknown workspace is not_found', async () => {
    const { ws } = await setup();
    const log = quiet();
    const out = await setWorkspacePublishing({
      workspaceId: ws.id,
      publishing: 'blocked',
      actor: await superAdmin(),
      env: OPEN,
      log,
      send: async () => {
        throw new Error('smtp down');
      },
    });
    expect(out).toMatchObject({ changed: true, mailed: 0 });
    expect(log.error).toHaveBeenCalled();
    await expect(setWorkspacePublishing({ workspaceId: 'nope', publishing: 'allowed', actor: await superAdmin() })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('listWorkspacePublishing', () => {
  it('filters by state, carries who decided and the live apps', async () => {
    const boss = await superAdmin();
    const s = await setup();
    await publish(s.app.id, s.v.id, s.actor, { screen: false, env: OPEN });
    await requestPublishApproval({ workspaceId: s.ws.id, actor: s.actor, env: APPROVAL, send: async () => true });
    const requested = (await listWorkspacePublishing({ filter: 'requested', env: APPROVAL })).find((e) => e.id === s.ws.id);
    expect(requested).toMatchObject({
      publishing: 'default',
      apps: 1,
      publishedApps: 1,
      liveApps: [{ id: s.app.id, slug: s.app.slug, name: `App ${n}` }],
      admins: [`owner${n}@x.test`],
      requestedByEmail: `owner${n}@x.test`,
      superAdminMember: false,
    });
    await setWorkspacePublishing({ workspaceId: s.ws.id, publishing: 'blocked', actor: boss, env: OPEN, log: quiet(), send: async () => true });
    expect((await listWorkspacePublishing({ filter: 'requested' })).some((e) => e.id === s.ws.id)).toBe(false);
    expect((await listWorkspacePublishing({ filter: 'default' })).some((e) => e.id === s.ws.id)).toBe(false);
    expect((await listWorkspacePublishing({ filter: 'blocked' })).find((e) => e.id === s.ws.id)).toMatchObject({
      publishing: 'blocked',
      blockedByEmail: 'boss@x.test',
    });
    const one = await listWorkspacePublishing({ filter: 'all', workspace: s.ws.slug });
    expect(one.map((e) => e.slug)).toEqual([s.ws.slug]);
    await setWorkspacePublishing({ workspaceId: s.ws.id, publishing: 'allowed', actor: boss, env: OPEN, log: quiet(), send: async () => true });
    expect((await listWorkspacePublishing({ filter: 'allowed' })).find((e) => e.id === s.ws.id)).toMatchObject({ approvedByEmail: 'boss@x.test' });
  });
});

describe('migrations 0026 + 0027', () => {
  it('0026 approves every workspace that has a live published app; 0027 adds the block columns and keeps the approvals', async () => {
    const pg = new PGlite();
    const mdb = drizzle(pg, { schema });
    try {
      await migrateTo(mdb, migrationsUpTo(25));
      await pg.exec(`
        INSERT INTO workspaces (id, kind, slug, name) VALUES
          ('w-live', 'personal', 'live', 'Live'), ('w-draft', 'personal', 'draft', 'Draft'),
          ('w-gone', 'team', 'gone', 'Gone'), ('w-empty', 'team', 'empty', 'Empty');
        INSERT INTO apps (id, workspace_id, slug) VALUES ('a1', 'w-live', 'live-app'), ('a2', 'w-draft', 'draft-app'), ('a3', 'w-gone', 'gone-app');
        INSERT INTO app_versions (id, app_id, number, compile_status, actor_kind) VALUES ('v1', 'a1', 1, 'ok', 'agent'), ('v3', 'a3', 1, 'ok', 'agent');
        UPDATE apps SET published_version_id = 'v1' WHERE id = 'a1';
        UPDATE apps SET published_version_id = 'v3', deleted_at = now() WHERE id = 'a3';
      `);
      await migrateTo(mdb, migrationsUpTo(26));
      const before = await pg.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name LIKE 'publish_blocked%'"
      );
      expect(before.rows).toEqual([]);
      await pg.exec(`INSERT INTO users (id, email) VALUES ('u-boss', 'boss@x.test')`);
      await migrateTo(mdb);
      const rows = await pg.query<{ id: string; approved: boolean; blocked: boolean }>(
        'SELECT id, publish_approved_at IS NOT NULL AS approved, publish_blocked_at IS NOT NULL AS blocked FROM workspaces ORDER BY id'
      );
      expect(Object.fromEntries(rows.rows.map((r) => [r.id, [r.approved, r.blocked]]))).toEqual({
        'w-draft': [false, false],
        'w-empty': [false, false],
        'w-gone': [false, false],
        'w-live': [true, false],
      });
      await pg.exec(`UPDATE workspaces SET publish_blocked_at = now(), publish_blocked_by = 'u-boss' WHERE id = 'w-draft'`);
      await pg.exec(`DELETE FROM users WHERE id = 'u-boss'`);
      const [kept] = (
        await pg.query<{ blocked: boolean; by: string | null }>(
          "SELECT publish_blocked_at IS NOT NULL AS blocked, publish_blocked_by AS by FROM workspaces WHERE id = 'w-draft'"
        )
      ).rows;
      expect(kept).toEqual({ blocked: true, by: null });
    } finally {
      await pg.close();
    }
  });
});
