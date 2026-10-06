/**
 * The webhooks module in the real module runtime over PGlite, with the real
 * data module: configure + confirm, the secret that follows the config, a
 * signed delivery stored in the collection (its rules and schema), the
 * delivery log for every refusal (signature, size, rate, duplicate,
 * collection), the owner's view, the daily prune, the password gate, the
 * skill — and no body or secret in any log line.
 */
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apps, setDbForTests, users, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { loadModuleRuntime, memoryMailGuard, memoryRateLimiter, setModuleSecret, type ModuleRuntime, type PlatformRequest } from '@drobek/modules';
import data, { dataRecords } from 'drobek-module-data';
import webhooks, {
  DELIVERIES_KEPT_PER_APP,
  claimEvent,
  pruneDeliveries,
  webhookDeliveries,
  webhookEvents,
  webhooksConfigSchema,
  webhooksConfirmRequired,
  webhooksSecrets,
} from './index.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const SECRET = ['signing', 'value', 'for', 'tests', String(process.pid)].join('-');
const MARKER = `payload-marker-${process.pid}`;

let pg: PGlite;
let db: DB;
let userId: string;
let workspaceId: string;
let app: { id: string; slug: string; workspaceId: string; workspaceSlug: string };
let rt: ModuleRuntime;
let logs: ReturnType<typeof logger>;

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function envWith(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    APPS_DOMAIN: 'apps.localhost',
    PUBLIC_APP_URL: 'http://localhost:3041',
    DROBEK_MIGRATE_ON_START: '0',
    DROBEK_MASTER_KEY: 'cd'.repeat(32),
    ...extra,
  } as NodeJS.ProcessEnv;
}

beforeAll(async () => {
  process.env.APPS_DOMAIN = 'apps.localhost';
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: data.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_data', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: webhooks.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_webhooks', migrationsSchema: 'drizzle' });
  db = d as unknown as DB;
  setDbForTests(db);
  const [u] = await d.insert(users).values({ email: 'owner@example.com' }).returning();
  userId = u.id;
  const [w] = await d.insert(workspaces).values({ kind: 'team', slug: 'hooks-ws', name: 'Hooks' }).returning();
  workspaceId = w.id;
});

afterAll(async () => {
  setDbForTests(null as never);
  await pg.close();
});

async function runtime(extra: Record<string, string> = {}): Promise<ModuleRuntime> {
  const env = envWith(extra);
  logs = logger();
  return loadModuleRuntime({
    env,
    log: logs,
    modules: [data, webhooks],
    skillsDir: null,
    deps: {
      db: () => db,
      rateLimit: memoryRateLimiter(),
      principal: async () => ({ kind: 'anon' }),
      email: { send: async () => {} },
      mailGuard: memoryMailGuard({ hourlyMax: 100, pauseMinutes: 1 }, logs),
      requestStats: () => undefined,
    },
  });
}

let appCounter = 0;

async function configure(module: string, patch: unknown) {
  const r = await rt.configure({ app, module, patch, actorUserId: userId });
  if (r.pending_confirmation.length > 0) await rt.confirm({ app, module, userId, role: 'editor' });
  return r;
}

/** A fresh app with the `payments` collection and (optionally) an endpoint `payments`, its secret set. */
async function freshApp(endpoint?: Record<string, unknown>, opts: { secret?: boolean; collectionSchema?: unknown } = {}) {
  appCounter++;
  const [a] = await db.insert(apps).values({ workspaceId, slug: `shop-${appCounter}`, name: 'Shop' }).returning();
  app = { id: a.id, slug: a.slug, workspaceId, workspaceSlug: 'hooks-ws' };
  await configure('data', {
    collections: {
      payments: {
        rules: { read: 'admin', create: 'none', update: 'none', delete: 'admin' },
        ...(opts.collectionSchema ? { schema: opts.collectionSchema } : {}),
      },
    },
  });
  if (endpoint) {
    await configure('webhooks', { endpoints: { payments: { collection: 'payments', ...endpoint } } });
    if (opts.secret !== false) await setModuleSecret({ appId: app.id, module: 'webhooks', name: 'WEBHOOK_SECRET_PAYMENTS', value: SECRET, env: envWith() });
  }
}

function post(endpoint: string, body: string | Buffer, headers: Record<string, string> = {}, query = ''): Promise<{ status: number; json: Record<string, unknown> }> {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h: Record<string, string> = { host: `${app.slug}.apps.localhost`, 'content-type': 'application/json', ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  const req: PlatformRequest = {
    method: 'POST',
    path: `/__drobek/v1/webhooks/${endpoint}`,
    query,
    header: (n) => h[n.toLowerCase()] ?? null,
    headers: () => h,
    clientIp: '203.0.113.7',
    readBody: async (limit) => (raw.length > limit ? 'too_large' : raw),
  };
  return rt.handle(req, { id: app.id, slug: app.slug, workspaceId }).then((res) => ({
    status: res.status,
    json: res.body ? (JSON.parse(String(res.body)) as Record<string, unknown>) : {},
  }));
}

const sign = (body: string, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');

async function stored() {
  const rows = await db.select().from(dataRecords).where(and(eq(dataRecords.appId, app.id), eq(dataRecords.collection, 'payments'))).orderBy(asc(dataRecords.createdAt));
  return rows.map((r) => r.doc as Record<string, unknown>);
}

async function deliveries() {
  const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.appId, app.id)).orderBy(asc(webhookDeliveries.receivedAt));
  return rows.map((r) => ({ status: r.status, http: r.httpStatus, reason: r.reason }));
}

beforeEach(async () => {
  rt = await runtime();
});

describe('config', () => {
  it('a new endpoint, another collection and a weaker verification wait; the rest applies at once', () => {
    const empty = webhooksConfigSchema.parse({});
    const one = webhooksConfigSchema.parse({ endpoints: { payments: { collection: 'payments', verify: 'stripe' } } });
    expect(webhooksConfirmRequired(empty, one)).toEqual([
      'webhooks.endpoints.payments: new endpoint — POST /__drobek/v1/webhooks/payments, verified by a stripe signature with WEBHOOK_SECRET_PAYMENTS, stores every delivery in the collection "payments"',
    ]);
    const moved = webhooksConfigSchema.parse({ endpoints: { payments: { collection: 'orders', verify: 'none-with-token' } } });
    expect(webhooksConfirmRequired(one, moved)).toEqual([
      'webhooks.endpoints.payments: collection changed — deliveries now go to "orders" (was "payments")',
      'webhooks.endpoints.payments: verification weakened — stripe → none-with-token (a shared token (no signature))',
    ]);
    const stronger = webhooksConfigSchema.parse({ endpoints: { payments: { collection: 'orders', verify: 'github', header: 'X-Sig', enabled: false, max_bytes: 1000 } } });
    expect(webhooksConfirmRequired(moved, stronger)).toEqual([]);
    expect(webhooksConfirmRequired(one, empty)).toEqual([]);
  });

  it('refuses bad names, schemes, headers, secrets and sizes', () => {
    for (const bad of [
      { endpoints: { Payments: { collection: 'p' } } },
      { endpoints: { p: { collection: 'p', verify: 'md5' } } },
      { endpoints: { p: { collection: 'p', header: 'X Bad' } } },
      { endpoints: { p: { collection: 'p', secret: 'lower' } } },
      { endpoints: { p: { collection: 'p', max_bytes: 2 * 1024 * 1024 } } },
      { endpoints: { p: {} } },
    ]) {
      expect(webhooksConfigSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('every endpoint has a required secret, named after it unless it names one', () => {
    const c = webhooksConfigSchema.parse({ endpoints: { 'git-hub': { collection: 'a' }, b: { collection: 'a', secret: 'SHARED' }, c: { collection: 'a', secret: 'SHARED' } } });
    expect(webhooksSecrets(c).map((s) => [s.name, s.required])).toEqual([
      ['SHARED', true],
      ['WEBHOOK_SECRET_GIT_HUB', true],
    ]);
    expect(webhooksSecrets(c)[0].description).toContain('"b", "c"');
  });

  it('configure: a new endpoint waits, names its missing secret, and is refused past WEBHOOKS_MAX_ENDPOINTS_PER_APP', async () => {
    await freshApp();
    const r = await rt.configure({ app, module: 'webhooks', patch: { endpoints: { payments: { collection: 'payments' } } }, actorUserId: userId });
    expect(r.applied).toBe(false);
    expect(r.pending_confirmation).toHaveLength(1);
    expect(r.secrets_missing).toEqual(['WEBHOOK_SECRET_PAYMENTS']);
    await rt.confirm({ app, module: 'webhooks', userId, role: 'editor' });
    const view = await rt.moduleView(app, 'webhooks');
    expect(view.secrets).toEqual([expect.objectContaining({ name: 'WEBHOOK_SECRET_PAYMENTS', required: true, hasSecret: false })]);

    rt = await runtime({ WEBHOOKS_MAX_ENDPOINTS_PER_APP: '1' });
    await expect(rt.configure({ app, module: 'webhooks', patch: { endpoints: { second: { collection: 'payments' } } }, actorUserId: userId })).rejects.toMatchObject({
      code: 'invalid_params',
      details: { limit: 'WEBHOOKS_MAX_ENDPOINTS_PER_APP', value: 1 },
    });
  });

  it('a secret still stored after its endpoint was removed is listed so the owner can remove it', async () => {
    await freshApp({});
    await configure('webhooks', { endpoints: { payments: null } });
    const view = await rt.moduleView(app, 'webhooks');
    expect(view.secrets).toEqual([expect.objectContaining({ name: 'WEBHOOK_SECRET_PAYMENTS', required: false, hasSecret: true })]);
    const state = (await rt.appModules(app)).webhooks;
    expect(state.secrets).toEqual([{ name: 'WEBHOOK_SECRET_PAYMENTS', hasSecret: true }]);
  });
});

describe('deliveries', () => {
  it('a signed delivery is stored in the collection as { source, event_type, event_id, received_at, payload }', async () => {
    await freshApp({});
    const body = JSON.stringify({ type: 'payment.succeeded', amount: 1200, note: MARKER });
    const res = await post('payments', body, { 'X-Webhook-Signature': `sha256=${sign(body)}`, 'Webhook-Id': 'msg_1' });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, id: expect.any(String) });
    const [doc] = await stored();
    expect(doc).toEqual({
      source: 'payments',
      event_type: 'payment.succeeded',
      event_id: 'msg_1',
      received_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      payload: { type: 'payment.succeeded', amount: 1200, note: MARKER },
    });
    const rows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.appId, app.id));
    expect(rows).toEqual([expect.objectContaining({ endpoint: 'payments', status: 'accepted', httpStatus: 200, bytes: Buffer.byteLength(body), recordId: res.json.id })]);
  });

  it('a bad or missing signature is 401 and logged; nothing is stored', async () => {
    await freshApp({});
    const body = JSON.stringify({ note: MARKER });
    const bad = await post('payments', body, { 'X-Webhook-Signature': sign(body, 'another-secret') });
    expect(bad.status).toBe(401);
    expect(bad.json).toMatchObject({ error: 'invalid_signature', details: { reason: 'bad_signature' } });
    expect((await post('payments', body)).json).toMatchObject({ error: 'invalid_signature', details: { reason: 'missing_signature' } });
    const tampered = await post('payments', `${body} `, { 'X-Webhook-Signature': sign(body) });
    expect(tampered.status).toBe(401);
    expect(await stored()).toEqual([]);
    expect(await deliveries()).toEqual([
      { status: 'rejected_signature', http: 401, reason: 'bad_signature' },
      { status: 'rejected_signature', http: 401, reason: 'missing_signature' },
      { status: 'rejected_signature', http: 401, reason: 'bad_signature' },
    ]);
  });

  it('without its secret the endpoint answers 503 so the sender retries', async () => {
    await freshApp({}, { secret: false });
    const res = await post('payments', '{}', { 'X-Webhook-Signature': sign('{}') });
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ error: 'webhook_secret_not_set', details: { secret: 'WEBHOOK_SECRET_PAYMENTS' } });
    expect(await deliveries()).toEqual([{ status: 'rejected_signature', http: 503, reason: 'secret_not_set' }]);
  });

  it('a retried event id is stored once; the answer stays 2xx', async () => {
    await freshApp({});
    const body = JSON.stringify({ n: 1 });
    const headers = { 'X-Webhook-Signature': sign(body), 'Webhook-Id': 'msg_dup' };
    expect((await post('payments', body, headers)).status).toBe(200);
    const again = await post('payments', body, headers);
    expect(again).toEqual({ status: 200, json: { ok: true, duplicate: true } });
    expect(await stored()).toHaveLength(1);
    expect((await deliveries()).map((d) => d.status)).toEqual(['accepted', 'duplicate']);
  });

  it('stripe: the body id dedupes, a replayed timestamp is refused', async () => {
    await freshApp({ verify: 'stripe' });
    const body = JSON.stringify({ id: 'evt_1', type: 'charge.succeeded' });
    const t = Math.floor(Date.now() / 1000);
    const header = (ts: number) => `t=${ts},v1=${createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`;
    expect((await post('payments', body, { 'Stripe-Signature': header(t) })).status).toBe(200);
    expect((await post('payments', body, { 'Stripe-Signature': header(t) })).json).toEqual({ ok: true, duplicate: true });
    const old = await post('payments', body, { 'Stripe-Signature': header(t - 3600) });
    expect(old.json).toMatchObject({ error: 'invalid_signature', details: { reason: 'timestamp_out_of_tolerance' } });
    const [doc] = await stored();
    expect(doc).toMatchObject({ event_id: 'evt_1', event_type: 'charge.succeeded' });
  });

  it('github and none-with-token deliveries', async () => {
    await freshApp({ verify: 'github' });
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const ok = await post('payments', body, { 'X-Hub-Signature-256': `sha256=${sign(body)}`, 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'g-1' });
    expect(ok.status).toBe(200);
    expect((await stored())[0]).toMatchObject({ event_type: 'push', event_id: 'g-1' });

    await freshApp({ verify: 'none-with-token' });
    expect((await post('payments', 'a=1', { 'content-type': 'application/x-www-form-urlencoded' }, `token=${encodeURIComponent(SECRET)}`)).status).toBe(200);
    expect((await post('payments', 'a=1', { 'X-Webhook-Token': 'wrong' })).status).toBe(401);
    expect((await stored())[0]).toMatchObject({ payload: { a: '1' } });
  });

  it('a body over the endpoint max_bytes is 413 too_large; an unknown or disabled endpoint is 404 and not logged', async () => {
    await freshApp({ max_bytes: 10 });
    const body = JSON.stringify({ long: 'x'.repeat(20) });
    const res = await post('payments', body, { 'X-Webhook-Signature': sign(body) });
    expect(res.status).toBe(413);
    expect(res.json).toMatchObject({ error: 'payload_too_large', details: { limit: 'max_bytes', value: 10 } });
    expect((await post('nope', '{}')).status).toBe(404);
    await configure('webhooks', { endpoints: { payments: { enabled: false } } });
    expect((await post('payments', '{}', { 'X-Webhook-Signature': sign('{}') })).status).toBe(404);
    expect(await deliveries()).toEqual([{ status: 'too_large', http: 413, reason: 'too_large' }]);
  });

  it('WEBHOOKS_MAX_BODY_BYTES caps every endpoint', async () => {
    rt = await runtime({ WEBHOOKS_MAX_BODY_BYTES: '16' });
    await freshApp({ max_bytes: 1000 });
    const body = JSON.stringify({ long: 'x'.repeat(20) });
    expect((await post('payments', body, { 'X-Webhook-Signature': sign(body) })).json).toMatchObject({ details: { limit: 'WEBHOOKS_MAX_BODY_BYTES', value: 16 } });
  });

  it('past WEBHOOKS_PER_APP_PER_MINUTE: 429, and one log row per window', async () => {
    rt = await runtime({ WEBHOOKS_PER_APP_PER_MINUTE: '2' });
    await freshApp({});
    const h = { 'X-Webhook-Signature': sign('{}') };
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await post('payments', '{}', h)).status);
    expect(statuses).toEqual([200, 200, 429, 429, 429]);
    expect((await deliveries()).map((d) => d.status)).toEqual(['accepted', 'accepted', 'rate_limited']);
  });

  it('a record the collection schema refuses is collection_error (503); the event id is released so the retry lands', async () => {
    await freshApp({}, { collectionSchema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } } });
    const body = JSON.stringify({ amount: 5 });
    const headers = { 'X-Webhook-Signature': sign(body), 'Webhook-Id': 'msg_retry' };
    const first = await post('payments', body, headers);
    expect(first.status).toBe(503);
    expect(first.json).toMatchObject({ error: 'webhook_not_stored', details: { reason: 'validation_failed', collection: 'payments' } });
    await configure('data', { collections: { payments: { schema: null } } });
    expect((await post('payments', body, headers)).status).toBe(200);
    expect((await deliveries()).map((d) => [d.status, d.reason])).toEqual([
      ['collection_error', 'validation_failed'],
      ['accepted', null],
    ]);
  });

  it('an undeclared collection is collection_error not_found', async () => {
    await freshApp({});
    await configure('webhooks', { endpoints: { payments: { collection: 'missing' } } });
    const res = await post('payments', '{}', { 'X-Webhook-Signature': sign('{}') });
    expect(res.json).toMatchObject({ error: 'webhook_not_stored', details: { reason: 'not_found' } });
  });

  it('logs never carry the body, a signature or the secret', async () => {
    await freshApp({});
    const body = JSON.stringify({ note: MARKER });
    await post('payments', body, { 'X-Webhook-Signature': sign(body) });
    await post('payments', body, { 'X-Webhook-Signature': sign(body, 'x') });
    const all = JSON.stringify([logs.info.mock.calls, logs.warn.mock.calls, logs.error.mock.calls, await db.select().from(webhookDeliveries)]);
    expect(all).toContain('webhooks_delivery');
    expect(all).not.toContain(MARKER);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(sign(body));
  });

  it('the route skips the password gate; nothing else does', () => {
    expect(rt.skipsPasswordGate('POST', '/__drobek/v1/webhooks/payments')).toBe(true);
    expect(rt.skipsPasswordGate('GET', '/__drobek/v1/webhooks/payments')).toBe(false);
    expect(rt.skipsPasswordGate('POST', '/__drobek/v1/data/payments')).toBe(false);
    expect(rt.skipsPasswordGate('POST', '/__drobek/sdk.js')).toBe(false);
  });
});

describe('the owner view', () => {
  it('endpoints with their URL and last delivery, deliveries newest first; get_app info', async () => {
    await freshApp({});
    await post('payments', '{}', { 'X-Webhook-Signature': sign('{}') });
    await post('payments', '{}', { 'X-Webhook-Signature': 'bad' });
    const w = (await rt.webhooks(app))!;
    expect(w.module).toBe('webhooks');
    expect(await w.endpoints()).toEqual([
      {
        name: 'payments',
        url: `http://${app.slug}.apps.localhost/__drobek/v1/webhooks/payments`,
        collection: 'payments',
        verify: 'hmac-sha256',
        signed: true,
        secret: 'WEBHOOK_SECRET_PAYMENTS',
        enabled: true,
        last_delivery_at: expect.any(String),
        last_status: 'rejected_signature',
      },
    ]);
    const list = await w.deliveries({ limit: 10 });
    expect(list.map((d) => d.status)).toEqual(['rejected_signature', 'accepted']);
    expect(await w.deliveries({ endpoint: 'other' })).toEqual([]);
    const info = (await rt.appModules(app)).webhooks.info as { endpoints: { name: string; url: string }[] };
    expect(info.endpoints[0]).toMatchObject({ name: 'payments', url: expect.stringContaining('/__drobek/v1/webhooks/payments') });
  });
});

describe('prune', () => {
  it('removes deliveries past 30 days and past the per-app cap, and expired event ids', async () => {
    await freshApp({});
    const now = new Date();
    const old = new Date(now.getTime() - 31 * 86_400_000);
    await db.insert(webhookDeliveries).values({ id: `old-${appCounter}`, appId: app.id, endpoint: 'payments', status: 'accepted', httpStatus: 200, bytes: 1, receivedAt: old });
    const many = Array.from({ length: DELIVERIES_KEPT_PER_APP + 2 }, (_, i) => ({
      id: `n-${appCounter}-${i}`,
      appId: app.id,
      endpoint: 'payments',
      status: 'accepted' as const,
      httpStatus: 200,
      bytes: 1,
      receivedAt: new Date(now.getTime() - i * 1000),
    }));
    await db.insert(webhookDeliveries).values(many);
    await db.insert(webhookEvents).values({ appId: app.id, endpoint: 'payments', eventId: 'gone', expiresAt: old });
    expect(await claimEvent(db, { appId: app.id, endpoint: 'payments', eventId: 'kept' })).toBe(true);
    const out = await pruneDeliveries(db, now);
    expect(out).toEqual({ deliveries: 3, events: 1 });
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.appId, app.id))).toHaveLength(DELIVERIES_KEPT_PER_APP);
    expect((await db.select().from(webhookEvents).where(eq(webhookEvents.appId, app.id))).map((e) => e.eventId)).toEqual(['kept']);
  });

  it('an expired event id can be claimed again', async () => {
    await freshApp({});
    const past = new Date(Date.now() - 8 * 86_400_000);
    expect(await claimEvent(db, { appId: app.id, endpoint: 'payments', eventId: 'e1', now: past })).toBe(true);
    expect(await claimEvent(db, { appId: app.id, endpoint: 'payments', eventId: 'e1', now: past })).toBe(false);
    expect(await claimEvent(db, { appId: app.id, endpoint: 'payments', eventId: 'e1' })).toBe(true);
  });
});

describe('the module', () => {
  it('declares its job, limits, errors and a skill within the format', () => {
    expect(webhooks.jobs?.map((j) => [j.name, j.scope, j.every])).toEqual([['prune', 'server', '1d']]);
    expect(webhooks.limits?.map((l) => l.env)).toEqual(['WEBHOOKS_MAX_BODY_BYTES', 'WEBHOOKS_PER_APP_PER_MINUTE', 'WEBHOOKS_MAX_ENDPOINTS_PER_APP']);
    expect(webhooks.errors?.map((e) => e.code)).toEqual(['invalid_signature', 'webhook_secret_not_set', 'webhook_not_stored']);
    const md = webhooks.skill.markdown;
    expect(md.split('\n').length).toBeLessThanOrEqual(150);
    expect(md).toContain('## 5. Errors → fix');
  });
});
