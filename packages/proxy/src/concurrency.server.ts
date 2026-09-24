/**
 * In-flight caps for outbound proxy calls (NSO-326). Every proxied call holds
 * a socket and buffers up to PROXY_MAX_RESPONSE_BYTES for up to 20 s, so the
 * number of calls in flight is capped for the whole process
 * (`PROXY_MAX_CONCURRENT`) and per app (`PROXY_MAX_CONCURRENT_PER_APP`): one
 * app cannot take every slot. A call over either cap is refused at once with
 * `proxy_busy` (429) — nothing queues.
 *
 * drobek is one Node process, so the counters are in memory.
 */
import { ProxyError } from './errors.js';
import { intEnv } from './ssrf.server.js';

export const DEFAULT_PROXY_MAX_CONCURRENT = 32;
export const DEFAULT_PROXY_MAX_CONCURRENT_PER_APP = 8;

/** Counts calls in flight, in total and per key. */
export class ConcurrencyGate {
  private total = 0;
  private readonly perKey = new Map<string, number>();

  /** Take a slot, or null when `maxTotal` or `maxPerKey` calls are in flight already. */
  tryAcquire(key: string, maxTotal: number, maxPerKey: number): (() => void) | null {
    const mine = this.perKey.get(key) ?? 0;
    if (this.total >= maxTotal || mine >= maxPerKey) return null;
    this.total += 1;
    this.perKey.set(key, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.perKey.get(key) ?? 1) - 1;
      if (left <= 0) this.perKey.delete(key);
      else this.perKey.set(key, left);
    };
  }

  /** Calls in flight (all keys, or one). */
  inFlight(key?: string): number {
    return key === undefined ? this.total : (this.perKey.get(key) ?? 0);
  }
}

const processGate = new ConcurrencyGate();

/**
 * Take a proxy slot for app `appId` (limits from `env`); throws ProxyError
 * `proxy_busy` when the process or the app is at its cap. Call the returned
 * function when the call is over (idempotent).
 */
export function acquireProxySlot(
  appId: string,
  env: NodeJS.ProcessEnv = process.env,
  gate: ConcurrencyGate = processGate
): () => void {
  const maxTotal = intEnv(env.PROXY_MAX_CONCURRENT, DEFAULT_PROXY_MAX_CONCURRENT);
  const maxPerApp = intEnv(env.PROXY_MAX_CONCURRENT_PER_APP, DEFAULT_PROXY_MAX_CONCURRENT_PER_APP);
  const release = gate.tryAcquire(appId, maxTotal, maxPerApp);
  if (!release) {
    throw new ProxyError(
      'proxy_busy',
      gate.inFlight(appId) >= maxPerApp
        ? `Too many upstream calls of this app in flight (at most ${maxPerApp}) — retry in a moment.`
        : 'The proxy is busy (too many upstream calls in flight) — retry in a moment.'
    );
  }
  return release;
}
