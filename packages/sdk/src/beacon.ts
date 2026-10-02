/**
 * The browser beacon — runs in the BROWSER on the app's own origin. The
 * compiler adds `import "/__drobek/beacon.js?v=<hash>"` at the top of every JS
 * entry of an app (unless its drobek.json says `"beacon": false`), so every
 * app reports without configuration:
 *
 *  - that the page loaded (once per page load — a count only, nothing about
 *    the visitor),
 *  - its uncaught errors and unhandled promise rejections,
 *  - a script, stylesheet, image or media file that failed to load (the
 *    `error` event of the element, seen in the capture phase),
 *  - a request the Content-Security-Policy blocked (`securitypolicyviolation`).
 *
 * The agent reads them with MCP `get_logs({ kind: 'runtime' })` and the
 * per-version counts in `get_app` (`render`).
 *
 * Contract with the server (`POST /__drobek/v1/_beacon`, @drobek/insights):
 * same-origin, JSON `{ version, load?, events: [{ type, message, stack, url,
 * ua, ts }] }`, ≤ 20 events and ≤ 8 KiB per POST (over-cap → 413).
 * `version` is the app version the page was served from — the app host
 * names it in the document's `Server-Timing: drobek-version;desc="<N>"`
 * (null when the browser does not expose it: the server then files the
 * report under the version the host serves now). The server redacts
 * e-mails / tokens and truncates again — the client caps are only there so a
 * POST fits. The page `url` and every resource address are only origin +
 * path: a query string or fragment can carry one-time codes, tokens or PII
 * the redaction cannot recognise (`?code=123456`), so it never leaves the
 * browser.
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
/** The `Server-Timing` metric whose description is the version the page was served from. */
export const VERSION_TIMING_METRIC = 'drobek-version';

const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const MAX_URL = 1024;
const MAX_UA = 400;
/** Leave headroom under the server cap for the JSON envelope. */
const BATCH_BUDGET = BEACON_MAX_BYTES - 256;

export type BeaconEventType = 'error' | 'unhandledrejection' | 'resource' | 'csp';

export interface BeaconEvent {
  type: BeaconEventType;
  message: string;
  stack: string | null;
  url: string;
  ua: string | null;
  ts: number;
}

/** What every POST of a page says besides its events. */
export interface BeaconMeta {
  /** The app version the page was served from (null = unknown). */
  version: number | null;
  /** The first POST of a page load says so (`load: true`). */
  load?: boolean;
}

type Listener = (event: unknown) => void;

/** The slice of `window` the beacon uses (injectable for tests). */
export interface BeaconEnv {
  addEventListener(type: string, listener: Listener, capture?: boolean): void;
  location?: { href?: string };
  navigator?: { sendBeacon?: (url: string, data: Blob) => boolean; userAgent?: string };
  document?: { visibilityState?: string; addEventListener?(type: string, listener: Listener): void };
  performance?: { getEntriesByType?(type: string): unknown[] };
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

/**
 * The page address the beacon reports: origin + path only — no query string,
 * no fragment, no credentials. Anything unparsable is cut at the first `?`/`#`.
 */
export function pageUrl(href: unknown): string {
  const raw = typeof href === 'string' ? href : '';
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.origin}${u.pathname}`;
  } catch {
    /* fall through to the plain cut */
  }
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

/**
 * A resource address as reported: an http(s) URL as origin + path, another
 * URL only by its scheme (`data:`, `blob:` — their contents never leave the
 * browser), a CSP keyword (`inline`, `eval`) as it is.
 */
export function resourceAddress(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (/^https?:/i.test(value)) return pageUrl(value);
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme) return `${scheme[1].toLowerCase()}:`;
  return /^[a-z-]+$/i.test(value) ? value : '';
}

/**
 * The version the page was served from: the app host's
 * `Server-Timing: drobek-version;desc="<N>"` on the document. null when the
 * browser does not expose server timing (or the page was not served by drobek).
 */
export function pageVersion(env: Pick<BeaconEnv, 'performance'>): number | null {
  try {
    const [nav] = env.performance?.getEntriesByType?.('navigation') ?? [];
    const timings = (nav as { serverTiming?: { name?: unknown; description?: unknown }[] } | undefined)?.serverTiming ?? [];
    for (const t of timings) {
      if (t?.name !== VERSION_TIMING_METRIC) continue;
      const n = Number(t.description);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  } catch {
    /* no navigation timing → unknown */
  }
  return null;
}

function event(type: BeaconEventType, message: string, stack: string | null, url: string, ua: string | null, ts: number): BeaconEvent {
  return {
    type,
    message: cap(message || '(no message)', MAX_MESSAGE),
    stack: stack ? cap(stack, MAX_STACK) : null,
    url: cap(url, MAX_URL),
    ua: ua ? cap(ua, MAX_UA) : null,
    ts,
  };
}

/** An ErrorEvent / a rejection reason → the event the server stores. */
export function describeError(
  type: 'error' | 'unhandledrejection',
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
  return event(type, message, stack, url, ua, ts);
}

const RESOURCE_KINDS: Record<string, string> = {
  SCRIPT: 'script',
  IMG: 'image',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  SOURCE: 'media source',
  TRACK: 'text track',
  EMBED: 'embed',
  OBJECT: 'object',
};

/** The element whose load failed (an `error` event that did not come from the window) → the stored event. */
export function describeResource(
  el: { tagName?: unknown; rel?: unknown; currentSrc?: unknown; src?: unknown; href?: unknown },
  url: string,
  ua: string | null,
  ts: number
): BeaconEvent {
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  const kind =
    tag === 'LINK'
      ? String(el.rel ?? '').toLowerCase().split(/\s+/).includes('stylesheet')
        ? 'stylesheet'
        : 'link'
      : (RESOURCE_KINDS[tag] ?? (tag.toLowerCase() || 'resource'));
  const address = resourceAddress(
    [el.currentSrc, el.src, el.href].find((v) => typeof v === 'string' && v !== '') ?? ''
  );
  return event('resource', `Failed to load ${kind}${address ? `: ${address}` : ''}`, null, url, ua, ts);
}

/** A `securitypolicyviolation` event → the stored event; null for a report-only policy (nothing was blocked). */
export function describeViolation(
  raw: {
    blockedURI?: unknown;
    effectiveDirective?: unknown;
    violatedDirective?: unknown;
    sourceFile?: unknown;
    lineNumber?: unknown;
    columnNumber?: unknown;
    disposition?: unknown;
  },
  url: string,
  ua: string | null,
  ts: number
): BeaconEvent | null {
  if (raw.disposition === 'report') return null;
  const directive = [raw.effectiveDirective, raw.violatedDirective].find((v) => typeof v === 'string' && v !== '') ?? 'a directive';
  const blocked = resourceAddress(raw.blockedURI) || 'a request';
  const source = resourceAddress(raw.sourceFile);
  const stack = /^https?:/i.test(source) ? `    at ${source}:${Number(raw.lineNumber) || 0}:${Number(raw.columnNumber) || 0}` : null;
  return event('csp', `Content-Security-Policy blocked ${blocked} (${String(directive)})`, stack, url, ua, ts);
}

/**
 * Split events into POST bodies that each fit the server cap (≤ 20 events,
 * ≤ 8 KiB); an event too big on its own loses its stack, then its message tail.
 * Every body carries `version`; only the first says `load: true`. A page load
 * with no events is one body with an empty list.
 */
export function packBatches(events: BeaconEvent[], meta: BeaconMeta = { version: null }): string[] {
  const bodies: string[] = [];
  let batch: BeaconEvent[] = [];
  const body = (list: BeaconEvent[]) =>
    JSON.stringify({ version: meta.version, ...(meta.load && bodies.length === 0 ? { load: true } : {}), events: list });
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
  if (batch.length > 0 || (meta.load && bodies.length === 0)) bodies.push(body(batch));
  return bodies;
}

/** Is this `error` event about an element (a failed load) rather than the window (an uncaught error)? */
function failedElement(e: unknown, env: BeaconEnv): Record<string, unknown> | null {
  const target = (e as { target?: unknown } | null)?.target;
  if (!target || target === env || typeof target !== 'object') return null;
  return typeof (target as { tagName?: unknown }).tagName === 'string' ? (target as Record<string, unknown>) : null;
}

/**
 * Report this page's load, then listen for uncaught errors, unhandled
 * rejections, failed resource loads (capture phase — they do not bubble) and
 * CSP violations. Idempotent per window (a second call returns null).
 */
export function installBeacon(env: BeaconEnv = globalThis as unknown as BeaconEnv): BeaconHandle | null {
  const holder = env as unknown as Record<symbol, unknown>;
  if (!env || typeof env.addEventListener !== 'function' || holder[INSTALLED]) return null;
  holder[INSTALLED] = true;

  const queue: BeaconEvent[] = [];
  const seen = new Map<string, number>();
  const version = pageVersion(env);
  let loadPending = true;
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
    if (queue.length === 0 && !loadPending) return;
    const events = queue.splice(0, queue.length);
    const load = loadPending;
    loadPending = false;
    try {
      for (const b of packBatches(events, { version, load })) send(b);
    } catch {
      /* reporting must never break the app */
    }
  }

  function schedule(): void {
    if (timer) return;
    timer = true;
    try {
      env.setTimeout(flush, BEACON_FLUSH_MS);
    } catch {
      timer = false;
    }
  }

  function report(make: (url: string, ua: string | null, ts: number) => BeaconEvent | null): void {
    if (busy) return;
    busy = true;
    try {
      if (sent >= BEACON_MAX_PER_PAGE) return;
      const ev = make(pageUrl(env.location?.href), env.navigator?.userAgent ?? null, now());
      if (!ev) return;
      const key = `${ev.type}\n${ev.message}\n${(ev.stack ?? '').split('\n').slice(0, 2).join('\n')}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > BEACON_MAX_REPEATS) return;
      sent += 1;
      queue.push(ev);
      schedule();
    } catch {
      /* never recurse into the error handler */
    } finally {
      busy = false;
    }
  }

  env.addEventListener(
    'error',
    (e) => {
      const el = failedElement(e, env);
      if (el) report((url, ua, ts) => describeResource(el, url, ua, ts));
      else report((url, ua, ts) => describeError('error', (e ?? {}) as Record<string, unknown>, url, ua, ts));
    },
    true
  );
  env.addEventListener('unhandledrejection', (e) =>
    report((url, ua, ts) => describeError('unhandledrejection', (e ?? {}) as Record<string, unknown>, url, ua, ts))
  );
  env.addEventListener('securitypolicyviolation', (e) =>
    report((url, ua, ts) => describeViolation((e ?? {}) as Record<string, unknown>, url, ua, ts))
  );
  env.addEventListener('pagehide', () => flush());
  env.document?.addEventListener?.('visibilitychange', () => {
    if (env.document?.visibilityState === 'hidden') flush();
  });
  schedule();

  return { flush, pending: () => queue.length };
}
