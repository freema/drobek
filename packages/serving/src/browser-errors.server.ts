/**
 * Browser errors of the preview in Redis, and their stacks mapped back to the
 * app's sources when they are read.
 *
 * Storage (no SQL: debugging help, not an audit trail), per app and version:
 *
 *   drobek:browser-errors:<app_id>        sorted set: version → when its last error arrived (ms)
 *   drobek:browser-errors:<app_id>:v<N>   hash: `e:<key>` the first report (JSON), `c:<key>` how
 *                                         often it happened, `l:<key>` when it last arrived (ms),
 *                                         `n` how many distinct errors the version holds
 *
 * `<key>` hashes message + stack, so a repeated error counts up instead of
 * adding a row. A version holds at most BROWSER_ERRORS_MAX_PER_VERSION
 * distinct errors (new ones past it are dropped; known ones still count up);
 * both keys expire BROWSER_ERRORS_TTL_HOURS after the last error arrived.
 *
 * Reading (get_logs `browser`, get_app, the dashboard's Logs tab) maps every
 * stack frame of a bundle the version built (`/main.js:12:345`) through that
 * bundle's inline source map to the app's source (`src/App.tsx:8:5`) — the map
 * is only read, no app code runs. A frame the map does not cover stays as it
 * was.
 */
import { and, eq } from 'drizzle-orm';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { rateLimitRedis } from '@drobek/auth';
import { getRedis } from '@drobek/core';
import { appVersions, getDb } from '@drobek/db';
import { beaconSameOrigin } from '@drobek/insights';
import {
  MAX_ERRORS_BODY_BYTES,
  browserErrorLimitsFromEnv,
  parseBrowserErrors,
  type BrowserErrorBatch,
  type BrowserErrorLimits,
  type BrowserErrorType,
  type BrowserFamily,
} from './browser-errors.js';
import type { AppRequest } from './handler.js';
import { splitInlineSourceMap } from './sourcemap.js';
import { dbLoaders, type ServeApp, type ServeLoaders, type ServeVersion } from './store.server.js';

/** The Redis commands the store uses (ioredis satisfies it). */
export interface BrowserErrorsRedis {
  hexists(key: string, field: string): Promise<number>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
  hset(key: string, field: string, value: string): Promise<number>;
  hincrby(key: string, field: string, n: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  expire(key: string, sec: number): Promise<number>;
}

/** One error as the agent and the dashboard read it. */
export interface BrowserErrorEntry {
  /** When it last happened (ISO). */
  at: string;
  first_seen: string;
  /** The version the page was served from. */
  version: number;
  type: BrowserErrorType;
  /** The page's path. */
  path: string;
  message: string;
  /** The stack with every frame of a built bundle mapped to the app's source file:line:column. */
  stack: string | null;
  /** Where it was thrown: the app's source file:line:column when the map knows it, else the script's. */
  source: string | null;
  count: number;
  ua: BrowserFamily;
}

/** The errors of one version in short (get_app `preview_errors`, write_files). */
export interface BrowserErrorSummary {
  /** Distinct errors. */
  count: number;
  /** How often they happened in all. */
  occurrences: number;
  latest_at: string | null;
}

export interface BrowserErrorStore {
  /** File a checked batch under version `version` of the app; the number of reports kept. */
  record(appId: string, version: number, batch: BrowserErrorBatch): Promise<number>;
  /** The errors that last happened at or after `since`, newest first, stacks mapped. */
  read(appId: string, opts: { since: Date; limit: number; version?: number }): Promise<BrowserErrorEntry[]>;
  summary(appId: string, version: number): Promise<BrowserErrorSummary>;
}

/** The built bundles of one version: the source map of each, decoded on demand. */
export interface VersionBundles {
  map(path: string): Promise<TraceMap | null>;
}

export interface BrowserErrorStoreOptions {
  redis?: () => BrowserErrorsRedis;
  limits?: BrowserErrorLimits;
  now?: () => number;
  /** The bundles of version `number` of the app (null = no such version). Default: Postgres. */
  bundles?: (appId: string, number: number) => Promise<VersionBundles | null>;
}

interface StoredReport {
  type: BrowserErrorType;
  message: string;
  stack: string | null;
  source: string | null;
  line: number | null;
  col: number | null;
  path: string;
  ua: BrowserFamily;
  first: number;
}

const appKey = (appId: string) => `drobek:browser-errors:${appId}`;
const versionKey = (appId: string, version: number) => `drobek:browser-errors:${appId}:v${version}`;
const sharedRedis = () => getRedis() as unknown as BrowserErrorsRedis;

/** The bundles of a version from Postgres (its built JS files and their inline maps). */
function dbVersionBundles(loaders: Pick<ServeLoaders, 'loadFiles' | 'loadBlobs'> = dbLoaders) {
  return async (appId: string, number: number): Promise<VersionBundles | null> => {
    const [row] = await getDb()
      .select({ id: appVersions.id })
      .from(appVersions)
      .where(and(eq(appVersions.appId, appId), eq(appVersions.number, number)))
      .limit(1);
    if (!row) return null;
    return bundlesOf(row.id, loaders);
  };
}

/** The bundles of version `versionId` read through `loaders`. */
export function bundlesOf(versionId: string, loaders: Pick<ServeLoaders, 'loadFiles' | 'loadBlobs'>): VersionBundles {
  let files: Promise<Map<string, string>> | null = null;
  const maps = new Map<string, Promise<TraceMap | null>>();
  const built = () =>
    (files ??= loaders
      .loadFiles(versionId)
      .then((fs) => new Map(fs.filter((f) => f.kind === 'built' && /\.m?js$/.test(f.path)).map((f) => [f.path, f.sha256]))));
  return {
    map(path) {
      const name = path.replace(/^\/+/, '');
      let hit = maps.get(name);
      if (!hit) {
        hit = (async () => {
          const sha = (await built()).get(name);
          if (!sha) return null;
          const bytes = (await loaders.loadBlobs([sha])).get(sha);
          const split = bytes ? splitInlineSourceMap(bytes, name) : null;
          if (!split) return null;
          try {
            return new TraceMap(split.map.toString('utf8'));
          } catch {
            return null;
          }
        })();
        maps.set(name, hit);
      }
      return hit;
    },
  };
}

/** A frame `[origin]/bundle.js[?query]:line:column` of a stack. */
const FRAME = /(?:https?:\/\/[^\s()/]+)?(\/[^\s():?#]+?\.m?js)(?:\?[^\s():#]*)?:(\d+):(\d+)/g;

/** The app's own name of a source in a bundle's map (`app:src/App.tsx` → `src/App.tsx`). */
function sourceName(source: string): string {
  return source.startsWith('app:') ? source.slice('app:'.length) : source;
}

async function mapPosition(bundles: VersionBundles, path: string, line: number, col: number): Promise<string | null> {
  const map = await bundles.map(path);
  if (!map || line < 1) return null;
  const pos = originalPositionFor(map, { line, column: Math.max(0, col - 1) });
  if (!pos.source || pos.line === null) return null;
  return `${sourceName(pos.source)}:${pos.line}:${(pos.column ?? 0) + 1}`;
}

/** `stack` with every frame of a built bundle replaced by the source position its map names. */
export async function mapStack(stack: string, bundles: VersionBundles): Promise<string> {
  const frames = [...stack.matchAll(FRAME)];
  if (frames.length === 0) return stack;
  const mapped = await Promise.all(frames.map((m) => mapPosition(bundles, m[1], Number(m[2]), Number(m[3]))));
  let out = '';
  let last = 0;
  frames.forEach((m, i) => {
    out += stack.slice(last, m.index) + (mapped[i] ?? m[0]);
    last = m.index! + m[0].length;
  });
  return out + stack.slice(last);
}

export function browserErrorStore(opts: BrowserErrorStoreOptions = {}): BrowserErrorStore {
  const redis = opts.redis ?? sharedRedis;
  const now = opts.now ?? Date.now;
  const bundlesFor = opts.bundles ?? dbVersionBundles();
  const limitsOf = () => opts.limits ?? browserErrorLimitsFromEnv();

  return {
    async record(appId, version, batch) {
      const r = redis();
      const limits = limitsOf();
      const ttl = limits.ttlHours * 3600;
      const key = versionKey(appId, version);
      const at = now();
      let kept = 0;
      for (const e of batch.errors) {
        if (!(await r.hexists(key, `e:${e.key}`))) {
          const n = await r.hincrby(key, 'n', 1);
          if (n > limits.maxPerVersion) {
            await r.hincrby(key, 'n', -1);
            continue;
          }
          const stored: StoredReport = {
            type: e.type,
            message: e.message,
            stack: e.stack,
            source: e.source,
            line: e.line,
            col: e.col,
            path: e.path,
            ua: batch.ua,
            first: at,
          };
          await r.hsetnx(key, `e:${e.key}`, JSON.stringify(stored));
        }
        await r.hincrby(key, `c:${e.key}`, e.count);
        await r.hset(key, `l:${e.key}`, String(at));
        kept++;
      }
      if (kept > 0) {
        await r.expire(key, ttl);
        await r.zadd(appKey(appId), at, String(version));
        await r.expire(appKey(appId), ttl);
      }
      return kept;
    },

    async read(appId, { since, limit, version }) {
      const r = redis();
      const versions =
        version !== undefined ? [version] : (await r.zrangebyscore(appKey(appId), since.getTime(), '+inf')).map(Number).filter((v) => v > 0);
      const rows: { entry: StoredReport; version: number; count: number; last: number }[] = [];
      for (const v of versions) {
        const h = await r.hgetall(versionKey(appId, v));
        for (const [field, raw] of Object.entries(h)) {
          if (!field.startsWith('e:')) continue;
          const k = field.slice(2);
          const last = Number(h[`l:${k}`] ?? 0);
          if (last < since.getTime()) continue;
          try {
            rows.push({ entry: JSON.parse(raw) as StoredReport, version: v, count: Number(h[`c:${k}`] ?? 1), last });
          } catch {
            /* a damaged row is skipped */
          }
        }
      }
      rows.sort((a, b) => b.last - a.last);
      const page = rows.slice(0, limit);
      const bundles = new Map<number, Promise<VersionBundles | null>>();
      const bundlesOfVersion = (v: number) => {
        let b = bundles.get(v);
        if (!b) {
          b = bundlesFor(appId, v).catch(() => null);
          bundles.set(v, b);
        }
        return b;
      };
      return Promise.all(
        page.map(async ({ entry, version: v, count, last }): Promise<BrowserErrorEntry> => {
          const b = await bundlesOfVersion(v);
          const at = entry.source && entry.line !== null && entry.col !== null ? { line: entry.line, col: entry.col } : null;
          const mappedSource = b && at && entry.source?.startsWith('/') ? await mapPosition(b, entry.source, at.line, at.col) : null;
          return {
            at: new Date(last).toISOString(),
            first_seen: new Date(entry.first).toISOString(),
            version: v,
            type: entry.type,
            path: entry.path,
            message: entry.message,
            stack: entry.stack && b ? await mapStack(entry.stack, b) : entry.stack,
            source: mappedSource ?? (entry.source ? `${entry.source}${at ? `:${at.line}:${at.col}` : ''}` : null),
            count,
            ua: entry.ua,
          };
        })
      );
    },

    async summary(appId, version) {
      const h = await redis().hgetall(versionKey(appId, version));
      let count = 0;
      let occurrences = 0;
      let latest = 0;
      for (const [field, value] of Object.entries(h)) {
        if (field.startsWith('e:')) count++;
        else if (field.startsWith('c:')) occurrences += Number(value) || 0;
        else if (field.startsWith('l:')) latest = Math.max(latest, Number(value) || 0);
      }
      return { count, occurrences, latest_at: latest > 0 ? new Date(latest).toISOString() : null };
    },
  };
}

/** What a beacon needs besides the request (seams for the tests). */
export interface BrowserErrorBeaconDeps {
  store: BrowserErrorStore;
  /** One beacon of this client IP to this app is allowed now (BROWSER_ERRORS_PER_IP_MINUTE). */
  allowIp?: (appId: string, ip: string, perMinute: number) => Promise<boolean>;
  limits?: BrowserErrorLimits;
}

const allowIpRedis = async (appId: string, ip: string, perMinute: number) =>
  (await rateLimitRedis('preview-errors', `${appId}:${ip}`, perMinute, 60_000)).ok;

/**
 * Take one beacon of a page of `app` on a preview or version host that serves
 * `served` (the caller already checked the password gate and that the
 * version collects errors). Never throws and never tells the page anything:
 * a beacon from another origin, a body that is too big or not JSON, a client
 * past its per-minute budget — all are dropped silently. The batch is filed
 * under the version the page names when the host has served it (1 … the
 * served number), else under the served version.
 */
export async function takeBrowserErrorBeacon(req: AppRequest, app: ServeApp, served: ServeVersion, deps: BrowserErrorBeaconDeps): Promise<void> {
  try {
    if (!beaconSameOrigin(req.header('origin'), req.header('host'), req.header('sec-fetch-site'))) return;
    const body = await req.readBody(MAX_ERRORS_BODY_BYTES);
    if (!Buffer.isBuffer(body) || body.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return;
    }
    const batch = parseBrowserErrors(parsed);
    if (!batch) return;
    const limits = deps.limits ?? browserErrorLimitsFromEnv();
    const ip = req.clientIp?.trim();
    if (ip && !(await (deps.allowIp ?? allowIpRedis)(app.id, ip, limits.perIpMinute))) return;
    const version =
      req.target?.kind === 'version' ? served.number : batch.version !== null && batch.version <= served.number ? batch.version : served.number;
    await deps.store.record(app.id, version, batch);
  } catch {
    /* error reports are best-effort */
  }
}

/** An in-memory BrowserErrorsRedis (tests; TTLs are not enforced). */
export function memoryBrowserErrorsRedis(): BrowserErrorsRedis & { ttl: Map<string, number> } {
  const hashes = new Map<string, Map<string, string>>();
  const zsets = new Map<string, Map<string, number>>();
  const ttl = new Map<string, number>();
  const hash = (k: string) => {
    let h = hashes.get(k);
    if (!h) hashes.set(k, (h = new Map()));
    return h;
  };
  return {
    ttl,
    async hexists(k, f) {
      return hash(k).has(f) ? 1 : 0;
    },
    async hsetnx(k, f, v) {
      if (hash(k).has(f)) return 0;
      hash(k).set(f, v);
      return 1;
    },
    async hset(k, f, v) {
      const isNew = !hash(k).has(f);
      hash(k).set(f, v);
      return isNew ? 1 : 0;
    },
    async hincrby(k, f, n) {
      const v = Number(hash(k).get(f) ?? 0) + n;
      hash(k).set(f, String(v));
      return v;
    },
    async hgetall(k) {
      return Object.fromEntries(hashes.get(k) ?? []);
    },
    async zadd(k, score, member) {
      let z = zsets.get(k);
      if (!z) zsets.set(k, (z = new Map()));
      z.set(member, score);
      return 1;
    },
    async zrangebyscore(k, min, max) {
      const lo = min === '-inf' ? -Infinity : Number(min);
      const hi = max === '+inf' ? Infinity : Number(max);
      return [...(zsets.get(k) ?? [])].filter(([, s]) => s >= lo && s <= hi).sort((a, b) => a[1] - b[1]).map(([m]) => m);
    },
    async expire(k, sec) {
      ttl.set(k, sec);
      return 1;
    },
  };
}
