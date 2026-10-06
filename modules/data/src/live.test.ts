/**
 * Live subscriptions: the hub (per-event authorization, owner rules, slots,
 * heartbeat, lifetime, resume, shutdown, a slow reader) over the in-memory
 * feed, the Redis feed's fan-out between two processes over a Redis stand-in,
 * and the route end to end — the SDK, MCP (records authority) and sync
 * writes all reach a subscriber because the store publishes them.
 */
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { apps, workspaces, type DB } from '@drobek/db';
import * as schema from '@drobek/db/schema';
import { endModuleStreams, resetModuleStreamsForTests, type Principal, type RecordsView, type Rule } from '@drobek/modules';
import { createModuleTestContext } from '@drobek/modules/testing';
import data, { dataConfigSchema, recordsAuthority, type DataConfig } from './index.js';
import { BACKLOG_TTL_MS, memoryChangeFeed, redisChangeFeed, setChangeFeedForTests, type ChangeEvent, type ChangeFeed } from './live-feed.js';
import { LiveHub, MAX_BUFFERED_BYTES, PRINCIPAL_RECHECK_MS, liveHub, setLiveHubForTests, type SubscribeInput } from './live.js';
import type { DataRecord } from './store.js';

const ANON: Principal = { kind: 'anon' };
const A: Principal = { kind: 'user', id: 'eu_a', email: 'a@example.com', role: 'user' };
const B: Principal = { kind: 'user', id: 'eu_b', email: 'b@example.com', role: 'user' };
const ADMIN: Principal = { kind: 'user', id: 'eu_admin', email: 'boss@example.com', role: 'admin' };

interface Frame {
  type: string;
  id: string | null;
  data: Record<string, unknown> | null;
  comment?: string;
}

/** Reads a stream's SSE frames as they come. */
function reader(stream: Readable) {
  const frames: Frame[] = [];
  let buffer = '';
  let ended = false;
  stream.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let i: number;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const f: Frame = { type: 'message', id: null, data: null };
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) f.comment = line.slice(1).trim();
        else if (line.startsWith('id: ')) f.id = line.slice(4);
        else if (line.startsWith('event: ')) f.type = line.slice(7);
        else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        else if (line.startsWith('retry: ')) f.type = 'retry';
      }
      frames.push(f);
    }
  });
  stream.on('end', () => {
    ended = true;
  });
  const events = (type: string) => frames.filter((f) => f.type === type);
  return {
    frames,
    events,
    changes: () => events('change').map((f) => f.data as Record<string, unknown>),
    get ended() {
      return ended;
    },
  };
}

async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function record(id: string, owner: string | null, fields: Record<string, unknown> = {}): DataRecord {
  const at = new Date().toISOString();
  return { _id: id, _owner: owner, _created_at: at, _updated_at: at, ...fields };
}

const created = (r: DataRecord): ChangeEvent => ({ op: 'create', record: r, at: r._updated_at });

interface Knobs {
  rule: Rule | null;
  principal: Principal;
}

function input(feed: ChangeFeed, knobs: Knobs, over: Partial<SubscribeInput> = {}): SubscribeInput {
  void feed;
  return {
    appId: 'app_1',
    collection: 'notes',
    principal: knobs.principal,
    callerKey: knobs.principal.kind === 'user' ? `u:${knobs.principal.id}` : 'ip:203.0.113.9',
    lastEventId: null,
    limits: { maxPerApp: 200, maxPerCaller: 4, maxMs: 3_600_000 },
    currentRule: async () => knobs.rule,
    currentPrincipal: async () => knobs.principal,
    forCaller: (rec, p) => {
      if (p.kind === 'user') return rec;
      const { _owner: _h, ...rest } = rec;
      void _h;
      return rest;
    },
    ...over,
  };
}

function open(hub: LiveHub, inp: SubscribeInput) {
  const r = hub.subscribe(inp);
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.message}`);
  return { stream: r.stream, read: reader(r.stream) };
}

afterEach(() => {
  resetModuleStreamsForTests();
});

describe('LiveHub — per-event authorization', () => {
  it('owner scope: a user gets only events of their own records (delete: the id only); an admin gets all', async () => {
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed);
    const a = { rule: 'owner|admin', principal: A } as Knobs;
    const boss = { rule: 'owner|admin', principal: ADMIN } as Knobs;
    const sa = open(hub, input(feed, a));
    const sb = open(hub, input(feed, boss));
    await until(() => sa.read.events('ready').length === 1 && sb.read.events('ready').length === 1, 'ready');

    await feed.publish('app_1', 'notes', [created(record('r_a', 'eu_a', { t: 'mine' })), created(record('r_b', 'eu_b', { t: 'secret' }))]);
    await feed.publish('app_1', 'notes', [
      { op: 'delete', id: 'r_b', owner: 'eu_b', at: new Date().toISOString() },
      { op: 'delete', id: 'r_a', owner: 'eu_a', at: new Date().toISOString() },
    ]);
    await until(() => sb.read.changes().length === 4, 'admin events');
    await tick();
    expect(sa.read.changes()).toEqual([
      { op: 'create', record: expect.objectContaining({ _id: 'r_a', _owner: 'eu_a', t: 'mine' }), at: expect.any(String) },
      { op: 'delete', id: 'r_a', at: expect.any(String) },
    ]);
    expect(JSON.stringify(sa.read.frames)).not.toContain('secret');
    expect(JSON.stringify(sa.read.frames)).not.toContain('eu_b');
    expect(sb.read.changes().map((c) => c.op)).toEqual(['create', 'create', 'delete', 'delete']);
    expect(sb.read.changes()[2]).toEqual({ op: 'delete', id: 'r_b', at: expect.any(String) });
    hub.endAll();
  });

  it('a visitor on a public collection never gets _owner', async () => {
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed);
    const s = open(hub, input(feed, { rule: 'public', principal: ANON }));
    await until(() => s.read.events('ready').length === 1);
    await feed.publish('app_1', 'notes', [created(record('r_1', 'eu_a', { text: 'hi' }))]);
    await until(() => s.read.changes().length === 1);
    expect(s.read.changes()[0].record).toEqual({ _id: 'r_1', _created_at: expect.any(String), _updated_at: expect.any(String), text: 'hi' });
    hub.endAll();
  });

  it('the rule is read again for every event: tightened → an error event ends the stream and frees its slot', async () => {
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed);
    const knobs: Knobs = { rule: 'user', principal: A };
    const s = open(hub, input(feed, knobs));
    await until(() => s.read.events('ready').length === 1);
    await feed.publish('app_1', 'notes', [created(record('r_1', 'eu_b'))]);
    await until(() => s.read.changes().length === 1);

    knobs.rule = 'owner|admin';
    await feed.publish('app_1', 'notes', [created(record('r_2', 'eu_b', { t: 'after' }))]);
    await tick();
    expect(s.read.changes()).toHaveLength(1);

    knobs.rule = 'admin';
    await feed.publish('app_1', 'notes', [created(record('r_3', 'eu_a'))]);
    await until(() => s.read.ended, 'end');
    expect(s.read.events('error').map((f) => f.data)).toEqual([{ error: 'forbidden', message: expect.stringContaining('no longer read') }]);
    expect(s.read.changes()).toHaveLength(1);
    expect(hub.open('app_1')).toBe(0);
  });

  it('a collection that is no longer declared ends the stream with not_found', async () => {
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed);
    const knobs: Knobs = { rule: 'public', principal: ANON };
    const s = open(hub, input(feed, knobs));
    await until(() => s.read.events('ready').length === 1);
    knobs.rule = null;
    await feed.publish('app_1', 'notes', [created(record('r_1', null))]);
    await until(() => s.read.ended);
    expect(s.read.events('error')[0].data).toMatchObject({ error: 'not_found' });
    expect(s.read.changes()).toEqual([]);
  });

  it('the session is read again (every PRINCIPAL_RECHECK_MS): a signed-out user gets unauthorized, not the event', async () => {
    let clock = 1_000_000;
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed, { now: () => clock });
    const knobs: Knobs = { rule: 'user', principal: A };
    const s = open(hub, input(feed, knobs));
    await until(() => s.read.events('ready').length === 1);
    knobs.principal = ANON;
    clock += PRINCIPAL_RECHECK_MS;
    await feed.publish('app_1', 'notes', [created(record('r_1', 'eu_a', { t: 'x' }))]);
    await until(() => s.read.ended);
    expect(s.read.events('error')[0].data).toMatchObject({ error: 'unauthorized' });
    expect(s.read.changes()).toEqual([]);
  });

  it('the heartbeat pings and checks the caller again', async () => {
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed, { heartbeatMs: 15 });
    const knobs: Knobs = { rule: 'user', principal: B };
    const s = open(hub, input(feed, knobs));
    await until(() => s.read.frames.some((f) => f.comment === 'ping'), 'ping');
    knobs.principal = ANON;
    await until(() => s.read.ended, 'end after the heartbeat check');
    expect(s.read.events('error')[0].data).toMatchObject({ error: 'unauthorized' });
  });
});

describe('LiveHub — slots, lifetime, shutdown, slow readers', () => {
  it('caps streams per caller and per app; every close frees its slot', async () => {
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed);
    const knobs: Knobs = { rule: 'user', principal: A };
    const limits = { maxPerApp: 6, maxPerCaller: 4, maxMs: 3_600_000 };
    const mine = Array.from({ length: 4 }, () => open(hub, input(feed, knobs, { limits })));
    const fifth = hub.subscribe(input(feed, knobs, { limits }));
    expect(fifth).toMatchObject({ ok: false, code: 'limit_exceeded', details: { limit: 'DATA_SUBSCRIBE_MAX_PER_CALLER', value: 4 } });

    const other: Knobs = { rule: 'user', principal: B };
    open(hub, input(feed, other, { limits }));
    open(hub, input(feed, other, { limits }));
    expect(hub.subscribe(input(feed, other, { limits }))).toMatchObject({ ok: false, details: { limit: 'DATA_SUBSCRIBE_MAX_PER_APP', value: 6 } });

    mine[0].stream.destroy();
    await tick();
    expect(hub.open('app_1')).toBe(5);
    expect(hub.subscribe(input(feed, knobs, { limits })).ok).toBe(true);
    hub.endAll();
    expect(hub.open()).toBe(0);
  });

  it('a stream ends after its lifetime (the client reconnects); the slot is free again', async () => {
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed);
    const s = open(hub, input(feed, { rule: 'public', principal: ANON }, { limits: { maxPerApp: 1, maxPerCaller: 1, maxMs: 40 } }));
    await until(() => s.read.ended, 'lifetime');
    expect(s.read.events('error')).toEqual([]);
    expect(hub.open('app_1')).toBe(0);
  });

  it('the server stop ends every stream (the module streams registry) and refuses new ones', async () => {
    const feed = memoryChangeFeed();
    setChangeFeedForTests(feed);
    setLiveHubForTests(null);
    const hub = liveHub();
    const s = open(hub, input(feed, { rule: 'public', principal: ANON }));
    await until(() => s.read.events('ready').length === 1);
    endModuleStreams();
    await until(() => s.read.ended);
    expect(hub.subscribe(input(feed, { rule: 'public', principal: ANON }))).toMatchObject({ ok: false, code: 'unavailable' });
    setLiveHubForTests(null);
    setChangeFeedForTests(null);
  });

  it('a client that does not read ends with slow_client once MAX_BUFFERED_BYTES wait unsent', async () => {
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed);
    const r = hub.subscribe(input(feed, { rule: 'public', principal: ANON }));
    if (!r.ok) throw new Error('refused');
    await new Promise((res) => setTimeout(res, 10));
    const big = 'x'.repeat(64 * 1024);
    for (let i = 0; i < Math.ceil(MAX_BUFFERED_BYTES / big.length) + 2; i++) {
      await feed.publish('app_1', 'notes', [created(record(`r_${i}`, null, { big }))]);
    }
    await tick();
    expect(hub.open('app_1')).toBe(0);
    const read = reader(r.stream);
    await until(() => read.ended);
    expect(read.events('error').at(-1)?.data).toMatchObject({ error: 'slow_client' });
  });
});

describe('LiveHub — resume with Last-Event-ID', () => {
  it('a reconnect gets the events it missed (filtered like live ones), without ready', async () => {
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed);
    const knobs: Knobs = { rule: 'owner|admin', principal: A };
    const first = open(hub, input(feed, knobs));
    await until(() => first.read.events('ready').length === 1);
    await feed.publish('app_1', 'notes', [created(record('r_1', 'eu_a'))]);
    await until(() => first.read.changes().length === 1);
    const lastId = first.read.events('change')[0].id!;
    first.stream.destroy();
    await tick();

    await feed.publish('app_1', 'notes', [created(record('r_2', 'eu_a')), created(record('r_3', 'eu_b')), created(record('r_4', 'eu_a'))]);
    const again = open(hub, input(feed, knobs, { lastEventId: lastId }));
    await until(() => again.read.changes().length === 2, 'resumed');
    await feed.publish('app_1', 'notes', [created(record('r_5', 'eu_a'))]);
    await until(() => again.read.changes().length === 3, 'live after resume');
    expect(again.read.changes().map((c) => (c.record as DataRecord)._id)).toEqual(['r_2', 'r_4', 'r_5']);
    expect(again.read.events('ready')).toEqual([]);
    expect(again.read.events('reset')).toEqual([]);
    hub.endAll();
  });

  it('a resume past the backlog (trimmed) or older than it is kept answers reset', async () => {
    let clock = 5_000_000;
    const feed = memoryChangeFeed({ backlog: 2, now: () => clock });
    const hub = new LiveHub(feed, { now: () => clock });
    const knobs: Knobs = { rule: 'public', principal: ANON };
    const first = open(hub, input(feed, knobs));
    await until(() => first.read.events('ready').length === 1);
    const start = first.read.events('ready')[0].id!;
    expect(start).toBe(`${clock}-0`);
    first.stream.destroy();
    clock += 1;
    await feed.publish('app_1', 'notes', [created(record('r_1', null)), created(record('r_2', null)), created(record('r_3', null))]);
    clock += 1;

    const trimmed = open(hub, input(feed, knobs, { lastEventId: start }));
    await until(() => trimmed.read.events('reset').length === 1, 'reset (trimmed)');
    expect(trimmed.read.changes()).toEqual([]);
    trimmed.stream.destroy();

    clock += BACKLOG_TTL_MS;
    const old = open(hub, input(feed, knobs, { lastEventId: `${clock - BACKLOG_TTL_MS}-0` }));
    await until(() => old.read.events('reset').length === 1, 'reset (expired)');
    hub.endAll();
  });

  it('a lost subscriber connection (events may be missed) sends reset', async () => {
    const feed = memoryChangeFeed();
    const hub = new LiveHub(feed);
    const s = open(hub, input(feed, { rule: 'public', principal: ANON }));
    await until(() => s.read.events('ready').length === 1);
    feed.dropSubscriber();
    await until(() => s.read.events('reset').length === 1);
    hub.endAll();
  });
});

/** A Redis stand-in with the commands the feed uses: the two scripts, TIME and pub/sub connections. */
function fakeRedis() {
  const streams = new Map<string, { entries: [string, string[]][]; deleted: string; seq: number; ms: number }>();
  const subscribers = new Set<{ channels: Set<string>; handlers: ((channel: string, raw: string) => void)[] }>();
  const publish = (channel: string, raw: string) => {
    for (const s of subscribers) if (s.channels.has(channel)) for (const h of s.handlers) h(channel, raw);
  };
  const client = {
    async time(): Promise<[string, string]> {
      const ms = Date.now();
      return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)];
    },
    async eval(script: string, _n: number, ...args: (string | number)[]): Promise<unknown> {
      if (script.includes('XADD')) {
        const [key, channel, maxlen, , ...events] = args.map(String);
        let s = streams.get(key);
        if (!s) streams.set(key, (s = { entries: [], deleted: '0-0', seq: 0, ms: 0 }));
        for (const e of events) {
          const ms = Math.max(Date.now(), s.ms);
          s.seq = ms === s.ms ? s.seq + 1 : 0;
          s.ms = ms;
          const id = `${ms}-${s.seq}`;
          s.entries.push([id, ['e', e]]);
          while (s.entries.length > Number(maxlen)) s.deleted = s.entries.shift()![0];
          publish(channel, `${id}\n${e}`);
        }
        return events.length;
      }
      const [key, start, count] = args.map(String);
      const s = streams.get(key);
      if (!s) return [null, []];
      const after = start.slice(1);
      const cmp = (a: string, b: string) => {
        const [am, as] = a.split('-').map(Number);
        const [bm, bs] = b.split('-').map(Number);
        return am - bm || as - bs;
      };
      return [s.deleted, s.entries.filter(([id]) => cmp(id, after) > 0).slice(0, Number(count))];
    },
    duplicate() {
      const s = { channels: new Set<string>(), handlers: [] as ((channel: string, raw: string) => void)[] };
      subscribers.add(s);
      return {
        on(ev: string, fn: (channel: string, raw: string) => void) {
          if (ev === 'message') s.handlers.push(fn);
          return this;
        },
        async subscribe(channel: string) {
          s.channels.add(channel);
          return 1;
        },
        async unsubscribe(channel: string) {
          s.channels.delete(channel);
          return 0;
        },
        async quit() {
          subscribers.delete(s);
          return 'OK';
        },
      };
    },
  };
  return { client, streams };
}

describe('redisChangeFeed — fan-out between processes', () => {
  it('a write published in one process reaches the subscribers of two other processes; a resume reads the stream', async () => {
    const redis = fakeRedis();
    const make = () => redisChangeFeed({ redis: () => redis.client as never, backlog: 10 });
    const writer = make();
    const hub1 = new LiveHub(make());
    const hub2 = new LiveHub(make());
    const knobs: Knobs = { rule: 'public', principal: ANON };
    const s1 = open(hub1, input(writer, knobs));
    const s2 = open(hub2, input(writer, knobs));
    await until(() => s1.read.events('ready').length === 1 && s2.read.events('ready').length === 1);

    await writer.publish('app_1', 'notes', [created(record('r_1', null, { text: 'hello' }))]);
    await until(() => s1.read.changes().length === 1 && s2.read.changes().length === 1, 'fan-out');
    expect(s2.read.changes()[0]).toMatchObject({ op: 'create', record: { _id: 'r_1', text: 'hello' } });
    const id = s1.read.events('change')[0].id!;
    expect(id).toMatch(/^\d+-\d+$/);

    await writer.publish('app_1', 'notes', [created(record('r_2', null))]);
    expect(await writer.since('app_1', 'notes', id)).toEqual([{ id: expect.any(String), event: expect.objectContaining({ op: 'create' }) }]);
    expect(await writer.since('app_1', 'other', id)).toEqual([]);
    hub1.endAll();
    hub2.endAll();
  });
});

// ── the route, end to end ───────────────────────────────────────────────────

const CORE_MIGRATIONS = fileURLToPath(new URL('../../../packages/db/drizzle/migrations', import.meta.url));
let pg: PGlite;
let db: DB;
let appId: string;
let workspaceId: string;

const CONFIG = {
  collections: {
    board: { rules: { read: 'public', create: 'public', update: 'admin', delete: 'admin' } },
    notes: { rules: { read: 'owner|admin', create: 'user', update: 'owner|admin', delete: 'owner|admin' } },
  },
};

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg, { schema });
  await migrate(d, { migrationsFolder: CORE_MIGRATIONS, migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: data.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_data', migrationsSchema: 'drizzle' });
  const [ws] = await d.insert(workspaces).values({ kind: 'team', slug: 'live-ws', name: 'Live' }).returning();
  workspaceId = ws.id;
  const [a] = await d.insert(apps).values({ workspaceId, slug: 'live', name: 'Live' }).returning();
  appId = a.id;
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
  setChangeFeedForTests(null);
  setLiveHubForTests(null);
});

describe('GET /:collection/events', () => {
  const ctx = (principal: Principal, config: Record<string, unknown> = CONFIG) =>
    createModuleTestContext(data, { db, app: { id: appId, slug: 'live', workspaceId }, config, principal, origin: 'http://live--preview.apps.localhost' });
  const view = (): RecordsView<DataConfig> => ({
    app: { id: appId, slug: 'live', workspaceId },
    config: dataConfigSchema.parse(CONFIG),
    db,
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
    limits: async () => ({}),
  });

  it('is authorized like a list: an owner-only collection refuses a visitor (401); an undeclared one is 404', async () => {
    setChangeFeedForTests(memoryChangeFeed());
    setLiveHubForTests(null);
    const t = ctx(ANON);
    expect((await t.request('GET', '/notes/events')).status).toBe(401);
    expect((await t.request('GET', '/nope/events')).status).toBe(404);
  });

  it('streams SDK, MCP and sync writes: create / update / delete, with text/event-stream headers', async () => {
    setChangeFeedForTests(memoryChangeFeed());
    setLiveHubForTests(null);
    const visitor = ctx(ANON);
    const res = await visitor.request('GET', '/board/events', { stream: true });
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['Cache-Control']).toBe('no-store');
    const read = reader(res.stream!);
    await until(() => read.events('ready').length === 1);

    const posted = await ctx(A).request('POST', '/board', { body: { text: 'from the SDK' } });
    expect(posted.status).toBe(201);
    const [mcp] = (await recordsAuthority.create!(view(), 'board', [{ text: 'from MCP' }])) as DataRecord[];
    await recordsAuthority.update!(view(), 'board', mcp._id, { text: 'edited' }, { merge: true });
    await recordsAuthority.remove!(view(), 'board', mcp._id);
    await recordsAuthority.importRecords!(view(), 'board', [{ key: 'k1', text: 'synced' }], { mode: 'upsert', key: 'key' });
    await until(() => read.changes().length === 4 && read.events('reset').length === 1, 'events');
    expect(read.changes()).toEqual([
      { op: 'create', record: expect.objectContaining({ text: 'from the SDK' }), at: expect.any(String) },
      { op: 'create', record: expect.objectContaining({ _id: mcp._id, text: 'from MCP' }), at: expect.any(String) },
      { op: 'update', record: expect.objectContaining({ _id: mcp._id, text: 'edited' }), at: expect.any(String) },
      { op: 'delete', id: mcp._id, at: expect.any(String) },
    ]);
    expect(read.changes()[0].record).not.toHaveProperty('_owner');
    res.stream!.destroy();
  });

  it("an owner-scoped subscriber never gets another user's record; Last-Event-ID resumes", async () => {
    setChangeFeedForTests(memoryChangeFeed());
    setLiveHubForTests(null);
    const res = await ctx(A).request('GET', '/notes/events', { stream: true });
    const read = reader(res.stream!);
    await until(() => read.events('ready').length === 1);
    await ctx(B).request('POST', '/notes', { body: { text: 'b private' } });
    await ctx(A).request('POST', '/notes', { body: { text: 'a own' } });
    await until(() => read.changes().length === 1);
    await tick();
    expect(read.changes()).toEqual([{ op: 'create', record: expect.objectContaining({ text: 'a own', _owner: 'eu_a' }), at: expect.any(String) }]);
    expect(JSON.stringify(read.frames)).not.toContain('b private');
    const last = read.events('change')[0].id!;
    res.stream!.destroy();

    await ctx(A).request('POST', '/notes', { body: { text: 'while away' } });
    const again = await ctx(A).request('GET', '/notes/events', { stream: true, headers: { 'Last-Event-ID': last } });
    const r2 = reader(again.stream!);
    await until(() => r2.changes().length === 1);
    expect(r2.changes()[0]).toMatchObject({ op: 'create', record: { text: 'while away' } });
    again.stream!.destroy();
  });

  it('over DATA_SUBSCRIBE_MAX_PER_CALLER → 429 limit_exceeded; a removed rule ends the open stream', async () => {
    setChangeFeedForTests(memoryChangeFeed());
    setLiveHubForTests(null);
    const t = createModuleTestContext(data, {
      db,
      app: { id: appId, slug: 'live', workspaceId },
      config: CONFIG,
      principal: A,
      limits: { DATA_SUBSCRIBE_MAX_PER_CALLER: 1 },
    });
    const first = await t.request('GET', '/board/events', { stream: true });
    const read = reader(first.stream!);
    const second = await t.request('GET', '/board/events', { stream: true });
    expect(second.status).toBe(429);
    expect(second.headers['Retry-After']).toBe('30');
    expect(second.body).toMatchObject({ error: 'limit_exceeded', details: { limit: 'DATA_SUBSCRIBE_MAX_PER_CALLER', value: 1 } });
    await until(() => read.events('ready').length === 1);

    t.setConfig({ collections: { board: { rules: { read: 'admin' } } } });
    await ctx(ANON).request('POST', '/board', { body: { text: 'hidden now' } });
    await until(() => read.ended);
    expect(read.events('error')[0].data).toMatchObject({ error: 'forbidden' });
    expect(read.changes()).toEqual([]);
    expect((await t.request('GET', '/board/events')).status).toBe(403);
  });
});
