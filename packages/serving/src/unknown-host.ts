/**
 * Per-IP limit on "unknown app" answers of the apps origin (NSO-315).
 *
 * Wildcard DNS makes every label under APPS_DOMAIN a host, so a client can ask
 * for endless random slugs; each is a cache miss and one DB lookup. The
 * negative cache (ServeStore) absorbs repeats of the SAME host; this limiter
 * bounds how many DIFFERENT unknown hosts one client IP may ask for:
 *
 *  - every "no app here" 404 is counted in a shared fixed-window counter
 *    (Redis, `drobek:rl:apps-unknown-host:<ip>`, the same helper as the other
 *    limits) — so every replica shares the budget;
 *  - past the limit the answer is 429, and the IP is remembered IN PROCESS
 *    until the window ends: a throttled client's further requests to hosts the
 *    serve cache does not already know as live apps are answered 429 before
 *    any lookup — the DB is not touched at all.
 *
 * NSO-309: a request whose client IP is not recognised (null) is NEVER
 * counted — it would put every such client into one shared bucket and let one
 * of them lock the rest out. The negative cache still protects the DB there.
 * The counter failing (Redis down) fails open: the plain 404 is answered.
 */
import { CountLru } from './lru.js';

export const DEFAULT_UNKNOWN_HOST_LIMIT = 60;
export const DEFAULT_UNKNOWN_HOST_WINDOW_MS = 60_000;
/** How many throttled IPs one process remembers (LRU). */
const MAX_BLOCKED_IPS = 10_000;

export interface UnknownHostLimits {
  /** Unknown-app answers per client IP per window (APPS_UNKNOWN_HOST_LIMIT). */
  limit: number;
  /** The window (APPS_UNKNOWN_HOST_WINDOW_MS). */
  windowMs: number;
}

function intEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function unknownHostLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): UnknownHostLimits {
  return {
    limit: intEnv(env.APPS_UNKNOWN_HOST_LIMIT, DEFAULT_UNKNOWN_HOST_LIMIT),
    windowMs: intEnv(env.APPS_UNKNOWN_HOST_WINDOW_MS, DEFAULT_UNKNOWN_HOST_WINDOW_MS),
  };
}

/** The shared counter: count one hit for `key`, true while within `limit` per `windowMs`. */
export type UnknownHostCounter = (key: string, limit: number, windowMs: number) => Promise<boolean>;

export interface UnknownHostLimiterOptions extends Partial<UnknownHostLimits> {
  counter: UnknownHostCounter;
  now?: () => number;
  /** Told when the counter fails (the answer is then the plain 404). */
  onError?: (err: unknown) => void;
}

export class UnknownHostLimiter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly counter: UnknownHostCounter;
  private readonly now: () => number;
  private readonly onError?: (err: unknown) => void;
  /** ip → throttled until (epoch ms). */
  private readonly blockedUntil = new CountLru<number>(MAX_BLOCKED_IPS);

  constructor(opts: UnknownHostLimiterOptions) {
    this.limit = opts.limit ?? DEFAULT_UNKNOWN_HOST_LIMIT;
    this.windowMs = opts.windowMs ?? DEFAULT_UNKNOWN_HOST_WINDOW_MS;
    this.counter = opts.counter;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError;
  }

  /** No I/O: is `ip` over the limit right now (learned from an earlier count)? null → never. */
  isThrottled(ip: string | null): boolean {
    if (!ip) return false;
    const until = this.blockedUntil.get(ip);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.blockedUntil.delete(ip);
    return false;
  }

  /** Count one unknown-app answer for `ip`; false = over the limit (answer 429). null → not counted. */
  async allow(ip: string | null): Promise<boolean> {
    if (!ip) return true;
    let ok: boolean;
    try {
      ok = await this.counter(ip, this.limit, this.windowMs);
    } catch (err) {
      this.onError?.(err);
      return true;
    }
    if (!ok) this.blockedUntil.set(ip, this.now() + this.windowMs);
    return ok;
  }

  /** Seconds a throttled client should wait (Retry-After). */
  get retryAfterSec(): number {
    return Math.max(1, Math.ceil(this.windowMs / 1000));
  }
}
