/**
 * In-flight caps for outbound proxy calls. Every proxied call holds a socket
 * (and a buffered answer up to PROXY_MAX_RESPONSE_BYTES, or a stream for up to
 * PROXY_STREAM_MAX_MS), so the number of calls in flight is capped for the
 * whole process (`PROXY_MAX_CONCURRENT`), per app
 * (`PROXY_MAX_CONCURRENT_PER_APP`: one app cannot take every slot) and per
 * caller of an app (`PROXY_MAX_CONCURRENT_PER_CALLER`: one visitor's open
 * streams cannot take the app's slots). A call over any cap is refused at
 * once with `proxy_busy` (429) — nothing queues.
 *
 * drobek is one Node process, so the counters are in memory.
 */
import { ProxyError } from './errors.js';
import { intEnv } from './ssrf.server.js';

export const DEFAULT_PROXY_MAX_CONCURRENT = 32;
export const DEFAULT_PROXY_MAX_CONCURRENT_PER_APP = 8;
export const DEFAULT_PROXY_MAX_CONCURRENT_PER_CALLER = 2;

export interface SlotCap {
  key: string;
  max: number;
}

/** Counts calls in flight, in total and per key. */
export class ConcurrencyGate {
  private total = 0;
  private readonly perKey = new Map<string, number>();

  /**
   * Take a slot counted under every key of `caps`, or null when `maxTotal`
   * calls are in flight or any key is at its `max`. The returned release is
   * idempotent.
   */
  tryAcquire(maxTotal: number, caps: readonly SlotCap[]): (() => void) | null {
    if (this.total >= maxTotal) return null;
    if (caps.some((c) => this.inFlight(c.key) >= c.max)) return null;
    this.total += 1;
    for (const c of caps) this.perKey.set(c.key, this.inFlight(c.key) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      for (const c of caps) {
        const left = this.inFlight(c.key) - 1;
        if (left <= 0) this.perKey.delete(c.key);
        else this.perKey.set(c.key, left);
      }
    };
  }

  /** Calls in flight (all keys, or one). */
  inFlight(key?: string): number {
    return key === undefined ? this.total : (this.perKey.get(key) ?? 0);
  }
}

const processGate = new ConcurrencyGate();

/**
 * Take a proxy slot for app `appId` (limits from `env`) and, when given, for
 * one caller of it (`callerKey`: the end user's id, or the client IP of an
 * anonymous visitor); throws ProxyError `proxy_busy` when the process, the
 * app or the caller is at its cap. Call the returned function when the call
 * is over (idempotent).
 */
export function acquireProxySlot(
  appId: string,
  env: NodeJS.ProcessEnv = process.env,
  gate: ConcurrencyGate = processGate,
  callerKey?: string | null
): () => void {
  const maxTotal = intEnv(env.PROXY_MAX_CONCURRENT, DEFAULT_PROXY_MAX_CONCURRENT);
  const maxPerApp = intEnv(env.PROXY_MAX_CONCURRENT_PER_APP, DEFAULT_PROXY_MAX_CONCURRENT_PER_APP);
  const maxPerCaller = intEnv(env.PROXY_MAX_CONCURRENT_PER_CALLER, DEFAULT_PROXY_MAX_CONCURRENT_PER_CALLER);
  const appKey = `app:${appId}`;
  const callerSlot = callerKey ? `caller:${appId}:${callerKey}` : null;
  const caps: SlotCap[] = [{ key: appKey, max: maxPerApp }];
  if (callerSlot) caps.push({ key: callerSlot, max: maxPerCaller });
  const release = gate.tryAcquire(maxTotal, caps);
  if (!release) {
    let message = 'The proxy is busy (too many upstream calls in flight) — retry in a moment.';
    if (callerSlot && gate.inFlight(callerSlot) >= maxPerCaller) {
      message = `Too many upstream calls of this visitor in flight (at most ${maxPerCaller}) — let one finish or stop a stream, then retry.`;
    } else if (gate.inFlight(appKey) >= maxPerApp) {
      message = `Too many upstream calls of this app in flight (at most ${maxPerApp}) — retry in a moment.`;
    }
    throw new ProxyError('proxy_busy', message);
  }
  return release;
}
