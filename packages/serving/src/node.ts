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
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable, pipeline } from 'node:stream';
import { appsOrigin, classifyHost, hostConfig, splitHost, type AppHostTarget, type HostConfig } from '@drobek/apps';
import { getClientIp, rateLimitRedis } from '@drobek/auth';
import { createConsoleLogger, type Logger } from '@drobek/core';
import { handleBeacon, incrementServingSignal } from '@drobek/insights';
import {
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

/** The unlock form is tiny; anything bigger is not a password submission. */
const MAX_FORM_BYTES = 4096;

/** Platform (module) request bodies are capped by the route; this is the hard ceiling. */
const MAX_PLATFORM_BODY_BYTES = 1024 * 1024;

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
 * never buffered, and the connection stays usable for the response. A client
 * that goes away mid-body makes `next()` throw.
 */
export function requestBodyStream(req: IncomingMessage): AsyncIterableIterator<Buffer> {
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

function send(res: ServerResponse, r: AppResponse): void {
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

/** The production handler deps: HKDF'd access key, Redis limiter, insights counters + beacon. */
export function defaultHandlerDeps(store: ServeStore): HandlerDeps {
  return {
    store,
    accessSecret: appAccessSecret(),
    secureCookies: appCookiesSecure(),
    allowUnlockAttempt: async (appId, ip) =>
      (await rateLimitRedis('app-unlock', `${appId}:${ip ?? 'unknown'}`, UNLOCK_ATTEMPTS, UNLOCK_WINDOW_MS)).ok,
    signal: (appId, kind, path) => void incrementServingSignal(appId, kind, path),
    beacon: (req, app) => handleBeacon(req, app.id),
  };
}

export function createAppsHostMiddleware(opts: AppsHostOptions = {}): NodeMiddleware {
  const hosts = opts.hosts ?? hostConfig();
  const store = opts.store ?? new ServeStore();
  const deps: HandlerDeps = {
    ...defaultHandlerDeps(store),
    customDomainOrigin: customDomainOriginFor(hosts),
    ...opts.deps,
    store,
  };
  const log = opts.log ?? createConsoleLogger('apps-host');

  const plain = (res: ServerResponse, status: number, body: string) =>
    send(res, {
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
      plain(res, 400, 'Bad Request');
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
          plain(res, 503, 'Service Unavailable');
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

    handleAppRequest(request, deps).then(
      (r) => send(res, r),
      (err: unknown) => {
        log.error('app host request failed', { error: String((err as Error)?.stack ?? err) });
        if (res.headersSent) {
          res.destroy();
          return;
        }
        send(res, {
          status: 500,
          headers: {
            ...appSecurityHeaders({ noindex: true }),
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          },
          body: 'Internal Server Error',
        });
      }
    );
  }
}
