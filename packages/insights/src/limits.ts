/**
 * Beacon caps + the pure security decisions (PHY-123). The beacon is public and
 * writes, so it is bounded on every axis: payload SIZE, per-app+IP RATE, a
 * SAMPLE rate, and a per-app ring-buffer RETENTION (count + age). All are pure
 * functions here (unit-tested) + env-tunable; the server modules apply them.
 */

/** Hard payload cap — reject (413) any beacon body larger than this. */
export const BEACON_MAX_BYTES = 8 * 1024;

export const DEFAULT_BEACON_RATE_LIMIT = 60;
/**
 * Per-app AGGREGATE cap (IP-independent) over the same window. The per-app+IP
 * limit alone is bypassable by rotating X-Forwarded-For — an attacker gets a
 * fresh bucket per spoofed IP — so this second, IP-independent cap bounds total
 * ingest (DB writes) for a single app regardless of source IP. Set high enough
 * to cover many legitimate concurrent users, low enough to bound a flood.
 */
export const DEFAULT_BEACON_APP_RATE_LIMIT = 600;
export const DEFAULT_BEACON_WINDOW_MS = 60_000;
/** Ring buffer: keep at most the newest N events per app (oldest evicted). */
export const DEFAULT_MAX_EVENTS_PER_APP = 500;
/** Ring buffer: drop events older than this many days. */
export const DEFAULT_RETENTION_DAYS = 14;
/** 1 = store every event; <1 = randomly sample (bounds storage under floods). */
export const DEFAULT_SAMPLE_RATE = 1;

export interface BeaconLimits {
  rateLimit: number;
  /** Per-app aggregate cap (IP-independent) over the same window. */
  appRateLimit: number;
  windowMs: number;
  maxEventsPerApp: number;
  retentionDays: number;
  sampleRate: number;
}

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function floatEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

export function beaconLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): BeaconLimits {
  return {
    rateLimit: intEnv(env.BEACON_RATE_LIMIT, DEFAULT_BEACON_RATE_LIMIT),
    appRateLimit: intEnv(
      env.BEACON_APP_RATE_LIMIT,
      DEFAULT_BEACON_APP_RATE_LIMIT
    ),
    windowMs: intEnv(env.BEACON_RATE_WINDOW_MS, DEFAULT_BEACON_WINDOW_MS),
    maxEventsPerApp: intEnv(
      env.BEACON_MAX_EVENTS_PER_APP,
      DEFAULT_MAX_EVENTS_PER_APP
    ),
    retentionDays: intEnv(env.BEACON_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
    sampleRate: floatEnv(env.BEACON_SAMPLE_RATE, DEFAULT_SAMPLE_RATE),
  };
}

/** Size gate — enforced BEFORE parsing the body. */
export function beaconSizeVerdict(
  byteLength: number,
  cap = BEACON_MAX_BYTES
): { ok: boolean } {
  return { ok: byteLength <= cap };
}

/** Keep this event? `rnd` is a [0,1) sample (Math.random in prod). */
export function shouldSample(rate: number, rnd: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return rnd < rate;
}

/** Coerce an untrusted batch to an event array, capped to MAX_EVENTS_PER_BATCH. */
export function extractEvents(payload: unknown, max: number): unknown[] {
  let list: unknown[];
  if (Array.isArray(payload)) {
    list = payload;
  } else if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { events?: unknown }).events)
  ) {
    list = (payload as { events: unknown[] }).events;
  } else if (payload && typeof payload === 'object') {
    // A single bare event object.
    list = [payload];
  } else {
    list = [];
  }
  return list.slice(0, max);
}
