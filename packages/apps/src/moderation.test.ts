/**
 * Abuse reports, takedown / restore and the publish heuristic against a real
 * (PGlite) database with the core migrations applied (NSO-293).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { abuseReports, apps, auditLog, users, workspaces } from '@drobek/db';
import {
  AppsError,
  appLockState,
  createAbuseReport,
  createApp,
  createVersion,
  findAppByReportedHost,
  listAbuseReports,
  listLockedApps,
  onLocalAppChanged,
  publish,
  resolveAbuseReport,
  restore,
  restoreApp,
  takedownApp,
  validateAbuseReport,
  type Actor,
  type AppChangedEvent,
} from './index.js';
import { freshDb, type TestDb } from './test/db.js';

const HOSTS = { appsDomain: 'apps.example', dashboardHost: 'drobek.example' };

let db: TestDb;
let close: () => Promise<void>;
let wsId: string;
let actor: Actor;
let adminId: string;

beforeAll(async () => {
  process.env.APPS_DOMAIN = 'apps.example';
  const t = await freshDb();
  db = t.db;
  close = () => t.pg.close();
  const [u] = await db.insert(users).values({ email: 'owner@example.test' }).returning();
  const [a] = await db.insert(users).values({ email: 'root@example.test' }).returning();
  adminId = a.id;
  const [w] = await db.insert(workspaces).values({ kind: 'personal', slug: 'owner', name: 'Owner' }).returning();
  wsId = w.id;
  actor = { userId: u.id, kind: 'agent' };
});
afterAll(async () => {
  delete process.env.APPS_DOMAIN;
  await close();
});

const BANK_INDEX = '<!doctype html><title>Bank login</title><form><input name="u"><input type="password" name="p"></form>';
const CALC_INDEX = '<!doctype html><title>Calculator</title><h1>Calculator</h1><input type="number">';

async function appWithVersion(slug: string, index: string) {
  const { id } = await createApp({ workspaceId: wsId, slug, actor });
  const v = await createVersion(id, [{ path: 'index.html', content: index }], {
    actor,
    compile: { status: 'ok' },
  });
  return { id, slug, versionId: v.id };
}

describe('publish heuristic', () => {
  it('flags the "bank login" app into the queue on publish (not blocked) — once while open', async () => {
    const a = await appWithVersion('bank-login', BANK_INDEX);
    const r = await publish(a.id, a.versionId, actor);
    expect(r.number).toBe(1);
    const [row] = await db.select().from(apps).where(eq(apps.id, a.id));
    expect(row.publishedVersionId).toBe(a.versionId); // published anyway
    const reports = await db.select().from(abuseReports).where(eq(abuseReports.appId, a.id));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reason: 'heuristic', status: 'open', host: 'bank-login.apps.example' });
    expect(reports[0].details).toMatch(/password field \(index\.html\).*"bank" \(title\)/);

    // A re-publish while the report is open does not pile up the queue.
    await publish(a.id, a.versionId, actor);
    expect(await db.select().from(abuseReports).where(eq(abuseReports.appId, a.id))).toHaveLength(1);
  });

  it('does not flag a calculator', async () => {
    const a = await appWithVersion('calculator', CALC_INDEX);
    await publish(a.id, a.versionId, actor);
    expect(await db.select().from(abuseReports).where(eq(abuseReports.appId, a.id))).toHaveLength(0);
  });
});

describe('abuse reports', () => {
  it('validates the form input', () => {
    expect(validateAbuseReport({ host: '', reason: 'phishing' })).toMatchObject({ ok: false, field: 'host' });
    expect(validateAbuseReport({ host: 'x.apps.example', reason: 'heuristic' })).toMatchObject({ ok: false, field: 'reason' });
    expect(validateAbuseReport({ host: 'x.apps.example', reason: 'spam', details: 'x'.repeat(2001) })).toMatchObject({
      ok: false,
      field: 'details',
    });
    expect(validateAbuseReport({ host: 'x.apps.example', reason: 'spam', reporterEmail: 'nope' })).toMatchObject({
      ok: false,
      field: 'reporterEmail',
    });
    expect(validateAbuseReport({ host: 'https://X.apps.example/a', reason: 'spam', reporterEmail: ' A@B.cz ' })).toEqual({
      ok: true,
      value: { host: 'x.apps.example', reason: 'spam', details: '', reporterEmail: 'a@b.cz' },
    });
  });

  it('resolves the host (prod, preview, version) to the app; unknown hosts are kept without an app', async () => {
    const a = await appWithVersion('reported-app', CALC_INDEX);
    expect((await findAppByReportedHost('reported-app.apps.example', HOSTS))?.id).toBe(a.id);
    expect((await findAppByReportedHost('reported-app--preview.apps.example', HOSTS))?.id).toBe(a.id);
    expect((await findAppByReportedHost('reported-app--v1.apps.example', HOSTS))?.id).toBe(a.id);
    expect(await findAppByReportedHost('drobek.example', HOSTS)).toBeNull();
    expect(await findAppByReportedHost('elsewhere.test', HOSTS)).toBeNull();

    const r = await createAbuseReport(
      { host: 'https://reported-app--preview.apps.example/', reason: 'phishing', details: 'fake bank', clientIp: '203.0.113.9' },
      { hosts: HOSTS }
    );
    expect(r.app?.id).toBe(a.id);
    const [row] = await db.select().from(abuseReports).where(eq(abuseReports.id, r.id));
    expect(row).toMatchObject({ appId: a.id, host: 'reported-app--preview.apps.example', reason: 'phishing', status: 'open' });
    expect(row.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(row.ipHash).not.toContain('203');
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'abuse.report'));
    expect(audit.at(-1)).toMatchObject({ target: 'reported-app', actorUserId: null, meta: { reportId: r.id, reason: 'phishing' } });

    const orphan = await createAbuseReport({ host: 'gone.apps.example', reason: 'spam' }, { hosts: HOSTS });
    expect(orphan.app).toBeNull();
    const open = await listAbuseReports();
    expect(open.map((x) => x.id)).toEqual(expect.arrayContaining([r.id, orphan.id]));
    expect(open.find((x) => x.id === r.id)?.app?.workspaceSlug).toBe('owner');

    expect(await resolveAbuseReport(orphan.id, adminId)).toBe(true);
    expect(await resolveAbuseReport(orphan.id, adminId)).toBe(false);
    const resolved = await listAbuseReports({ status: 'resolved' });
    expect(resolved.find((x) => x.id === orphan.id)?.resolvedByEmail).toBe('root@example.test');
  });
});

describe('takedown / restore', () => {
  it('unpublishes + locks, refuses every change with app_locked_by_admin, restore lifts it without republishing', async () => {
    const a = await appWithVersion('evil-bank', BANK_INDEX);
    await publish(a.id, a.versionId, actor, { screen: false });
    const report = await createAbuseReport({ host: 'evil-bank.apps.example', reason: 'phishing' }, { hosts: HOSTS });

    const events: AppChangedEvent[] = [];
    const off = onLocalAppChanged((e) => events.push(e));
    const out = await takedownApp({ appId: a.id, reason: 'phishing', actorUserId: adminId });
    off();
    expect(out).toMatchObject({ slug: 'evil-bank', unpublishedVersionId: a.versionId, alreadyLocked: false });
    expect(events).toEqual([{ app_id: a.id, slug: 'evil-bank', kind: 'settings' }]);

    const [row] = await db.select().from(apps).where(eq(apps.id, a.id));
    expect(row).toMatchObject({ lockedReason: 'phishing', publishedVersionId: null });
    expect(await appLockState(a.id)).toEqual({ locked: true, reason: 'phishing' });
    expect((await listLockedApps()).map((x) => x.slug)).toContain('evil-bank');
    const [rep] = await db.select().from(abuseReports).where(eq(abuseReports.id, report.id));
    expect(rep).toMatchObject({ status: 'resolved', resolvedBy: adminId });

    const refused = async (p: Promise<unknown>) => {
      const err = (await p.catch((e: unknown) => e)) as AppsError;
      expect(err).toBeInstanceOf(AppsError);
      expect(err.code).toBe('app_locked_by_admin');
      expect(err.reason).toBe('phishing');
      expect(err.message).toMatch(/reason: phishing/);
    };
    await refused(createVersion(a.id, [{ path: 'index.html', content: 'x' }], { actor }));
    await refused(publish(a.id, a.versionId, actor));
    await refused(restore(a.id, 1, actor));

    const takedownAudit = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.takedown'));
    expect(takedownAudit.at(-1)).toMatchObject({
      target: 'evil-bank',
      actorUserId: adminId,
      actorKind: 'user',
      meta: { reason: 'phishing', unpublishedVersionId: a.versionId, reportsResolved: 1 },
    });

    const restored = await restoreApp({ appId: a.id, actorUserId: adminId });
    expect(restored).toMatchObject({ wasLocked: true, reason: 'phishing' });
    const [after] = await db.select().from(apps).where(eq(apps.id, a.id));
    expect(after).toMatchObject({ lockedReason: null, publishedVersionId: null });
    const restoreAudit = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.restore'));
    expect(restoreAudit.at(-1)).toMatchObject({ target: 'evil-bank', actorUserId: adminId, meta: { reason: 'phishing' } });

    // Writable again; the owner republishes when ready.
    await expect(publish(a.id, a.versionId, actor, { screen: false })).resolves.toMatchObject({ number: 1 });
    expect(await restoreApp({ appId: a.id, actorUserId: adminId })).toMatchObject({ wasLocked: false });
  });

  it('refuses an unknown reason and an unknown app', async () => {
    const a = await appWithVersion('fine-app', CALC_INDEX);
    await expect(takedownApp({ appId: a.id, reason: 'because', actorUserId: adminId })).rejects.toMatchObject({
      code: 'invalid_reason',
    });
    await expect(takedownApp({ appId: 'nope', reason: 'spam', actorUserId: adminId })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
