/**
 * NSO-366: the publish gate (PUBLISH_APPROVAL=approval), the super-admin
 * bypasses, the approval request dedupe, approve / revoke + audit, and the
 * migration that grandfathers every workspace with a published app.
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
  listPublishApprovals,
  publish,
  publishPermissions,
  requestPublishApproval,
  setPublishApproval,
  type Actor,
} from './index.js';
import { freshDb, migrateTo, migrationsUpTo, type TestDb } from './test/db.js';

const APPROVAL = { PUBLISH_APPROVAL: 'approval', SUPERADMIN_EMAIL: 'boss@x.test', PUBLIC_APP_URL: 'https://dash.example.test' };

let db: TestDb;
let close: () => Promise<void>;

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
});
afterAll(async () => close());

let n = 0;
async function setup(opts: { memberEmail?: string } = {}) {
  n += 1;
  const [u] = await db.insert(users).values({ email: `owner${n}@x.test` }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'personal', slug: `ws-${n}`, name: `WS ${n}` }).returning();
  await db.insert(memberships).values({ userId: u.id, workspaceId: w.id, role: 'workspace-admin' });
  if (opts.memberEmail) {
    const [m] = await db.insert(users).values({ email: opts.memberEmail }).onConflictDoNothing().returning();
    const id = m?.id ?? (await db.select().from(users).where(eq(users.email, opts.memberEmail)))[0].id;
    await db.insert(memberships).values({ userId: id, workspaceId: w.id, role: 'viewer' });
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

describe('the publish gate', () => {
  it('open mode (the default) publishes as before', async () => {
    const { app, v, actor } = await setup();
    await expect(publish(app.id, v.id, actor, { screen: false, env: {} })).resolves.toMatchObject({ number: 1 });
  });

  it('approval mode refuses an unapproved workspace with publish_not_approved + the contact, and moves nothing', async () => {
    const { app, v, actor } = await setup();
    const err = await publish(app.id, v.id, actor, { screen: false, env: { ...APPROVAL, OPERATOR_EMAIL: 'ops@x.test' } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'publish_not_approved', contact: 'ops@x.test' });
    expect(err.message).toContain('needs approval from ops@x.test');
    const [row] = await db.select({ p: apps.publishedVersionId }).from(apps).where(eq(apps.id, app.id));
    expect(row.p).toBeNull();
  });

  it('a blocked publish records an approval request (once) and audits it', async () => {
    const { app, v, actor, ws } = await setup();
    await publish(app.id, v.id, actor, { screen: false, env: APPROVAL }).catch(() => null);
    await publish(app.id, v.id, actor, { screen: false, env: APPROVAL }).catch(() => null);
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(w.publishApprovalRequestedAt).toBeInstanceOf(Date);
    expect(w.publishApprovalRequestedBy).toBe(actor.userId);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, ws.id), eq(auditLog.action, 'workspace.publish_approval_request')));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ subjectType: 'workspace', target: ws.slug, meta: { app: `App ${n}` } });
  });

  it('an approved workspace publishes; the rollback is gated the same way', async () => {
    const { app, v, actor, ws } = await setup();
    const boss = await superAdmin();
    expect(await setPublishApproval({ workspaceId: ws.id, approved: true, actor: boss })).toMatchObject({ changed: true });
    await expect(publish(app.id, v.id, actor, { screen: false, env: APPROVAL })).resolves.toMatchObject({ number: 1 });
    const v2 = await createVersion(app.id, [{ path: 'index.html', content: 'two' }], { actor, compile: { status: 'ok' } });
    await publish(app.id, v2.id, actor, { screen: false, env: APPROVAL });
    await setPublishApproval({ workspaceId: ws.id, approved: false, actor: boss });
    await expect(publish(app.id, v.id, actor, { screen: false, env: APPROVAL })).rejects.toMatchObject({ code: 'publish_not_approved' });
    const [row] = await db.select({ p: apps.publishedVersionId }).from(apps).where(eq(apps.id, app.id));
    expect(row.p).toBe(v2.id);
  });

  it('a workspace with a super-admin member, or a super-admin actor, may always publish', async () => {
    const withBoss = await setup({ memberEmail: 'boss@x.test' });
    await expect(publish(withBoss.app.id, withBoss.v.id, withBoss.actor, { screen: false, env: APPROVAL })).resolves.toBeTruthy();
    const plain = await setup();
    await expect(publish(plain.app.id, plain.v.id, await superAdmin(), { screen: false, env: APPROVAL })).resolves.toBeTruthy();
    const perms = await publishPermissions([withBoss.ws.id, plain.ws.id], { env: APPROVAL });
    expect(perms.get(withBoss.ws.id)).toMatchObject({ allowed: true, allowedBy: 'super_admin', contact: null });
    expect(perms.get(plain.ws.id)).toMatchObject({ allowed: false, allowedBy: null, contact: 'boss@x.test' });
  });
});

describe('requestPublishApproval', () => {
  it('e-mails every operator once per 24 h with the workspace, the requester, the app and the approval link', async () => {
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

  it('is not needed for an approved workspace or in open mode, and a mail failure never throws', async () => {
    const { ws, actor } = await setup();
    const send = vi.fn(async () => {
      throw new Error('smtp down');
    });
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(requestPublishApproval({ workspaceId: ws.id, actor, env: APPROVAL, send, log })).resolves.toMatchObject({ status: 'sent', mailed: 0 });
    expect(log.error).toHaveBeenCalledOnce();
    expect(await requestPublishApproval({ workspaceId: ws.id, actor, env: {}, send })).toMatchObject({ status: 'not_needed' });
    await setPublishApproval({ workspaceId: ws.id, approved: true, actor: await superAdmin() });
    expect(await requestPublishApproval({ workspaceId: ws.id, actor, env: APPROVAL, send })).toMatchObject({ status: 'not_needed' });
  });
});

describe('setPublishApproval + listPublishApprovals', () => {
  it('approve / revoke change once, audit, and revoking clears the request', async () => {
    const { ws, actor } = await setup();
    const boss = await superAdmin();
    await requestPublishApproval({ workspaceId: ws.id, actor, env: APPROVAL, send: async () => true });
    const listed = await listPublishApprovals({ filter: 'requested', env: APPROVAL });
    expect(listed.find((e) => e.id === ws.id)).toMatchObject({
      slug: ws.slug,
      apps: 1,
      publishedApps: 0,
      admins: [`owner${n}@x.test`],
      requestedByEmail: `owner${n}@x.test`,
      superAdminMember: false,
    });
    expect((await setPublishApproval({ workspaceId: ws.id, approved: true, actor: boss })).changed).toBe(true);
    expect((await setPublishApproval({ workspaceId: ws.id, approved: true, actor: boss })).changed).toBe(false);
    expect((await listPublishApprovals({ filter: 'approved' })).find((e) => e.id === ws.id)).toMatchObject({ approvedByEmail: 'boss@x.test' });
    expect((await setPublishApproval({ workspaceId: ws.id, approved: false, actor: boss })).changed).toBe(true);
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(w).toMatchObject({ publishApprovedAt: null, publishApprovedBy: null, publishApprovalRequestedAt: null });
    const actions = (await db.select().from(auditLog).where(eq(auditLog.workspaceId, ws.id))).map((r) => r.action);
    expect(actions.filter((a) => a.startsWith('workspace.'))).toEqual([
      'workspace.publish_approval_request',
      'workspace.publish_approve',
      'workspace.publish_revoke',
    ]);
  });

  it('an unknown workspace is not_found', async () => {
    await expect(setPublishApproval({ workspaceId: 'nope', approved: true, actor: await superAdmin() })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('migration 0026 (publish approval)', () => {
  it('approves every workspace that has a live published app, and only those', async () => {
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
      await migrateTo(mdb);
      const rows = await pg.query<{ id: string; approved: boolean }>(
        'SELECT id, publish_approved_at IS NOT NULL AS approved FROM workspaces ORDER BY id'
      );
      expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.approved]))).toEqual({
        'w-draft': false,
        'w-empty': false,
        'w-gone': false,
        'w-live': true,
      });
    } finally {
      await pg.close();
    }
  });
});
