/**
 * recordBeacon — the core of the
 * PUBLIC, UNAUTHENTICATED error beacon `POST /__drobek/v1/_beacon`. The app
 * host has already resolved the app (and its password gate) and the HTTP
 * handler (rest.server.ts) enforced the 8 KiB size cap; this function owns
 * the rest of the contract:
 *   1. the page load (`load: true`, once per page): counted for the version
 *      in `app_version_loads` — a count only, behind its own per-app+IP and
 *      per-app buckets (drobek:rl:beacon-load:*), so page loads never spend
 *      the error budget; a refused or unknown-version load is not counted,
 *   2. per-app+IP, then per-app aggregate rate-limit (drobek:rl:beacon:*) → rate_limited,
 *   3. sample + SANITIZE each event (drop unknown fields, redact PII/secrets,
 *      truncate) — see sanitize.ts,
 *   4. insert with a computed dedup_key and the version, then RING-BUFFER
 *      prune (cap + age).
 * The version is the one the page says it was served from; when it says
 * none, the version the host serves now (`servedVersion`).
 */
import { rateLimitRedis } from '@drobek/auth';
import { perIpLimitKey } from '@drobek/core';
import { appErrors, getDb } from '@drobek/db';
import { sql } from 'drizzle-orm';
import { InsightsError } from './errors.js';
import {
  beaconLimitsFromEnv,
  extractBatch,
  shouldSample,
  type BeaconLimits,
} from './limits.js';
import {
  dedupKey,
  MAX_EVENTS_PER_BATCH,
  sanitizeEvent,
  type SanitizedEvent,
} from './sanitize.js';

export interface RecordBeaconInput {
  /** The app behind the host (resolved by @drobek/serving — never client input). */
  appId: string;
  /** The parsed JSON body (untrusted: `{ version?, load?, events: […] }`, an array, or a bare event). */
  batch: unknown;
  /** The resolved client IP; null = none → no per-IP bucket. */
  ip: string | null;
  /** The version the host serves right now (null = none) — used when the page did not say. */
  servedVersion?: number | null;
  env?: NodeJS.ProcessEnv;
  /** Sampler seam for tests; defaults to Math.random. */
  rng?: () => number;
}

export interface RecordBeaconResult {
  stored: number;
  /** The POST reported a page load and it was counted. */
  loadCounted: boolean;
}

export async function recordBeacon(
  input: RecordBeaconInput
): Promise<RecordBeaconResult> {
  const env = input.env ?? process.env;
  const limits = beaconLimitsFromEnv(env);
  const rng = input.rng ?? Math.random;

  const appId = input.appId;
  const batch = extractBatch(input.batch, MAX_EVENTS_PER_BATCH);
  const version = batch.version ?? input.servedVersion ?? null;
  const ip = perIpLimitKey(input.ip, 'beacon');

  // 1. The page load: its own buckets, never the error budget.
  const loadCounted =
    batch.load && version !== null ? await countPageLoad(appId, version, ip, limits) : false;
  if (batch.load && batch.events.length === 0) return { stored: 0, loadCounted };

  // 2. Rate-limit on TWO axes:
  //   a. per-app + per-IP — the normal per-client cap, AND
  //   b. per-app AGGREGATE (IP-independent) — bounds total ingest for one app
  //      even when an attacker rotates X-Forwarded-For to dodge the per-IP cap.
  // The per-IP bucket is checked FIRST: a request it refuses never
  // reaches the app bucket, so one client can spend at most its own per-IP
  // share of the app's budget and can never silence the app's error log.
  // No resolved client IP → only the aggregate applies (never a shared
  // `unknown` per-IP bucket).
  if (!(await withinLimits('beacon', appId, ip, limits))) {
    throw new InsightsError('rate_limited', 'too many beacons; slow down');
  }

  // 3. Sanitize, sample.
  const events: SanitizedEvent[] = batch.events
    .map(sanitizeEvent)
    .filter(() => shouldSample(limits.sampleRate, rng()));
  if (events.length === 0) return { stored: 0, loadCounted };

  // 4. Insert + ring-buffer prune.
  await getDb()
    .insert(appErrors)
    .values(
      events.map((e) => ({
        appId,
        type: e.type,
        message: e.message,
        stack: e.stack,
        url: e.url,
        ua: e.ua,
        ts: e.ts !== null ? new Date(e.ts) : null,
        dedupKey: dedupKey(e.message, e.stack),
        versionNumber: version,
      }))
    );
  await pruneAppErrors(appId, limits);

  return { stored: events.length, loadCounted };
}

/** The per-app+IP bucket first, then the per-app aggregate (see recordBeacon). */
async function withinLimits(bucket: string, appId: string, ip: string | null, limits: BeaconLimits): Promise<boolean> {
  if (ip !== null && !(await rateLimitRedis(bucket, `${appId}:${ip}`, limits.rateLimit, limits.windowMs)).ok) return false;
  return (await rateLimitRedis(bucket, `app:${appId}`, limits.appRateLimit, limits.windowMs)).ok;
}

/**
 * Count one page load of `version` — only a version the app has (a made-up
 * number from a client stores nothing). Best-effort: a limiter or database
 * failure leaves the load uncounted and never fails the beacon.
 */
async function countPageLoad(appId: string, version: number, ip: string | null, limits: BeaconLimits): Promise<boolean> {
  try {
    if (!(await withinLimits('beacon-load', appId, ip, limits))) return false;
    const counted = await getDb().execute(
      sql`insert into app_version_loads (app_id, version_number, page_loads, updated_at)
          select ${appId}::text, ${version}::integer, 1, now()
          where exists (select 1 from app_versions where app_id = ${appId} and number = ${version})
          on conflict (app_id, version_number)
          do update set page_loads = app_version_loads.page_loads + 1, updated_at = now()
          returning page_loads`
    );
    return rowCount(counted) > 0;
  } catch {
    return false;
  }
}

/** Rows of a drizzle `execute` result (postgres-js: an array; PGlite: `{ rows }`). */
function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Ring-buffer prune: drop events older than the retention window, then trim to
 * the newest N. Best-effort — a prune failure must not fail the beacon write.
 */
export async function pruneAppErrors(
  appId: string,
  limits: BeaconLimits
): Promise<void> {
  try {
    const cutoffMs = Date.now() - limits.retentionDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs);
    await getDb().execute(
      sql`delete from app_errors where app_id = ${appId} and created_at < ${cutoff.toISOString()}`
    );
    await getDb().execute(
      sql`delete from app_errors where app_id = ${appId} and id not in (
            select id from app_errors where app_id = ${appId}
            order by created_at desc limit ${limits.maxEventsPerApp}
          )`
    );
  } catch {
    /* prune is a maintenance sweep — never fail the write on it */
  }
}
