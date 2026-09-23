/**
 * node:http / Express adapter for the app hosts (M0-06). `createAppsHostMiddleware`
 * is mounted FIRST in the server: it classifies the Host header and
 *   - dashboard host → `next()` (React Router, /mcp, … — the dashboard side);
 *   - apps host     → answers here and never calls `next()`, so an app request
 *                     can never reach the dashboard, the MCP resource or any
 *                     session code;
 *   - invalid Host  → 400.
 * Typed on node:http only (Express req/res extend them), so any host app can
 * mount it without this package depending on Express.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { classifyHost, hostConfig, type HostConfig } from '@drobek/apps';
import { getClientIp, rateLimitRedis } from '@drobek/auth';
import { createConsoleLogger, type Logger } from '@drobek/core';
import { incrementServingSignal } from '@drobek/insights';
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

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        finish(null);
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

function send(res: ServerResponse, r: AppResponse): void {
  res.statusCode = r.status;
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  res.end(r.body ?? undefined);
}

export interface AppsHostOptions {
  /** Default: from APPS_DOMAIN + PUBLIC_APP_URL. */
  hosts?: HostConfig;
  store?: ServeStore;
  deps?: Partial<Omit<HandlerDeps, 'store'>>;
  log?: Logger;
}

export type NodeMiddleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;

/** The production handler deps: HKDF'd access key, Redis limiter, insights counters. */
export function defaultHandlerDeps(store: ServeStore): HandlerDeps {
  return {
    store,
    accessSecret: appAccessSecret(),
    secureCookies: appCookiesSecure(),
    allowUnlockAttempt: async (appId, ip) =>
      (await rateLimitRedis('app-unlock', `${appId}:${ip ?? 'unknown'}`, UNLOCK_ATTEMPTS, UNLOCK_WINDOW_MS)).ok,
    signal: (appId, kind, path) => void incrementServingSignal(appId, kind, path),
  };
}

export function createAppsHostMiddleware(opts: AppsHostOptions = {}): NodeMiddleware {
  const hosts = opts.hosts ?? hostConfig();
  const store = opts.store ?? new ServeStore();
  const deps: HandlerDeps = { ...defaultHandlerDeps(store), ...opts.deps, store };
  const log = opts.log ?? createConsoleLogger('apps-host');

  return (req, res, next) => {
    const cls = classifyHost(headerOf(req, 'host'), hosts);
    if (cls.side === 'dashboard') {
      next();
      return;
    }
    if (cls.side === 'invalid') {
      send(res, {
        status: 400,
        headers: {
          ...appSecurityHeaders({ noindex: true }),
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: 'Bad Request',
      });
      return;
    }

    const rawUrl = req.url ?? '/';
    const q = rawUrl.indexOf('?');
    const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const request: AppRequest = {
      method: req.method ?? 'GET',
      target: cls.target,
      path: path.startsWith('/') ? path : `/${path}`,
      query: q === -1 ? '' : rawUrl.slice(q + 1),
      header: (name) => headerOf(req, name),
      clientIp:
        // getClientIp only reads headers (X-Real-IP, then the rightmost XFF hop).
        getClientIp({ headers: { get: (n: string) => headerOf(req, n) } } as unknown as Request) ?? null,
      readForm: async () => {
        const type = (headerOf(req, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/x-www-form-urlencoded') return null;
        const body = await readBody(req, MAX_FORM_BYTES);
        return body ? new URLSearchParams(body.toString('utf8')) : null;
      },
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
  };
}
