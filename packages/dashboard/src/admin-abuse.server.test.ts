/**
 * /admin/abuse on a real PGlite database (the session is stubbed; the owner
 * e-mail is counted, not sent):
 *  - every listed app links to its dashboard overview and, when published,
 *    to its public address;
 *  - Take down is two steps: `?confirm=takedown` only reads (the panel names
 *    the app, workspace, reason and the effect on its addresses); a POST
 *    without `confirmed=1` changes nothing; a confirmed POST takes it down
 *    once, audited with the acting super-admin and the reason, one e-mail;
 *    a repeated (double) submit is refused with 409 and changes nothing more;
 *  - a non-super-admin gets 403 before anything is read or changed.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@drobek/db/schema';
import { abuseReports, appVersions, apps, auditLog, domains, setDbForTests, users, workspaces } from '@drobek/db';

const who = vi.hoisted(() => ({ user: { id: '', email: 'boss@example.com' } }));
const mails = vi.hoisted(() => ({ calls: [] as { kind: string; reason: string }[] }));

vi.mock('@drobek/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@drobek/auth')>()),
  requireSessionUser: async () => who.user,
}));

vi.mock('./abuse-mail.server.js', () => ({
  mailOwnersAboutModeration: async (input: { kind: string; reason: string }) => {
    mails.calls.push({ kind: input.kind, reason: input.reason });
  },
}));

const route = await import('./routes/admin.abuse.server.js');

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;
let bossId: string;
let appId: string;

type Loaded = {
  confirm: null | { appId: string; slug: string; name: string | null; workspaceSlug: string; workspaceName: string; appPath: string; publicUrl: string | null; reason: string; reasonLabel: string; effects: string[]; back: string };
  confirmError: string | null;
  reports: { app: null | { slug: string; appPath: string; publicUrl: string | null } }[];
  locked: { slug: string; appPath: string }[];
};

function result(res: unknown): { status: number; data: Record<string, unknown> } {
  const d = res as { data: Record<string, unknown>; init: { status?: number } | null };
  return { status: d.init?.status ?? 200, data: d.data };
}

const load = async (qs = '') =>
  result(await route.loader({ request: new Request(`https://drobek.example/admin/abuse${qs}`), params: {}, context: {} } as never))
    .data as unknown as Loaded;
const post = (body: Record<string, string>) =>
  route.action({
    request: new Request('https://drobek.example/admin/abuse', { method: 'POST', body: new URLSearchParams(body) }),
    params: {},
    context: {},
  } as never);

async function appRow() {
  return (await db.select().from(apps).where(eq(apps.id, appId)))[0];
}
async function takedowns() {
  return db.select().from(auditLog).where(and(eq(auditLog.action, 'admin.takedown'), eq(auditLog.target, 'fake-bank')));
}

beforeAll(async () => {
  vi.stubEnv('SUPERADMIN_EMAIL', 'boss@example.com');
  vi.stubEnv('APPS_DOMAIN', 'apps.example');
  vi.stubEnv('PUBLIC_APP_URL', 'https://drobek.example');
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL('../../db/drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: 'drizzle',
  });
  setDbForTests(db);
  const [boss] = await db.insert(users).values({ email: 'boss@example.com' }).returning();
  bossId = boss.id;
  who.user = { id: bossId, email: boss.email };
  const [w] = await db.insert(workspaces).values({ kind: 'team', slug: 'acme', name: 'Acme Corp' }).returning();
  const [a] = await db.insert(apps).values({ workspaceId: w.id, slug: 'fake-bank', name: 'Totally a bank', galleryListed: true }).returning();
  appId = a.id;
  const [v] = await db.insert(appVersions).values({ appId, number: 1, compileStatus: 'ok', actorKind: 'agent' }).returning();
  await db.update(apps).set({ publishedVersionId: v.id, publishedAt: new Date() }).where(eq(apps.id, appId));
  await db.insert(domains).values({ appId, hostname: 'login.bank.example', verificationToken: 't', verifiedAt: new Date() });
  await db.insert(abuseReports).values({ host: 'fake-bank.apps.example', reason: 'phishing', appId, ipHash: 'h' });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await pg.close();
});

describe('/admin/abuse', () => {
  it('links a reported app to its overview and its public address', async () => {
    const page = await load();
    expect(page.confirm).toBeNull();
    expect(page.reports[0].app).toMatchObject({
      slug: 'fake-bank',
      appPath: '/workspaces/acme/apps/fake-bank',
      publicUrl: expect.stringMatching(/^https?:\/\/fake-bank\.apps\.example$/),
    });
  });

  it('the confirm step names the app, workspace, reason and effects, and changes nothing', async () => {
    const page = await load(`?confirm=takedown&app=${appId}&reason=phishing&back=${encodeURIComponent('/admin/abuse?status=open')}`);
    expect(page.confirmError).toBeNull();
    expect(page.confirm).toMatchObject({
      appId,
      slug: 'fake-bank',
      name: 'Totally a bank',
      workspaceSlug: 'acme',
      workspaceName: 'Acme Corp',
      reason: 'phishing',
      back: '/admin/abuse?status=open',
    });
    const effects = page.confirm!.effects.join('\n');
    expect(effects).toContain('login.bank.example');
    expect(effects).toContain('451');
    expect(effects).toContain('1 open report');
    expect(effects).toContain('gallery');
    expect(effects).toContain('does not publish it again');
    expect((await appRow()).lockedReason).toBeNull();
    expect(await takedowns()).toHaveLength(0);
    expect(mails.calls).toHaveLength(0);
  });

  it('Cancel never leaves the moderation pages; an unknown reason or app shows why there is nothing to confirm', async () => {
    expect((await load(`?confirm=takedown&app=${appId}&reason=phishing&back=https://evil.example/`)).confirm?.back).toBe('/admin/abuse');
    expect((await load(`?confirm=takedown&app=${appId}&reason=phishing&back=//evil.example`)).confirm?.back).toBe('/admin/abuse');
    expect((await load(`?confirm=takedown&app=${appId}&reason=bogus`)).confirmError).toContain('Pick a takedown reason');
    expect((await load('?confirm=takedown&app=nope&reason=spam')).confirmError).toContain('no longer exists');
  });

  it('refuses a takedown that skipped the confirm step', async () => {
    const res = result(await post({ intent: 'takedown', appId, reason: 'phishing' }));
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Nothing was taken down');
    expect((await appRow()).lockedReason).toBeNull();
    expect((await appRow()).publishedVersionId).not.toBeNull();
    expect(await takedowns()).toHaveLength(0);
    expect(mails.calls).toHaveLength(0);
  });

  it('a confirmed takedown runs once; a double submit changes nothing more', async () => {
    const first = result(await post({ intent: 'takedown', appId, reason: 'phishing', confirmed: '1' }));
    expect(first.data).toMatchObject({ ok: true, message: 'fake-bank was taken down (phishing).' });
    const row = await appRow();
    expect(row.lockedReason).toBe('phishing');
    expect(row.publishedVersionId).toBeNull();
    const audit = await takedowns();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: bossId, actorKind: 'user', meta: expect.objectContaining({ reason: 'phishing', reportsResolved: 1 }) });
    expect(mails.calls).toEqual([{ kind: 'takedown', reason: 'phishing' }]);

    const again = result(await post({ intent: 'takedown', appId, reason: 'phishing', confirmed: '1' }));
    expect(again.status).toBe(409);
    expect(again.data.error).toBe('fake-bank is already taken down. Nothing changed.');
    expect(await takedowns()).toHaveLength(1);
    expect(mails.calls).toHaveLength(1);

    const page = await load(`?confirm=takedown&app=${appId}&reason=spam`);
    expect(page.confirm).toBeNull();
    expect(page.confirmError).toContain('already taken down');
    expect(page.locked).toEqual([expect.objectContaining({ slug: 'fake-bank', appPath: '/workspaces/acme/apps/fake-bank' })]);
  });

  it('restore stays one step and keeps working', async () => {
    const res = result(await post({ intent: 'restore', appId }));
    expect(res.data).toMatchObject({ ok: true });
    expect((await appRow()).lockedReason).toBeNull();
  });

  it('a non-super-admin gets 403 before anything changes', async () => {
    who.user = { id: 'someone', email: 'someone@example.com' };
    const err = await post({ intent: 'takedown', appId, reason: 'spam', confirmed: '1' }).then(
      () => null,
      (e: unknown) => e as { init?: { status?: number } }
    );
    expect(err?.init?.status).toBe(403);
    expect((await appRow()).lockedReason).toBeNull();
    who.user = { id: bossId, email: 'boss@example.com' };
  });
});
