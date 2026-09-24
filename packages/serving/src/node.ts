/**
 * node:http / Express adapter for the app hosts (M0-06). `createAppsHostMiddleware`
 * is mounted FIRST in the server: it classifies the Host header and
 *   - dashboard host → `next()` (React Router, /mcp, … — the dashboard side);
 *   - apps host     → answers here and never calls `next()`, so an app request
 *                     can never reach the dashboard, the MCP resource or any
 *                     session code;
 *   - invalid Host  → 400;
 *   - custom-domain candidate (M3-01) → looked up in the domains table
 *     (ServeStore, cached 60 s): a verified domain is served as the app's
 *     production host, a registered-but-unverified one is an apps-side 404,
 *     an unknown name goes to `next()` like before. A failed lookup is a 503 —
 *     never the dashboard on a name that may belong to an app.
 * Typed on node:http only (Express req/res extend them), so any host app can
 * mount it without this package depending on Express.
 *
 * UNREAD BODIES (NSO-325): a response sent before the request body fully
 * arrived — a 413 in the middle of an upload, a 401 before a route read
 * anything, an oversized beacon — goes out with `Connection: close`; once it
 * is flushed the socket is half-closed and destroyed CLOSE_LINGER_MS (2 s)
 * later. The rest of the body is not drained to its end (keep-alive would read
 * all of it, for up to the server's 300 s requestTimeout). A `/__drobek/*`
 * request (module routes, the beacon) must deliver its whole body within
 * APPS_MODULE_BODY_TIMEOUT_MS (2 min): past it, 408 (or, when an answer is
 * already on its way, the connection is closed).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Readable, pipeline } from 'node:stream';
import { appsOrigin, classifyHost, hostConfig, splitHost, type AppHostTarget, type HostConfig } from '@drobek/apps';
import { getClientIp, rateLimitRedis } from '@drobek/auth';
import { createConsoleLogger, perIpLimitKey, type Logger } from '@drobek/core';
import { handleBeacon, incrementServingSignal } from '@drobek/insights';
import {
  PLATFORM_PREFIX,
  UNLOCK_APP_ATTEMPTS,
  UNLOCK_ATTEMPTS,
  UNLOCK_WINDOW_MS,
  handleAppRequest,
  type AppRequest,
  type AppResponse,
  type HandlerDeps,
} from './handler.js';
import { appSecurityHeaders } from './csp.js';
import { appAccessSecret, appCookiesSecure } from './password.js';
import { ServeStore } from './store.server.js';
import { UnknownHostLimiter, unknownHostLimitsFromEnv } from './unknown-host.js';

/** The unlock form is tiny; anything bigger is not a password submission. */
const MAX_FORM_BYTES = 4096;

/** Platform (module) request bodies are capped by the route; this is the hard ceiling. */
const MAX_PLATFORM_BODY_BYTES = 1024 * 1024;

/**
 * How long a connection closed under an unread body keeps discarding what the
 * client still sends after the answer went out (see closeAfterResponse).
 */
export const CLOSE_LINGER_MS = 2000;

/** Default APPS_MODULE_BODY_TIMEOUT_MS: how long a `/__drobek/*` request may take to deliver its body. */
export const DEFAULT_MODULE_BODY_TIMEOUT_MS = 120_000;

/** APPS_MODULE_BODY_TIMEOUT_MS (the production default when unset or not a positive integer). */
export function moduleBodyTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPS_MODULE_BODY_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MODULE_BODY_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MODULE_BODY_TIMEOUT_MS;
}

/** The body up to `limit` bytes; 'too_large' past it; null on a stream error. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too_large' | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | 'too_large' | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish('too_large');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

function headerOf(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(', ') : v;
}

/**
 * The request body as a pull stream (paused mode — nothing is read ahead of
 * the consumer, so a slow disk write back-pressures the client). `return()`
 * stops reading and lets the rest flow into the void: the upload is discarded,
 * never buffered, until the response is flushed and the connection closed
 * (`send` → closeAfterResponse). A client that goes away mid-body makes
 * `next()` throw.
 */
function requestBodyStream(req: IncomingMessage): AsyncIterableIterator<Buffer> {
  let ended = false;
  let failure: Error | null = null;
  let finished = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const onEnd = () => {
    ended = true;
    notify();
  };
  const onError = (err: Error) => {
    failure = err;
    notify();
  };
  const onClose = () => {
    if (!req.readableEnded) failure ??= new Error('the client aborted the request body');
    notify();
  };
  req.on('readable', notify);
  req.on('end', onEnd);
  req.on('error', onError);
  req.on('close', onClose);
  const cleanup = () => {
    finished = true;
    req.off('readable', notify);
    req.off('end', onEnd);
    req.off('error', onError);
    req.off('close', onClose);
  };
  const iter: AsyncIterableIterator<Buffer> = {
    [Symbol.asyncIterator]() {
      return iter;
    },
    async next() {
      for (;;) {
        if (finished) return { value: undefined, done: true };
        const chunk = req.read() as Buffer | null;
        if (chunk !== null) return { value: chunk, done: false };
        if (failure) {
          const err: Error = failure;
          cleanup();
          throw err;
        }
        if (ended || req.readableEnded) {
          cleanup();
          return { value: undefined, done: true };
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    async return() {
      if (!finished) {
        cleanup();
        if (!req.readableEnded) req.resume();
      }
      return { value: undefined, done: true };
    },
  };
  return iter;
}

/**
 * The request body is still arriving while we answer: close the connection
 * instead of draining the rest. `Connection: close` tells the client. Once
 * the response is flushed (`finish` = the last byte handed to the OS — never
 * under a half-written response) the socket is half-closed (FIN after the
 * answer), what the client still sends is discarded, and CLOSE_LINGER_MS
 * later the socket is destroyed — once.
 *
 * Why the linger: destroying at once while the client is still sending makes
 * the kernel answer its next segment with a RST, and a client kernel that
 * gets the RST drops the response it has not read yet — the uploader sees
 * "connection reset" instead of the 413. Node's own close for a
 * `Connection: close` response (`socket.destroySoon()`: FIN, then destroy as
 * soon as it is written) has exactly that race, so it is replaced for this
 * socket.
 */
function closeAfterResponse(req: IncomingMessage, res: ServerResponse): void {
  if (!res.headersSent) res.setHeader('Connection', 'close');
  const socket = req.socket as (Socket & { destroySoon?: () => void }) | null | undefined;
  if (!socket) return;
  socket.destroySoon = () => {}; // Node calls it on `finish` of a Connection: close response; we linger instead
  res.once('finish', () => {
    socket.end();
    req.resume();
    const timer = setTimeout(() => socket.destroy(), CLOSE_LINGER_MS);
    timer.unref?.();
    socket.once('close', () => clearTimeout(timer));
  });
}

function send(req: IncomingMessage, res: ServerResponse, r: AppResponse): void {
  if (!req.complete) closeAfterResponse(req, res);
  res.statusCode = r.status;
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  const body = r.body;
  if (body instanceof Readable) {
    pipeline(body, res, (err) => {
      if (err && !res.destroyed) res.destroy();
    });
    return;
  }
  res.end(body ?? undefined);
}

export interface AppsHostOptions {
  /** Default: from APPS_DOMAIN + PUBLIC_APP_URL. */
  hosts?: HostConfig;
  store?: ServeStore;
  deps?: Partial<Omit<HandlerDeps, 'store'>>;
  log?: Logger;
  /** Default: APPS_MODULE_BODY_TIMEOUT_MS. */
  moduleBodyTimeoutMs?: number;
}

/** `<scheme>://<hostname>[:port]` of a custom domain: the apps origin's scheme and port. */
function customDomainOriginFor(hosts: HostConfig): (hostname: string) => string {
  let scheme: 'http' | 'https' = 'https';
  try {
    scheme = appsOrigin().scheme;
  } catch {
    // hostConfig() already validated APPS_DOMAIN when it came from the env.
  }
  const port = splitHost(hosts.appsDomain)?.port ?? null;
  const suffix = port && !(scheme === 'https' && port === '443') && !(scheme === 'http' && port === '80') ? `:${port}` : '';
  return (hostname) => `${scheme}://${hostname}${suffix}`;
}

export type NodeMiddleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;

type RateCounter = (bucket: string, key: string, limit: number, windowMs: number) => Promise<{ ok: boolean }>;

/**
 * The password gate's attempt limiter: per app + client IP (UNLOCK_ATTEMPTS)
 * first, so one client cannot spend the app's budget, then per app over all
 * clients (UNLOCK_APP_ATTEMPTS). Without a resolved client IP there is no
 * per-IP bucket — never a shared `unknown` one — and only the per-app cap
 * applies (NSO-328).
 */
export async function unlockAttemptAllowed(
  appId: string,
  clientIp: string | null,
  counter: RateCounter = rateLimitRedis
): Promise<boolean> {
  const ip = perIpLimitKey(clientIp, 'app-unlock');
  if (ip !== null && !(await counter('app-unlock', `${appId}:${ip}`, UNLOCK_ATTEMPTS, UNLOCK_WINDOW_MS)).ok) return false;
  return (await counter('app-unlock-app', appId, UNLOCK_APP_ATTEMPTS, UNLOCK_WINDOW_MS)).ok;
}

/**
 * The production handler deps: HKDF'd access key, Redis limiters (unlock
 * attempts; NSO-315 unknown hosts per IP, APPS_UNKNOWN_HOST_LIMIT /
 * APPS_UNKNOWN_HOST_WINDOW_MS), insights counters + beacon.
 */
export function defaultHandlerDeps(store: ServeStore, log?: Logger): HandlerDeps {
  return {
    store,
    accessSecret: appAccessSecret(),
    secureCookies: appCookiesSecure(),
    allowUnlockAttempt: (appId, ip) => unlockAttemptAllowed(appId, ip),
    signal: (appId, kind, path) => void incrementServingSignal(appId, kind, path),
    beacon: (req, app) => handleBeacon(req, app.id),
    unknownHosts: new UnknownHostLimiter({
      ...unknownHostLimitsFromEnv(),
      counter: async (ip, limit, windowMs) => (await rateLimitRedis('apps-unknown-host', ip, limit, windowMs)).ok,
      onError: (err) => log?.warn('unknown-host limiter unavailable', { error: String((err as Error)?.message ?? err) }),
    }),
  };
}

export function createAppsHostMiddleware(opts: AppsHostOptions = {}): NodeMiddleware {
  const hosts = opts.hosts ?? hostConfig();
  const store = opts.store ?? new ServeStore();
  const log = opts.log ?? createConsoleLogger('apps-host');
  const moduleBodyTimeoutMs = opts.moduleBodyTimeoutMs ?? moduleBodyTimeoutFromEnv();
  const deps: HandlerDeps = {
    ...defaultHandlerDeps(store, log),
    customDomainOrigin: customDomainOriginFor(hosts),
    ...opts.deps,
    store,
  };

  const plain = (req: IncomingMessage, res: ServerResponse, status: number, body: string) =>
    send(req, res, {
      status,
      headers: {
        ...appSecurityHeaders({ noindex: true }),
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body,
    });

  return (req, res, next) => {
    const cls = classifyHost(headerOf(req, 'host'), hosts);
    if (cls.side === 'dashboard') {
      next();
      return;
    }
    if (cls.side === 'invalid') {
      plain(req, res, 400, 'Bad Request');
      return;
    }
    if (cls.side === 'custom') {
      store.resolveCustomHost(cls.hostname).then(
        (r) => {
          if (r === null) {
            next();
            return;
          }
          serve(req, res, r.slug ? { kind: 'custom', slug: r.slug, hostname: cls.hostname } : null);
        },
        (err: unknown) => {
          log.error('custom host lookup failed', { error: String((err as Error)?.message ?? err) });
          plain(req, res, 503, 'Service Unavailable');
        }
      );
      return;
    }
    serve(req, res, cls.target);
  };

  function serve(req: IncomingMessage, res: ServerResponse, target: AppHostTarget | null): void {
    const rawUrl = req.url ?? '/';
    const q = rawUrl.indexOf('?');
    const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const request: AppRequest = {
      method: req.method ?? 'GET',
      target,
      path: path.startsWith('/') ? path : `/${path}`,
      query: q === -1 ? '' : rawUrl.slice(q + 1),
      header: (name) => headerOf(req, name),
      headers: () => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        }
        return out;
      },
      clientIp:
        // getClientIp only reads headers (X-Real-IP, then the rightmost XFF hop).
        getClientIp({ headers: { get: (n: string) => headerOf(req, n) } } as unknown as Request) ?? null,
      readForm: async () => {
        const type = (headerOf(req, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/x-www-form-urlencoded') return null;
        const body = await readBody(req, MAX_FORM_BYTES);
        return Buffer.isBuffer(body) ? new URLSearchParams(body.toString('utf8')) : null;
      },
      readBody: async (limit) => {
        const cap = Math.min(limit, MAX_PLATFORM_BODY_BYTES);
        const declared = Number(headerOf(req, 'content-length') ?? NaN);
        if (Number.isFinite(declared) && declared > cap) return 'too_large';
        return readBody(req, cap);
      },
      bodyStream: () => requestBodyStream(req),
    };

    // Exactly one answer per request: after a 408 the route's own (late) answer is dropped.
    let answered = false;
    const answer = (r: AppResponse): void => {
      if (answered || res.headersSent || res.writableEnded) {
        if (r.body instanceof Readable) r.body.destroy();
        return;
      }
      answered = true;
      send(req, res, r);
    };

    let bodyTimer: NodeJS.Timeout | undefined;
    if (request.path.startsWith(PLATFORM_PREFIX) && !req.complete) {
      bodyTimer = setTimeout(() => {
        if (req.complete) return; // every byte arrived — the route is just busy
        if (answered || res.headersSent) {
          req.socket?.destroy();
          return;
        }
        answer({
          status: 408,
          headers: {
            ...appSecurityHeaders({ noindex: true }),
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
          body: JSON.stringify({
            error: 'request_timeout',
            message: `The request body did not arrive within ${Math.round(moduleBodyTimeoutMs / 1000)} s.`,
          }),
        });
      }, moduleBodyTimeoutMs);
      bodyTimer.unref();
      res.once('close', () => clearTimeout(bodyTimer));
    }

    handleAppRequest(request, deps).then(answer, (err: unknown) => {
      if (answered) return; // the body timed out and was answered; the route then failed reading it
      log.error('app host request failed', { error: String((err as Error)?.stack ?? err) });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      answer({
        status: 500,
        headers: {
          ...appSecurityHeaders({ noindex: true }),
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: 'Internal Server Error',
      });
    });
  }
}
