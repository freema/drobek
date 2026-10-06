/**
 * The change feed of the data module: every committed record write is
 * published here, by the store (store.ts) — so the SDK routes, the owner's
 * MCP and dashboard writes and module imports (sync) all reach the
 * subscribers without each caller publishing.
 *
 * Redis (production): one pub/sub channel per app + collection
 * (`drobek:data:live:<app>:<collection>`) fans an event out to every
 * process, and a small Redis stream per app + collection
 * (`drobek:data:backlog:<app>:<collection>`, the last DATA_SUBSCRIBE_BACKLOG
 * events, kept BACKLOG_TTL_MS after the last write) lets a reconnecting
 * subscriber resume from its `Last-Event-ID`. A Lua script appends to the
 * stream and publishes in one step, so ids reach the channel in order. The
 * stream id (`<ms>-<seq>`, Redis time) is the event id; a subscription
 * starts at `<now ms>-0`, which tells the client nothing about the writes.
 *
 * A resume from `lastId` is complete when nothing after it was trimmed
 * (the stream's max-deleted-entry-id ≤ lastId) and lastId is younger than
 * BACKLOG_TTL_MS — an expired stream had no write for that long, so it
 * cannot have held one after lastId. Anything else answers null: the
 * subscriber loads the list again.
 *
 * Without REDIS_URL (unit tests) an in-memory feed with the same semantics
 * serves the one process.
 */
import { createConsoleLogger, getRedis, type Logger } from '@drobek/core';
import { dbErrorForLog } from '@drobek/db';
import type { DataRecord } from './store.js';

/** One change, as published (the delete's `owner` is for the per-event check only; it is never sent). */
export type ChangeEvent =
  | { op: 'create' | 'update'; record: DataRecord; at: string }
  | { op: 'delete'; id: string; owner: string | null; at: string }
  | { op: 'reset'; at: string };

interface FeedEntry {
  id: string;
  event: ChangeEvent;
}

/** What a listener receives: an entry, or `reset` — events may have been missed (the subscriber connection came back). */
export type FeedMessage = FeedEntry | 'reset';

export interface FeedListener {
  /** Resolves once the channel is subscribed: nothing published after it is missed. */
  ready: Promise<void>;
  off(): void;
}

export interface ChangeFeed {
  /** Publish committed changes (never throws: a lost event is logged, the write stands). */
  publish(appId: string, collection: string, events: ChangeEvent[]): Promise<void>;
  listen(appId: string, collection: string, fn: (m: FeedMessage) => void): FeedListener;
  /** The entries after `lastId`, or null when they cannot be complete (see the file comment). */
  since(appId: string, collection: string, lastId: string): Promise<FeedEntry[] | null>;
  /** An id for "now" (`<ms>-0` on the feed's clock): where a new subscription starts. */
  now(): Promise<string>;
}

const DEFAULT_SUBSCRIBE_BACKLOG = 100;
export const BACKLOG_TTL_MS = 10 * 60_000;
/** A resume id must be this much younger than BACKLOG_TTL_MS (clock and timing slack). */
const RESUME_MARGIN_MS = 30_000;
export const EVENT_ID_RE = /^\d{1,15}-\d{1,15}$/;

/** `DATA_SUBSCRIBE_BACKLOG`: events kept per collection for resuming (1–1000), else the default. */
function subscribeBacklog(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DATA_SUBSCRIBE_BACKLOG);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_SUBSCRIBE_BACKLOG;
}

/** Compare two stream ids (`<ms>-<seq>`). */
export function compareEventIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  if (am !== bm) return am < bm ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
}

function resumable(lastId: string, nowMs: number): boolean {
  return EVENT_ID_RE.test(lastId) && Number(lastId.split('-')[0]) >= nowMs - BACKLOG_TTL_MS + RESUME_MARGIN_MS;
}

const channelOf = (appId: string, collection: string) => `drobek:data:live:${appId}:${collection}`;
const backlogOf = (appId: string, collection: string) => `drobek:data:backlog:${appId}:${collection}`;

function parseEvent(raw: string): ChangeEvent | null {
  try {
    const e = JSON.parse(raw) as ChangeEvent;
    return e && typeof e === 'object' && typeof e.op === 'string' ? e : null;
  } catch {
    return null;
  }
}

// KEYS: backlog stream, channel. ARGV: maxlen, ttl ms, event JSON…
const PUBLISH_SCRIPT = `
for i = 3, #ARGV do
  local id = redis.call('XADD', KEYS[1], 'MAXLEN', ARGV[1], '*', 'e', ARGV[i])
  redis.call('PUBLISH', KEYS[2], id .. '\\n' .. ARGV[i])
end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return #ARGV - 2
`;

// KEYS: backlog stream. ARGV: exclusive start "(<id>", count. → { max-deleted-entry-id | false, entries }
const SINCE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return { false, {} } end
local info = redis.call('XINFO', 'STREAM', KEYS[1])
local deleted = '0-0'
for i = 1, #info, 2 do
  if info[i] == 'max-deleted-entry-id' then deleted = info[i + 1] end
end
return { deleted, redis.call('XRANGE', KEYS[1], ARGV[1], '+', 'COUNT', ARGV[2]) }
`;

type Redis = ReturnType<typeof getRedis>;
type FeedRedis = Pick<Redis, 'eval' | 'time' | 'duplicate'>;

export interface RedisFeedOptions {
  redis?: () => FeedRedis;
  backlog?: number;
  log?: Logger;
}

type StreamRows = [string, string[]][];

function entriesOf(rows: StreamRows): FeedEntry[] {
  return rows.flatMap(([id, fields]) => {
    const event = parseEvent(fields[1] ?? '');
    return event ? [{ id, event }] : [];
  });
}

/** The production feed (see the file comment). */
export function redisChangeFeed(opts: RedisFeedOptions = {}): ChangeFeed {
  const redis = opts.redis ?? (getRedis as () => FeedRedis);
  const backlog = opts.backlog ?? subscribeBacklog();
  const listeners = new Map<string, Set<(m: FeedMessage) => void>>();
  const subscribed = new Map<string, Promise<unknown>>();
  let sub: Redis | null = null;

  const connection = (): Redis => {
    if (sub) return sub;
    const s = redis().duplicate() as Redis;
    s.on('message', (channel: string, raw: string) => {
      const nl = raw.indexOf('\n');
      const event = nl > 0 ? parseEvent(raw.slice(nl + 1)) : null;
      if (!event) return;
      const entry: FeedEntry = { id: raw.slice(0, nl), event };
      for (const fn of [...(listeners.get(channel) ?? [])]) fn(entry);
    });
    let first = true;
    s.on('ready', () => {
      // ioredis subscribes again after a reconnect; what was published meanwhile is lost.
      if (first) {
        first = false;
        return;
      }
      for (const set of listeners.values()) for (const fn of [...set]) fn('reset');
    });
    s.on('error', (err: Error) => opts.log?.warn('data live subscriber error', { error: dbErrorForLog(err) }));
    sub = s;
    return s;
  };

  const nowMs = async () => {
    const [sec, usec] = await redis().time();
    return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
  };

  return {
    async publish(appId, collection, events) {
      if (events.length === 0) return;
      try {
        await redis().eval(PUBLISH_SCRIPT, 2, backlogOf(appId, collection), channelOf(appId, collection), backlog, BACKLOG_TTL_MS, ...events.map((e) => JSON.stringify(e)));
      } catch (err) {
        opts.log?.warn('data change not published', { app_id: appId, collection, error: dbErrorForLog(err) });
      }
    },

    listen(appId, collection, fn) {
      const channel = channelOf(appId, collection);
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(fn);
      let ready = subscribed.get(channel);
      if (!ready) {
        ready = connection().subscribe(channel);
        subscribed.set(channel, ready);
      }
      return {
        ready: ready.then(() => undefined),
        off() {
          const s = listeners.get(channel);
          if (!s?.delete(fn) || s.size > 0) return;
          listeners.delete(channel);
          subscribed.delete(channel);
          void sub?.unsubscribe(channel).catch(() => undefined);
        },
      };
    },

    async since(appId, collection, lastId) {
      if (!resumable(lastId, await nowMs())) return null;
      const [deleted, rows] = (await redis().eval(SINCE_SCRIPT, 1, backlogOf(appId, collection), `(${lastId}`, backlog + 1)) as [string | null, StreamRows];
      if (deleted && compareEventIds(deleted, lastId) > 0) return null;
      return entriesOf(rows);
    },

    async now() {
      return `${await nowMs()}-0`;
    },
  };
}

/** One process's feed in memory, with the semantics of redisChangeFeed (tests, a server without Redis). */
export function memoryChangeFeed(opts: { backlog?: number; now?: () => number } = {}): ChangeFeed & { dropSubscriber(): void } {
  const backlog = opts.backlog ?? DEFAULT_SUBSCRIBE_BACKLOG;
  const clock = opts.now ?? Date.now;
  const streams = new Map<string, { entries: FeedEntry[]; at: number; lastMs: number; seq: number; deleted: string }>();
  const listeners = new Map<string, Set<(m: FeedMessage) => void>>();
  const live = (key: string) => {
    const s = streams.get(key);
    if (s && clock() - s.at > BACKLOG_TTL_MS) streams.delete(key);
    return streams.get(key);
  };
  return {
    async publish(appId, collection, events) {
      const key = `${appId}:${collection}`;
      let s = live(key);
      if (!s) {
        s = { entries: [], at: clock(), lastMs: 0, seq: 0, deleted: '0-0' };
        streams.set(key, s);
      }
      for (const event of events) {
        const ms = Math.max(clock(), s.lastMs);
        s.seq = ms === s.lastMs ? s.seq + 1 : 0;
        s.lastMs = ms;
        const entry = { id: `${ms}-${s.seq}`, event: JSON.parse(JSON.stringify(event)) as ChangeEvent };
        s.entries.push(entry);
        if (s.entries.length > backlog) s.deleted = s.entries.splice(0, s.entries.length - backlog).pop()!.id;
        for (const fn of [...(listeners.get(key) ?? [])]) fn(entry);
      }
      s.at = clock();
    },
    listen(appId, collection, fn) {
      const key = `${appId}:${collection}`;
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(fn);
      return {
        ready: Promise.resolve(),
        off() {
          const s = listeners.get(key);
          s?.delete(fn);
          if (s && s.size === 0) listeners.delete(key);
        },
      };
    },
    async since(appId, collection, lastId) {
      if (!resumable(lastId, clock())) return null;
      const s = live(`${appId}:${collection}`);
      if (!s) return [];
      if (compareEventIds(s.deleted, lastId) > 0) return null;
      return s.entries.filter((e) => compareEventIds(e.id, lastId) > 0);
    },
    async now() {
      return `${clock()}-0`;
    },
    dropSubscriber() {
      for (const set of listeners.values()) for (const fn of [...set]) fn('reset');
    },
  };
}

let feed: ChangeFeed | null = null;

/** The process's feed: Redis when REDIS_URL is set, else in memory. */
export function changeFeed(): ChangeFeed {
  feed ??= process.env.REDIS_URL ? redisChangeFeed({ log: createConsoleLogger('data-live') }) : memoryChangeFeed({ backlog: subscribeBacklog() });
  return feed;
}

/** Tests: use `f` as the process's feed (null = the default again). */
export function setChangeFeedForTests(f: ChangeFeed | null): void {
  feed = f;
}
