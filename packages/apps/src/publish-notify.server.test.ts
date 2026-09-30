/**
 * PUBLISH_NOTIFY — off by default; `first` mails only an app's first
 * publish, `every` every publish at most once per app per hour (a Redis
 * error sends anyway); recipients are OPERATOR_EMAIL, else every
 * super-admin; a super-admin's own publishes are never mailed; the mail
 * carries the app, live URL + custom domains, workspace, publisher, surface,
 * version, kind and the moderation links; publish() tells first / republish
 * / rollback apart and a failing mailbox never fails the publish.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { domains, memberships, users, workspaces } from '@drobek/db';

const mail = vi.hoisted(() => ({ send: vi.fn(async (_m: { to: string; subject: string; text: string }) => 'sent' as const) }));
const redis = vi.hoisted(() => ({ set: vi.fn(async () => 'OK' as string | null) }));

vi.mock('@drobek/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drobek/email')>()),
  sendEmail: mail.send,
}));
vi.mock('@drobek/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drobek/core')>()),
  getRedis: () => ({ set: redis.set }),
}));

const { createApp, createVersion, notifyOperatorOfPublish, publish } = await import('./index.js');
const { freshDb } = await import('./test/db.js');
type Actor = import('./index.js').Actor;

const BASE = {
  APPS_DOMAIN: 'drobek.app',
  PUBLIC_APP_URL: 'https://dash.example.test',
  SUPERADMIN_EMAIL: 'boss@x.test,two@x.test',
};

let close: () => Promise<void>;
let db: Awaited<ReturnType<typeof freshDb>>['db'];
let owner: Actor;
let boss: Actor;
let appId: string;

const quiet = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeAll(async () => {
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [u] = await db.insert(users).values({ email: 'maker@x.test' }).returning();
  const [b] = await db.insert(users).values({ email: 'boss@x.test' }).returning();
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'makers', name: 'Makers' }).returning();
  await db.insert(memberships).values({ userId: u.id, workspaceId: w.id, role: 'workspace-admin' });
  owner = { userId: u.id, kind: 'agent' };
  boss = { userId: b.id, kind: 'user' };
  const app = await createApp({ workspaceId: w.id, slug: 'shop', name: 'Shop', actor: owner });
  appId = app.id;
  await db.insert(domains).values([
    { appId, hostname: 'shop.example.com', verificationToken: 't1', verifiedAt: new Date() },
    { appId, hostname: 'pending.example.com', verificationToken: 't2' },
  ]);
});
afterAll(async () => close());
beforeEach(() => {
  mail.send.mockReset();
  mail.send.mockImplementation(async () => 'sent' as const);
  redis.set.mockReset();
  redis.set.mockImplementation(async () => 'OK');
});

function sent(): { to: string; subject: string; text: string }[] {
  return mail.send.mock.calls.map((c) => c[0]);
}

describe('notifyOperatorOfPublish', () => {
  it('off (the default) sends nothing', async () => {
    expect(await notifyOperatorOfPublish({ appId, version: 1, kind: 'first', actor: owner, env: BASE })).toEqual({ status: 'skipped', reason: 'off' });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('first: mails every super-admin about the first publish, with the app, domains, workspace, publisher and links', async () => {
    const env = { ...BASE, PUBLISH_NOTIFY: 'first' };
    expect(await notifyOperatorOfPublish({ appId, version: 3, kind: 'first', actor: owner, env })).toEqual({ status: 'sent', mailed: 2 });
    expect(sent().map((m) => m.to)).toEqual(['boss@x.test', 'two@x.test']);
    const m = sent()[0];
    expect(m.subject).toBe('New app published: Shop (shop)');
    for (const line of [
      'maker@x.test published Shop on your drobek server over MCP (a coding agent).',
      'App: Shop (shop)',
      'Live: https://shop.drobek.app',
      'Custom domains: shop.example.com',
      'Workspace: Makers (makers)',
      'Published by: maker@x.test, over MCP (a coding agent)',
      'Version: 3 (first publish)',
      'Open the app: https://shop.drobek.app',
      'The app in the dashboard: https://dash.example.test/workspaces/makers/apps/shop',
      'Take the app down: https://dash.example.test/admin/publishing?workspace=makers#app-shop',
      'Turn publishing off for the workspace: https://dash.example.test/admin/publishing?workspace=makers',
    ]) {
      expect(m.text).toContain(line);
    }
    expect(m.text).not.toContain('pending.example.com');

    mail.send.mockClear();
    expect(await notifyOperatorOfPublish({ appId, version: 4, kind: 'republish', actor: owner, env })).toEqual({ status: 'skipped', reason: 'not_first' });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('every: one mail per app per hour (Redis SET NX), a Redis error sends anyway; OPERATOR_EMAIL replaces the super-admins', async () => {
    const env = { ...BASE, PUBLISH_NOTIFY: 'every', OPERATOR_EMAIL: 'ops@x.test' };
    const r = await notifyOperatorOfPublish({ appId, version: 5, kind: 'rollback', actor: { ...owner, kind: 'user' }, env });
    expect(r).toEqual({ status: 'sent', mailed: 1 });
    expect(redis.set).toHaveBeenCalledWith(`drobek:publish:notify:${appId}`, '1', 'PX', 3_600_000, 'NX');
    expect(sent()[0]).toMatchObject({ to: 'ops@x.test', subject: 'App rolled back: Shop (shop)' });
    expect(sent()[0].text).toContain('Published by: maker@x.test, in the dashboard');
    expect(sent()[0].text).toContain('Version: 5 (rollback to an older version)');

    redis.set.mockImplementation(async () => null);
    expect(await notifyOperatorOfPublish({ appId, version: 6, kind: 'republish', actor: owner, env })).toEqual({ status: 'skipped', reason: 'deduped' });

    redis.set.mockImplementation(async () => {
      throw new Error('redis down');
    });
    const log = quiet();
    expect(await notifyOperatorOfPublish({ appId, version: 7, kind: 'republish', actor: owner, env, log })).toEqual({ status: 'sent', mailed: 1 });
    expect(log.warn).toHaveBeenCalled();
  });

  it('never mails a super-admin\'s own publish, or when nobody is configured', async () => {
    expect(await notifyOperatorOfPublish({ appId, version: 1, kind: 'first', actor: boss, env: { ...BASE, PUBLISH_NOTIFY: 'every' } })).toEqual({
      status: 'skipped',
      reason: 'super_admin',
    });
    expect(await notifyOperatorOfPublish({ appId, version: 1, kind: 'first', actor: owner, env: { APPS_DOMAIN: 'drobek.app', PUBLISH_NOTIFY: 'first' } })).toEqual({
      status: 'skipped',
      reason: 'no_recipients',
    });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('a failing mailbox is logged, never thrown', async () => {
    mail.send.mockImplementation(async () => {
      throw new Error('smtp down');
    });
    const log = quiet();
    expect(await notifyOperatorOfPublish({ appId, version: 1, kind: 'first', actor: owner, env: { ...BASE, PUBLISH_NOTIFY: 'first' }, log })).toEqual({
      status: 'sent',
      mailed: 0,
    });
    expect(log.error).toHaveBeenCalledTimes(2);
  });
});

describe('publish() and PUBLISH_NOTIFY', () => {
  it('tells first / republish / rollback apart, does not wait for the mail and survives a failing mailbox', async () => {
    const env = { ...BASE, PUBLISH_NOTIFY: 'every', SUPERADMIN_EMAIL: 'boss@x.test' };
    const app = await createApp({ workspaceId: (await db.select().from(workspaces).where(eq(workspaces.slug, 'makers')))[0].id, slug: 'blog', name: 'Blog', actor: owner });
    const v1 = await createVersion(app.id, [{ path: 'index.html', content: 'one' }], { actor: owner, compile: { status: 'ok' } });
    const v2 = await createVersion(app.id, [{ path: 'index.html', content: 'two' }], { actor: owner, compile: { status: 'ok' } });

    await publish(app.id, v1.id, owner, { screen: false, env });
    await vi.waitFor(() => expect(sent().map((m) => m.subject)).toEqual(['New app published: Blog (blog)']));
    await publish(app.id, v2.id, owner, { screen: false, env });
    await vi.waitFor(() => expect(sent().map((m) => m.subject).at(-1)).toBe('App republished: Blog (blog)'));

    let release: () => void = () => undefined;
    mail.send.mockImplementation(
      () =>
        new Promise((_, reject) => {
          release = () => reject(new Error('smtp down'));
        })
    );
    await expect(publish(app.id, v1.id, owner, { screen: false, env })).resolves.toMatchObject({ number: 1, previousNumber: 2 });
    await vi.waitFor(() => expect(mail.send).toHaveBeenCalledTimes(3));
    expect((mail.send.mock.calls[2][0] as { subject: string }).subject).toBe('App rolled back: Blog (blog)');
    release();
  });
});
