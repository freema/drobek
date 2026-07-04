/**
 * recordBeacon (PHY-123) — the core of the PUBLIC, UNAUTHENTICATED error beacon.
 * The HTTP handler (rest.server.ts) has already enforced the 8 KB size cap; this
 * function owns the rest of the contract:
 *   1. resolve the app (unknown/deleted → not_found, rejected),
 *   2. per-app + per-IP rate-limit (drobek:rl:beacon:*) → rate_limited,
 *   3. sample + SANITIZE each event (drop unknown fields, redact PII/secrets,
 *      truncate) — see sanitize.ts,
 *   4. insert with a computed dedup_key, then RING-BUFFER prune (cap + age).
 */
import { rateLimitRedis } from '@drobek/auth';
import { appErrors, getDb } from '@drobek/db';
import { sql } from 'drizzle-orm';
import { InsightsError } from './errors.js';
import {
  beaconLimitsFromEnv,
  extractEvents,
  shouldSample,
  type BeaconLimits,
} from './limits.js';
import { resolveLiveApp } from './resolve.server.js';
import {
  dedupKey,
  MAX_EVENTS_PER_BATCH,
  sanitizeEvent,
  type SanitizedEvent,
} from './sanitize.js';

export interface RecordBeaconInput {
  wsSlug: string;
  appSlug: string;
  /** The parsed JSON body (untrusted: array, {events:[…]}, or a bare event). */
  batch: unknown;
  ip: string;
  env?: NodeJS.ProcessEnv;
  /** Sampler seam for tests; defaults to Math.random. */
  rng?: () => number;
}

export interface RecordBeaconResult {
  stored: number;
}

export async function recordBeacon(
  input: RecordBeaconInput
): Promise<RecordBeaconResult> {
  const env = input.env ?? process.env;
  const limits = beaconLimitsFromEnv(env);
  const rng = input.rng ?? Math.random;

  // 1. Resolve — unknown/deleted app is rejected (never stored).
  const { appId } = await resolveLiveApp({
    wsSlug: input.wsSlug,
    appSlug: input.appSlug,
  });

  // 2. Rate-limit on TWO axes:
  //   a. per-app + per-IP — the normal per-client cap, AND
  //   b. per-app AGGREGATE (IP-independent) — bounds total ingest for one app
  //      even when an attacker rotates X-Forwarded-For to dodge the per-IP cap.
  // Evaluate the aggregate cap first so IP-rotation floods are throttled before
  // they can each spend a fresh per-IP bucket.
  const app = await rateLimitRedis(
    'beacon',
    `app:${appId}`,
    limits.appRateLimit,
    limits.windowMs
  );
  if (!app.ok) {
    throw new InsightsError('rate_limited', 'too many beacons; slow down');
  }
  const perIp = await rateLimitRedis(
    'beacon',
    `${appId}:${input.ip}`,
    limits.rateLimit,
    limits.windowMs
  );
  if (!perIp.ok) {
    throw new InsightsError('rate_limited', 'too many beacons; slow down');
  }

  // 3. Cap the batch, sanitize, sample.
  const raw = extractEvents(input.batch, MAX_EVENTS_PER_BATCH);
  const events: SanitizedEvent[] = raw
    .map(sanitizeEvent)
    .filter(() => shouldSample(limits.sampleRate, rng()));
  if (events.length === 0) return { stored: 0 };

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
      }))
    );
  await pruneAppErrors(appId, limits);

  return { stored: events.length };
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
