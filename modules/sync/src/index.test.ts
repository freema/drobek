/**
 * The sync module in the real module runtime over PGlite, with the real proxy
 * and data modules and a local HTTP server as the upstream (allowed through
 * the test env like the proxy module's own test): configure + confirm, the
 * scheduled pass, Run now, failures → backoff → pause → resume, the limits,
 * the audit rows, and the secret that never leaves the forward path.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apps, auditLog, setDbForTests, upstreamSecrets, upstreams, users, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { loadModuleRuntime, memoryMailGuard, memoryRateLimiter, type AppJobContext, type ModuleRuntime } from '@drobek/modules';
import { encryptSecret } from '@drobek/proxy';
import data, { dataRecords } from 'drobek-module-data';
import { createProxyModule } from 'drobek-module-proxy';
import sync, { backoffMs, pickRecords, runDueSources, syncConfigSchema, syncRuns, syncSources, type SyncConfig } from './index.js';

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
const SECRET = 'sk-sync-THIS-MUST-NEVER-LEAK-0123456789';

let pg: PGlite;
let db: DB;
let server: http.Server;
let port: number;
let userId: string;
let workspaceId: string;
let app: { id: string; slug: string; workspaceId: string; workspaceSlug: string };
let rt: ModuleRuntime;

/** What the fake upstream answers on /players (tests change it). */
let players: unknown = { response: [] };
let playersStatus = 200;
let lastAuth: string | undefined;
let calls = 0;

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    calls++;
    lastAuth = req.headers.authorization;
    if (url.pathname === '/players') {
      res.writeHead(playersStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify(players));
      return;
    }
    if (url.pathname === '/leak') {
      // A misbehaving upstream that echoes the credential in an error body.
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`bad token ${req.headers.authorization ?? ''}`);
      return;
    }
    if (url.pathname === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html>${req.headers.authorization ?? ''}</html>`);
      return;
    }
    if (url.pathname === '/big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ response: Array.from({ length: 50 }, (_, i) => ({ id: i, name: 'x'.repeat(100), points: i })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: data.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_data', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: sync.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_sync', migrationsSchema: 'drizzle' });
  db = d as unknown as DB;
  setDbForTests(db);
  const [u] = await d.insert(users).values({ email: 'owner@example.com' }).returning();
  userId = u.id;
  const [w] = await d.insert(workspaces).values({ kind: 'team', slug: 'sync-ws', name: 'Sync' }).returning();
  workspaceId = w.id;
});

afterAll(async () => {
  setDbForTests(null as never);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pg.close();
});

function envWith(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    APPS_DOMAIN: 'apps.localhost',
    PUBLIC_APP_URL: 'http://localhost:3041',
    DROBEK_MIGRATE_ON_START: '0',
    DROBEK_MASTER_KEY: 'ab'.repeat(32),
    PROXY_ALLOWED_HOSTS: '127.0.0.1',
    PROXY_ALLOWED_PORTS: String(port),
    SYNC_PAUSE_AFTER_FAILURES: '2',
    ...extra,
  } as NodeJS.ProcessEnv;
}

async function runtime(extra: Record<string, string> = {}): Promise<ModuleRuntime> {
  const env = envWith(extra);
  const l = log();
  return loadModuleRuntime({
    env,
    log: l,
    modules: [createProxyModule({ env: () => env }), data, sync],
    skillsDir: null,
    deps: {
      db: () => db,
      rateLimit: memoryRateLimiter(),
      principal: async () => ({ kind: 'anon' }),
      email: { send: async () => {} },
      mailGuard: memoryMailGuard({ hourlyMax: 100, pauseMinutes: 1 }, l),
      requestStats: () => undefined,
    },
  });
}

let appCounter = 0;

/** A fresh app with the upstream assigned, the players collection and (optionally) a source. */
async function freshApp(source?: Record<string, unknown>) {
  appCounter++;
  const [a] = await db.insert(apps).values({ workspaceId, slug: `league-${appCounter}`, name: 'League' }).returning();
  app = { id: a.id, slug: a.slug, workspaceId, workspaceSlug: 'sync-ws' };
  // Local upstreams are inserted directly: registration refuses 127.0.0.1 by design.
  const name = `sportsapi${appCounter}`;
  const [up] = await db
    .insert(upstreams)
    .values({
      workspaceId,
      name,
      baseUrl: `http://127.0.0.1:${port}`,
      allowedMethods: ['GET', 'POST'],
      allowedPathPrefixes: ['/'],
      authType: 'bearer',
      createdBy: userId,
      allowedAppIds: [a.id],
    })
    .returning();
  await db.insert(upstreamSecrets).values({ upstreamId: up.id, ...encryptSecret(SECRET, envWith()) });
  await configure('proxy', { upstreams: { [name]: { rules: { call: 'none' } } } });
  await configure('data', {
    collections: {
      players: {
        rules: { read: 'public', create: 'none', update: 'none', delete: 'none' },
        schema: { type: 'object', required: ['id', 'name', 'points'], properties: { id: { type: 'integer' }, name: { type: 'string' }, points: { type: 'number' } } },
      },
    },
  });
  if (source) await configure('sync', { sources: { players: { upstream: name, path: '/players', items: 'response', ...source } } });
  return name;
}

async function configure(module: string, patch: unknown, surface: 'mcp' | 'web' = 'mcp') {
  const r = await rt.configure({ app, module, patch, actorUserId: userId, surface });
  if (r.pending_confirmation.length > 0) await rt.confirm({ app, module, userId, role: 'admin' });
  return r;
}

async function jobCtx(): Promise<AppJobContext<SyncConfig>> {
  const row = await pg.query<{ config: unknown }>(`SELECT config FROM module_configs WHERE app_id = $1 AND module = 'sync'`, [app.id]);
  const config = syncConfigSchema.parse({ sources: {}, ...((row.rows[0]?.config as object) ?? {}) });
  return (await rt.appJobContext(sync as never, { app, config, pendingConfig: null }, {
    job: 'sources',
    signal: new AbortController().signal,
    lastSuccessAt: null,
  })) as AppJobContext<SyncConfig>;
}

async function pass(now?: number) {
  await runDueSources(await jobCtx(), now === undefined ? undefined : () => now);
}

async function stored() {
  const rows = await db.select().from(dataRecords).where(and(eq(dataRecords.appId, app.id), eq(dataRecords.collection, 'players'))).orderBy(asc(dataRecords.createdAt));
  return rows.map((r) => r.doc as Record<string, unknown>);
}

async function state() {
  const [row] = await db.select().from(syncSources).where(and(eq(syncSources.appId, app.id), eq(syncSources.source, 'players')));
  return row;
}

async function audits() {
  const rows = await db.select().from(auditLog).where(eq(auditLog.workspaceId, workspaceId)).orderBy(asc(auditLog.createdAt));
  return rows.filter((r) => (r.meta as { app_id?: string } | null)?.app_id === app.id || r.target === app.slug);
}

beforeEach(async () => {
  rt = await runtime();
  players = { response: [] };
  playersStatus = 200;
  lastAuth = undefined;
});

describe('pickRecords', () => {
  it('walks the dotted path and never quotes the answer in an error', () => {
    expect(pickRecords({ a: { b: [{ x: 1 }] } }, 'a.b', 10)).toEqual([{ x: 1 }]);
    expect(pickRecords({ r: [{ items: [{ y: 2 }] }] }, 'r[0].items', 10)).toEqual([{ y: 2 }]);
    expect(pickRecords([{ z: 3 }], '', 10)).toEqual([{ z: 3 }]);
    expect(() => pickRecords({ secretish: 'private-value' }, 'data', 10)).toThrow('the response has no "data"');
    expect(() => pickRecords({ data: 'private-value' }, 'data', 10)).toThrow(/is a string, not an array/);
    expect(() => pickRecords([1], '', 10)).toThrow('record 0 of the response is a number, not an object');
    expect(() => pickRecords([{}, {}, {}], '', 2)).toThrow(/holds 3 records; one run imports at most 2/);
    for (const bad of [() => pickRecords({ data: 'private-value' }, 'data', 10), () => pickRecords({ secretish: 'private-value' }, 'x', 10)]) {
      expect(() => bad()).not.toThrow(/private-value/);
    }
  });

  it('backoff doubles from the interval, capped at max(interval, 1 day)', () => {
    expect(backoffMs(0, 60_000)).toBe(60_000);
    expect(backoffMs(1, 60_000)).toBe(120_000);
    expect(backoffMs(3, 60_000)).toBe(480_000);
    expect(backoffMs(30, 60_000)).toBe(60_000 * 1024);
    expect(backoffMs(30, 3_600_000)).toBe(86_400_000);
    expect(backoffMs(3, 2 * 86_400_000)).toBe(2 * 86_400_000);
  });
});

describe('configure', () => {
  it('a new source waits for the owner; every/items/paused apply at once; a changed path waits again', async () => {
    const name = await freshApp();
    const r = await rt.configure({ app, module: 'sync', patch: { sources: { players: { upstream: name, path: '/players', collection: 'players', every: '15m' } } }, actorUserId: userId });
    expect(r.applied).toBe(false);
    expect(r.pending_confirmation).toEqual([`sync.sources.players: new scheduled import — every 15m GET the upstream "${name}" at /players and replace every record of the collection "players"`]);
    expect(r.confirm_role).toBeUndefined();
    await rt.confirm({ app, module: 'sync', userId, role: 'editor' });

    const direct = await rt.configure({ app, module: 'sync', patch: { sources: { players: { every: '1h', items: 'response' } } }, actorUserId: userId });
    expect(direct.applied).toBe(true);
    expect(direct.pending_confirmation).toEqual([]);

    const moved = await rt.configure({ app, module: 'sync', patch: { sources: { players: { path: '/other' } } }, actorUserId: userId });
    expect(moved.pending_confirmation).toEqual([expect.stringMatching(/^sync\.sources\.players: path changed/)]);
  });

  it('refuses an interval below SYNC_MIN_INTERVAL_MIN and a source past SYNC_MAX_SOURCES_PER_APP; a bad shape is invalid_params', async () => {
    const name = await freshApp();
    await expect(
      rt.configure({ app, module: 'sync', patch: { sources: { players: { upstream: name, collection: 'players', every: '2m' } } }, actorUserId: userId })
    ).rejects.toMatchObject({ code: 'invalid_params', details: { limit: 'SYNC_MIN_INTERVAL_MIN', value: 5, sources: ['players'] } });

    rt = await runtime({ SYNC_MAX_SOURCES_PER_APP: '1', SYNC_MIN_INTERVAL_MIN: '1' });
    await configure('sync', { sources: { a: { upstream: name, collection: 'players', every: '2m' } } });
    await expect(rt.configure({ app, module: 'sync', patch: { sources: { b: { upstream: name, collection: 'players' } } }, actorUserId: userId })).rejects.toMatchObject({
      code: 'invalid_params',
      details: { limit: 'SYNC_MAX_SOURCES_PER_APP' },
    });
    await expect(rt.configure({ app, module: 'sync', patch: { sources: { c: { upstream: name, collection: 'players', mode: 'upsert' } } }, actorUserId: userId })).rejects.toMatchObject({
      code: 'invalid_params',
    });
    await expect(rt.configure({ app, module: 'sync', patch: { sources: { d: { upstream: name, collection: 'players', secret: 'x' } } }, actorUserId: userId })).rejects.toMatchObject({
      code: 'invalid_params',
    });
  });
});

describe('the scheduled pass', () => {
  it('imports the records with the secret injected, then waits for the interval; audited as the schedule', async () => {
    await freshApp({ collection: 'players', every: '15m' });
    players = { response: [{ id: 1, name: 'Ada', points: 10, _owner: 'spoof' }, { id: 2, name: 'Bo', points: 7 }] };
    const t0 = Date.now();
    await pass(t0);
    expect(lastAuth).toBe(`Bearer ${SECRET}`);
    expect(await stored()).toEqual([{ id: 1, name: 'Ada', points: 10 }, { id: 2, name: 'Bo', points: 7 }]);
    expect(await state()).toMatchObject({ lastStatus: 'ok', lastRecords: 2, failures: 0, pausedAt: null, runningUntil: null });

    const before = calls;
    await pass(t0 + 60_000);
    await pass(t0 + 14 * 60_000);
    expect(calls).toBe(before);
    players = { response: [{ id: 3, name: 'Cy', points: 1 }] };
    await pass(t0 + 16 * 60_000);
    expect(calls).toBe(before + 1);
    expect(await stored()).toEqual([{ id: 3, name: 'Cy', points: 1 }]);

    const runs = await (await rt.sync(app))!.runs();
    expect(runs.map((r) => [r.trigger, r.status, r.records, r.inserted, r.deleted])).toEqual([
      ['schedule', 'ok', 1, 1, 2],
      ['schedule', 'ok', 2, 2, 0],
    ]);
    const rows = (await audits()).filter((r) => r.action === 'sync.run');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actorUserId: null, actorKind: 'user', subjectType: 'app' });
    expect(rows[0].meta).toMatchObject({ by: 'schedule', module: 'sync', source: 'players', trigger: 'schedule', status: 'ok', records: 2 });
  });

  it('upsert keeps the records the answer does not name', async () => {
    await freshApp({ collection: 'players', mode: 'upsert', key: 'id' });
    players = { response: [{ id: 1, name: 'Ada', points: 1 }, { id: 2, name: 'Bo', points: 2 }] };
    await pass();
    players = { response: [{ id: 2, name: 'Bo', points: 20 }] };
    const run = await (await rt.sync(app))!.runNow('players', { userId, surface: 'web' });
    expect(run).toMatchObject({ status: 'ok', records: 1, inserted: 0, updated: 1, deleted: 0, error: null, trigger: 'manual' });
    expect(await stored()).toEqual([{ id: 1, name: 'Ada', points: 1 }, { id: 2, name: 'Bo', points: 20 }]);
  });

  it('a failed run keeps the old records: HTTP error, not JSON, a schema violation, too many records, over the response cap', async () => {
    rt = await runtime({ SYNC_MAX_RECORDS_PER_RUN: '3', SYNC_MAX_RESPONSE_BYTES: '2000', SYNC_PAUSE_AFTER_FAILURES: '100', SYNC_NOW_PER_MINUTE: '100' });
    await freshApp({ collection: 'players' });
    players = { response: [{ id: 1, name: 'Keep', points: 1 }] };
    const s = (await rt.sync(app))!;
    const actor = { userId, surface: 'web' as const };
    expect((await s.runNow('players', actor)).status).toBe('ok');

    playersStatus = 503;
    expect(await s.runNow('players', actor)).toMatchObject({ status: 'failed', error: 'the upstream answered HTTP 503' });
    playersStatus = 200;
    players = { response: [{ id: 2, name: 'Bad', points: 'many' }] };
    expect((await s.runNow('players', actor)).error).toMatch(/^Record 0: /);
    players = { response: [1, 2, 3, 4].map((id) => ({ id, name: 'n', points: 0 })) };
    expect((await s.runNow('players', actor)).error).toMatch(/holds 4 records; one run imports at most 3/);
    players = { response: 'nope' };
    expect((await s.runNow('players', actor)).error).toMatch(/"response" is a string, not an array/);

    await configure('sync', { sources: { players: { path: '/html', items: '' } } });
    expect((await (await rt.sync(app))!.runNow('players', actor)).error).toBe('the upstream answer is not JSON');
    await configure('sync', { sources: { players: { path: '/big', items: 'response' } } });
    const big = await (await rt.sync(app))!.runNow('players', actor);
    expect(big.status).toBe('failed');
    expect(big.error).toMatch(/exceeded the size cap/);

    expect(await stored()).toEqual([{ id: 1, name: 'Keep', points: 1 }]);
  });

  it('the secret never reaches an error, a run row or the audit, even when the upstream echoes it', async () => {
    await freshApp({ collection: 'players', path: '/leak' });
    const run = await (await rt.sync(app))!.runNow('players', { userId, surface: 'mcp' });
    expect(run).toMatchObject({ status: 'failed', error: 'the upstream answered HTTP 500' });
    const all = JSON.stringify([run, await state(), await (await rt.sync(app))!.runs(), await (await rt.sync(app))!.sources(), await audits()]);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('bad token');
  });

  it('an upstream the app is not assigned fails the run with the proxy refusal', async () => {
    await freshApp({ collection: 'players' });
    await configure('sync', { sources: { stray: { upstream: 'unassigned', collection: 'players' } } });
    const run = await (await rt.sync(app))!.runNow('stray', { userId, surface: 'web' });
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/may not call the upstream "unassigned"/);
  });

  it('failures back off, then pause the source (banner state); resume and a config change restart it', async () => {
    await freshApp({ collection: 'players', every: '5m' });
    playersStatus = 500;
    const t0 = Date.now();
    await pass(t0);
    expect(await state()).toMatchObject({ lastStatus: 'failed', failures: 1, pausedAt: null });
    const before = calls;
    await pass(t0 + 6 * 60_000);
    expect(calls).toBe(before);
    await pass(t0 + 11 * 60_000);
    expect(calls).toBe(before + 1);
    expect((await state()).failures).toBe(2);
    expect((await state()).pausedAt).not.toBeNull();

    const s = (await rt.sync(app))!;
    expect((await s.sources())[0]).toMatchObject({ name: 'players', paused: 'failures', failures: 2, next_run_at: null, last_error: 'the upstream answered HTTP 500' });
    await pass(t0 + 3 * 86_400_000);
    expect(calls).toBe(before + 1);

    playersStatus = 200;
    players = { response: [{ id: 1, name: 'Back', points: 1 }] };
    expect(await s.resume('players', { userId, surface: 'web' })).toBe(true);
    expect(await s.resume('players', { userId, surface: 'web' })).toBe(false);
    expect((await s.sources())[0]).toMatchObject({ paused: null, failures: 0 });
    await pass();
    expect(await state()).toMatchObject({ lastStatus: 'ok', failures: 0, pausedAt: null });
    const resume = (await audits()).find((r) => r.action === 'sync.resume');
    expect(resume).toMatchObject({ actorUserId: userId, actorKind: 'user' });
    expect(resume!.meta).toMatchObject({ source: 'players' });

    playersStatus = 500;
    await pass(Date.now() + 10 * 60_000);
    await pass(Date.now() + 60 * 60_000);
    expect((await s.sources())[0].paused).toBe('failures');
    playersStatus = 200;
    await configure('sync', { sources: { players: { path: '/players?season=2' } } });
    expect((await (await rt.sync(app))!.sources())[0]).toMatchObject({ paused: null, failures: 0 });
    await pass();
    expect((await state()).lastStatus).toBe('ok');
  });

  it("the owner's pause stops the schedule; Run now still runs it", async () => {
    await freshApp({ collection: 'players' });
    await configure('sync', { sources: { players: { paused: true } } }, 'web');
    const before = calls;
    await pass();
    expect(calls).toBe(before);
    const s = (await rt.sync(app))!;
    expect((await s.sources())[0]).toMatchObject({ paused: 'owner', next_run_at: null });
    expect((await s.runNow('players', { userId, surface: 'mcp' })).status).toBe('ok');
    expect(calls).toBe(before + 1);
  });
});

describe('Run now', () => {
  it('is rate limited per source, names the person in the audit and refuses an unknown source', async () => {
    await freshApp({ collection: 'players' });
    const s = (await rt.sync(app))!;
    await s.runNow('players', { userId, surface: 'mcp' });
    await s.runNow('players', { userId, surface: 'web' });
    await expect(s.runNow('players', { userId, surface: 'mcp' })).rejects.toMatchObject({
      code: 'rate_limited',
      details: { limit: 'SYNC_NOW_PER_MINUTE', value: 2 },
    });
    await expect(s.runNow('ghost', { userId, surface: 'mcp' })).rejects.toMatchObject({ code: 'not_found', details: { available: ['players'] } });
    const runs = (await audits()).filter((r) => r.action === 'sync.run');
    expect(runs.map((r) => [r.actorUserId, r.actorKind, (r.meta as { by: string }).by])).toEqual([
      [userId, 'agent', 'mcp'],
      [userId, 'user', 'web'],
    ]);
  });

  it('the hourly budget covers scheduled and manual runs', async () => {
    rt = await runtime({ SYNC_RUNS_PER_HOUR_PER_APP: '1' });
    await freshApp({ collection: 'players' });
    await pass();
    await expect((await rt.sync(app))!.runNow('players', { userId, surface: 'web' })).rejects.toMatchObject({
      code: 'rate_limited',
      details: { limit: 'SYNC_RUNS_PER_HOUR_PER_APP' },
    });
    expect((await state()).runningUntil).toBeNull();
  });

  it('a run in progress → conflict', async () => {
    await freshApp({ collection: 'players' });
    await db.insert(syncSources).values({ appId: app.id, source: 'players', runningUntil: new Date(Date.now() + 60_000) });
    await expect((await rt.sync(app))!.runNow('players', { userId, surface: 'web' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('the run history keeps the newest 50 per source', async () => {
    rt = await runtime({ SYNC_NOW_PER_MINUTE: '1000', SYNC_RUNS_PER_HOUR_PER_APP: '1000' });
    await freshApp({ collection: 'players' });
    const s = (await rt.sync(app))!;
    for (let i = 0; i < 52; i++) await s.runNow('players', { userId, surface: 'web' });
    const rows = await db.select().from(syncRuns).where(eq(syncRuns.appId, app.id));
    expect(rows).toHaveLength(50);
    expect(await s.runs({ limit: 500 })).toHaveLength(50);
    expect(await s.runs({ limit: 3 })).toHaveLength(3);
  });
});

describe('the module', () => {
  it('get_app info lists the sources; the job runs only while there is a source; app delete forgets the state', async () => {
    await freshApp();
    expect((sync.jobs![0].every as (c: SyncConfig, a: unknown) => unknown)({ sources: {} } as never, app)).toBeNull();
    await configure('sync', { sources: { players: { upstream: `sportsapi${appCounter}`, path: '/players', items: 'response', collection: 'players' } } });
    expect((sync.jobs![0].every as (c: SyncConfig, a: unknown) => unknown)(syncConfigSchema.parse({ sources: { a: { upstream: 'u', collection: 'c' } } }), app)).toBe('1m');
    await pass();
    await rt.runHook('onAppDelete', app);
    expect(await db.select().from(syncSources).where(eq(syncSources.appId, app.id))).toEqual([]);
    expect(await db.select().from(syncRuns).where(eq(syncRuns.appId, app.id))).toEqual([]);
  });
});
