/**
 * The browser error beacon (M1-07, NSO-290) — runs in the BROWSER on the app's
 * own origin. The compiler adds `import "/__drobek/beacon.js?v=<hash>"` at the
 * top of every JS entry of an app (unless its drobek.json says
 * `"beacon": false`), so every app reports its uncaught errors and unhandled
 * promise rejections without configuration; the agent reads them with MCP
 * `get_logs({ kind: 'runtime' })`.
 *
 * Contract with the server (`POST /__drobek/v1/_beacon`, @drobek/insights):
 * same-origin, JSON `{ events: [{ type, message, stack, url, ua, ts }] }`,
 * ≤ 20 events and ≤ 8 KiB per POST (over-cap → 413). The server redacts
 * e-mails / tokens and truncates again — the client caps are only there so a
 * POST fits.
 *
 * Never throws, never recurses (an error while reporting is dropped), sends
 * at most 100 events per page load and at most 3 copies of the same error.
 */

export const BEACON_ENDPOINT = '/__drobek/v1/_beacon';
/** The server's hard cap per POST. */
export const BEACON_MAX_BYTES = 8 * 1024;
/** Events per POST (the server keeps at most 20 of a batch). */
export const BEACON_MAX_BATCH = 20;
/** Events per page load. */
export const BEACON_MAX_PER_PAGE = 100;
/** Copies of one identical error per page load. */
export const BEACON_MAX_REPEATS = 3;
/** Queued events are sent this long after the first one (and on pagehide). */
export const BEACON_FLUSH_MS = 1000;

const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_URL = 1024;
const MAX_UA = 400;
/** Leave headroom under the server cap for the JSON envelope. */
const BATCH_BUDGET = BEACON_MAX_BYTES - 256;

export interface BeaconEvent {
  type: 'error' | 'unhandledrejection';
  message: string;
  stack: string | null;
  url: string;
  ua: string | null;
  ts: number;
}

type Listener = (event: unknown) => void;

/** The slice of `window` the beacon uses (injectable for tests). */
export interface BeaconEnv {
  addEventListener(type: string, listener: Listener): void;
  location?: { href?: string };
  navigator?: { sendBeacon?: (url: string, data: Blob) => boolean; userAgent?: string };
  document?: { visibilityState?: string; addEventListener?(type: string, listener: Listener): void };
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
  setTimeout(fn: () => void, ms: number): unknown;
  Date?: { now(): number };
}

export interface BeaconHandle {
  /** Send what is queued now. */
  flush(): void;
  /** Events waiting to be sent. */
  pending(): number;
}

const INSTALLED = Symbol.for('drobek.beacon.installed');

function cap(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** An ErrorEvent / a rejection reason → the event the server stores. */
export function describeError(
  type: BeaconEvent['type'],
  raw: { message?: unknown; error?: unknown; reason?: unknown; filename?: unknown; lineno?: unknown; colno?: unknown },
  url: string,
  ua: string | null,
  ts: number
): BeaconEvent {
  const err = type === 'unhandledrejection' ? raw.reason : raw.error;
  let message: string;
  let stack: string | null = null;
  if (err instanceof Error) {
    message = err.message ? `${err.name}: ${err.message}` : err.name;
    stack = typeof err.stack === 'string' ? err.stack : null;
  } else if (type === 'unhandledrejection') {
    message = `Unhandled rejection: ${str(err)}`;
  } else {
    message = typeof raw.message === 'string' && raw.message ? raw.message : err === undefined || err === null ? '' : str(err);
  }
  if (!stack && typeof raw.filename === 'string' && raw.filename) {
    stack = `    at ${raw.filename}:${Number(raw.lineno) || 0}:${Number(raw.colno) || 0}`;
  }
  return {
    type,
    message: cap(message || '(no message)', MAX_MESSAGE),
    stack: stack ? cap(stack, MAX_STACK) : null,
    url: cap(url, MAX_URL),
    ua: ua ? cap(ua, MAX_UA) : null,
    ts,
  };
}

/**
 * Split events into POST bodies that each fit the server cap (≤ 20 events,
 * ≤ 8 KiB); an event too big on its own loses its stack, then its message tail.
 */
export function packBatches(events: BeaconEvent[]): string[] {
  const bodies: string[] = [];
  let batch: BeaconEvent[] = [];
  const body = (list: BeaconEvent[]) => JSON.stringify({ events: list });
  for (let e of events) {
    if (utf8Length(body([e])) > BATCH_BUDGET) e = { ...e, stack: null };
    if (utf8Length(body([e])) > BATCH_BUDGET) e = { ...e, message: cap(e.message, 200), url: cap(e.url, 200), ua: null };
    const next = [...batch, e];
    if (batch.length > 0 && (next.length > BEACON_MAX_BATCH || utf8Length(body(next)) > BATCH_BUDGET)) {
      bodies.push(body(batch));
      batch = [e];
    } else {
      batch = next;
    }
  }
  if (batch.length > 0) bodies.push(body(batch));
  return bodies;
}

/**
 * Register `error` + `unhandledrejection` listeners that report to the app's
 * beacon. Idempotent per window (a second call returns null).
 */
export function installBeacon(env: BeaconEnv = globalThis as unknown as BeaconEnv): BeaconHandle | null {
  const holder = env as unknown as Record<symbol, unknown>;
  if (!env || typeof env.addEventListener !== 'function' || holder[INSTALLED]) return null;
  holder[INSTALLED] = true;

  const queue: BeaconEvent[] = [];
  const seen = new Map<string, number>();
  let sent = 0;
  let timer = false;
  let busy = false;

  const now = () => (env.Date ?? Date).now();

  function send(bodyText: string): void {
    try {
      const nav = env.navigator;
      if (nav && typeof nav.sendBeacon === 'function' && typeof Blob !== 'undefined') {
        if (nav.sendBeacon(BEACON_ENDPOINT, new Blob([bodyText], { type: 'application/json' }))) return;
      }
      if (typeof env.fetch === 'function') {
        void Promise.resolve(
          env.fetch(BEACON_ENDPOINT, {
            method: 'POST',
            body: bodyText,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            keepalive: true,
          })
        ).catch(() => undefined);
      }
    } catch {
      /* reporting must never break the app */
    }
  }

  function flush(): void {
    timer = false;
    if (queue.length === 0) return;
    const events = queue.splice(0, queue.length);
    for (const b of packBatches(events)) send(b);
  }

  function report(type: BeaconEvent['type'], raw: Record<string, unknown>): void {
    if (busy) return;
    busy = true;
    try {
      if (sent >= BEACON_MAX_PER_PAGE) return;
      const ev = describeError(type, raw, String(env.location?.href ?? ''), env.navigator?.userAgent ?? null, now());
      const key = `${ev.type}\n${ev.message}\n${(ev.stack ?? '').split('\n').slice(0, 2).join('\n')}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > BEACON_MAX_REPEATS) return;
      sent += 1;
      queue.push(ev);
      if (!timer) {
        timer = true;
        env.setTimeout(flush, BEACON_FLUSH_MS);
      }
    } catch {
      /* never recurse into the error handler */
    } finally {
      busy = false;
    }
  }

  env.addEventListener('error', (e) => report('error', (e ?? {}) as Record<string, unknown>));
  env.addEventListener('unhandledrejection', (e) => report('unhandledrejection', (e ?? {}) as Record<string, unknown>));
  env.addEventListener('pagehide', () => flush());
  env.document?.addEventListener?.('visibilitychange', () => {
    if (env.document?.visibilityState === 'hidden') flush();
  });

  return { flush, pending: () => queue.length };
}
