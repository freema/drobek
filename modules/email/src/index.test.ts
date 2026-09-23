/**
 * The email module under createModuleTestContext(): real routes through the
 * production pipeline; its own `mail.prepare` runs for every send exactly as
 * core runs it (limits, envelope). PGlite with the core migrations for the
 * app name.
 */
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apps, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { buildSdk, isDefinedModule, loadModules } from '@drobek/modules';
import { createModuleTestContext } from '@drobek/modules/testing';
import { noopLogger } from '@drobek/core';
import email, { EMAIL_CONFIG_DEFAULTS, emailConfigSchema, emailConfirmRequired, prepareMail } from './index.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const HOST = 'stock--preview.apps.localhost';
const USER = { kind: 'user', id: 'eu_1', email: 'ana@example.com', role: 'user' } as const;

let pg: PGlite;
let db: DB;
let appId: string;
let workspaceId: string;

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  const [ws] = await d.insert(workspaces).values({ kind: 'team', slug: 'email-ws', name: 'Email' }).returning();
  workspaceId = ws.id;
  const [app] = await d.insert(apps).values({ workspaceId: ws.id, slug: 'stock', name: 'Stock\r\nBcc: evil@example.com list' }).returning();
  appId = app.id;
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
});

function ctx(opts: { config?: Record<string, unknown>; limits?: Record<string, number>; owners?: string[] } = {}) {
  return createModuleTestContext(email, {
    db,
    app: { id: appId, slug: 'stock', workspaceId },
    config: opts.config,
    limits: opts.limits,
    owners: opts.owners ?? ['owner@example.com', 'editor@example.com'],
    origin: `http://${HOST}`,
  });
}

describe('drobek-module-email — shape and config', () => {
  it('is a defined module the registry accepts by its short name; it owns app e-mail', async () => {
    expect(isDefinedModule(email)).toBe(true);
    expect(typeof email.mail?.prepare).toBe('function');
    const mods = await loadModules({ DROBEK_MODULES: 'email' }, { importer: async (pkg) => (pkg === 'drobek-module-email' ? { default: email } : null) });
    expect(mods.map((m) => m.name)).toEqual(['email']);
    const sdk = await buildSdk([email]);
    expect(sdk.js.toString()).toContain('/notify-admins');
    expect(sdk.dts).toContain('notifyAdmins(subject: string, text: string): Promise<{ sent: number }>');
  });

  it('config: fromName one plain line, replyTo an address; a new replyTo waits for the owner', () => {
    expect(emailConfigSchema.parse(EMAIL_CONFIG_DEFAULTS)).toEqual({});
    expect(emailConfigSchema.parse({ fromName: ' Acme bakery ', replyTo: ' Orders@Acme.example ' })).toEqual({
      fromName: 'Acme bakery',
      replyTo: 'orders@acme.example',
    });
    for (const bad of ['Acme\r\nBcc: x@y.cz', 'PayPal <security@paypal.com>', '"quoted"', 'x'.repeat(61), '']) {
      expect(emailConfigSchema.safeParse({ fromName: bad }).success, bad).toBe(false);
    }
    expect(emailConfigSchema.safeParse({ replyTo: 'nope' }).success).toBe(false);
    expect(emailConfigSchema.safeParse({ to: 'x@y.cz' }).success).toBe(false); // no recipients in config
    expect(emailConfirmRequired({}, { fromName: 'A' })).toEqual([]);
    expect(emailConfirmRequired({}, { replyTo: 'a@b.cz' })).toEqual(['replyTo: (none) → a@b.cz (replies to this app\'s e-mails go there)']);
    expect(emailConfirmRequired({ replyTo: 'a@b.cz' }, { replyTo: 'a@b.cz', fromName: 'X' })).toEqual([]);
    expect(emailConfirmRequired({ replyTo: 'a@b.cz' }, {})).toEqual([]);
  });
});

describe('notify-admins', () => {
  it('anonymous → 401, nothing sent', async () => {
    const t = ctx();
    const r = await t.request('POST', '/notify-admins', { body: { subject: 'Hi', text: 'x' } });
    expect(r.status).toBe(401);
    expect(t.emails).toHaveLength(0);
  });

  it('a signed-in user e-mails the app owners (never a caller-chosen address); the envelope from the config', async () => {
    const t = ctx({ config: { fromName: 'Stock app' } });
    t.setPrincipal(USER);
    const r = await t.request('POST', '/notify-admins', { body: { subject: 'Low stock', text: 'Only 2 left.\n<b>hurry</b>' }, headers: { host: HOST } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ sent: 2 });
    expect(t.emails).toHaveLength(1);
    const [m] = t.emails;
    expect(m.to).toEqual(['owner@example.com', 'editor@example.com']);
    expect(m.kind).toBe('notification');
    expect(m.fromName).toBe('Stock app');
    expect(m.subject).toBe('[Stock Bcc: evil@example.com list] Low stock');
    expect(m.text).toContain('Only 2 left.\n<b>hurry</b>');
    expect(m.text).toContain(`by its signed-in user ${USER.email}`);
    expect(m.text).toContain(`(${HOST})`);
    // Extra fields (a "to") are refused by the strict body.
    const extra = await t.request('POST', '/notify-admins', { body: { subject: 'x', text: 'y', to: 'victim@example.com' } });
    expect(extra.status).toBe(400);
    expect(extra.body).toMatchObject({ error: 'invalid_request' });
  });

  it('empty / oversized input → 400 with paths', async () => {
    const t = ctx();
    t.setPrincipal(USER);
    const r = await t.request('POST', '/notify-admins', { body: { subject: ' ', text: 'x'.repeat(5001) } });
    expect(r.status).toBe(400);
    expect((r.body as { details: { path: string }[] }).details.map((d) => d.path).sort()).toEqual(['subject', 'text']);
  });

  it('the 21st call of the day → 429 limit_exceeded (EMAIL_NOTIFY_ADMINS_PER_DAY)', async () => {
    const t = ctx({ limits: { EMAIL_PER_APP_PER_DAY: 1000 } });
    t.setPrincipal(USER);
    for (let i = 0; i < 20; i++) {
      const ok = await t.request('POST', '/notify-admins', { body: { subject: `n${i}`, text: 'x' } });
      expect(ok.status, `call ${i + 1}`).toBe(200);
    }
    const over = await t.request('POST', '/notify-admins', { body: { subject: 'n21', text: 'x' } });
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: 'limit_exceeded', details: { limit: 'EMAIL_NOTIFY_ADMINS_PER_DAY', value: 20 } });
    expect(Number(over.headers['Retry-After'])).toBeGreaterThan(0);
    expect(t.emails).toHaveLength(20);
  });

  it('EMAIL_PER_APP_PER_DAY refuses notifications past the app limit', async () => {
    const t = ctx({ limits: { EMAIL_PER_APP_PER_DAY: 1 } });
    t.setPrincipal(USER);
    expect((await t.request('POST', '/notify-admins', { body: { subject: 'a', text: 'x' } })).status).toBe(200);
    const over = await t.request('POST', '/notify-admins', { body: { subject: 'b', text: 'x' } });
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: 'limit_exceeded', details: { limit: 'EMAIL_PER_APP_PER_DAY' } });
  });
});

describe('mail.prepare (what core runs for every module e-mail)', () => {
  it('counts notifications only; sign-in codes pass; envelope from the config', async () => {
    const counts = new Map<string, number>();
    const input = (kind: 'sign_in' | 'notification') => ({
      app: { id: 'app_1', slug: 's', workspaceId: 'w' },
      module: 'forms',
      kind,
      recipients: 1,
      config: { fromName: 'Shop', replyTo: 'r@shop.example' },
      limits: { EMAIL_PER_APP_PER_DAY: 2 },
      rateLimit: async (bucket: string, key: string, max: number) => {
        const n = (counts.get(`${bucket}:${key}`) ?? 0) + 1;
        counts.set(`${bucket}:${key}`, n);
        return { ok: n <= max, count: n, retryAfterSec: 60 };
      },
      log: noopLogger,
    });
    for (let i = 0; i < 5; i++) await expect(prepareMail(input('sign_in'))).resolves.toEqual({ fromName: 'Shop', replyTo: 'r@shop.example' });
    await prepareMail(input('notification'));
    await prepareMail(input('notification'));
    await expect(prepareMail(input('notification'))).rejects.toMatchObject({ code: 'limit_exceeded', headers: { 'Retry-After': '60' } });
    expect(await prepareMail({ ...input('sign_in'), config: {} })).toEqual({});
  });
});
