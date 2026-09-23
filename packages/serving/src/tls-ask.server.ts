/**
 * node:http adapter + Postgres lookup for Caddy's on-demand TLS `ask`
 * endpoint (M0-07). The decision itself lives in tls-ask.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq, isNull } from 'drizzle-orm';
import { hostConfig, type HostConfig } from '@drobek/apps';
import { createConsoleLogger, type Logger } from '@drobek/core';
import { apps, getDb } from '@drobek/db';
import { TLS_ASK_TOKEN_HEADER, decideTlsAsk, tlsAskToken, type TlsAskStatus } from './tls-ask.js';

/**
 * True when a live, non-deleted app owns `slug` — the same apps the app hosts
 * serve (a soft-deleted or hibernated app gets no certificate).
 */
export async function appSlugIsLive(slug: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ status: apps.status })
    .from(apps)
    .where(and(eq(apps.slug, slug), isNull(apps.deletedAt)))
    .limit(1);
  return row?.status === 'live';
}

export interface TlsAskHandlerOptions {
  /** Default: from TLS_ASK_TOKEN (read once, at mount). */
  token?: string | null;
  /** Default: from APPS_DOMAIN + PUBLIC_APP_URL. */
  hosts?: HostConfig;
  appExists?: (slug: string) => Promise<boolean>;
  log?: Logger;
}

const BODY: Record<TlsAskStatus, string> = { 200: 'ok', 401: 'unauthorized', 404: 'not found' };

function send(res: ServerResponse, status: TlsAskStatus): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.end(BODY[status]);
}

function single(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v.length === 1 ? v[0] : null) : v;
}

/** `GET /api/internal/tls/ask?domain=<host>&token=<TLS_ASK_TOKEN>` → 200 | 401 | 404. */
export function createTlsAskHandler(
  opts: TlsAskHandlerOptions = {}
): (req: IncomingMessage, res: ServerResponse) => void {
  const token = opts.token !== undefined ? opts.token : tlsAskToken();
  const hosts = opts.hosts ?? hostConfig();
  const appExists = opts.appExists ?? appSlugIsLive;
  const log = opts.log ?? createConsoleLogger('tls-ask');
  let warnedUnset = false;

  return (req, res) => {
    if (!token && !warnedUnset) {
      warnedUnset = true;
      log.warn('TLS ask endpoint called but TLS_ASK_TOKEN is not set — refusing every certificate');
    }
    const url = new URL(req.url ?? '/', 'http://internal.invalid');
    const params = url.searchParams;
    // A repeated parameter is ambiguous → treat as absent.
    const one = (name: string) => (params.getAll(name).length === 1 ? params.get(name) : null);
    decideTlsAsk(
      {
        domain: one('domain'),
        token: one('token') ?? single(req.headers[TLS_ASK_TOKEN_HEADER]),
        requestHost: single(req.headers.host),
      },
      { expectedToken: token, hosts, appExists }
    ).then(
      (status) => {
        if (status === 200) log.info('tls ask: allowed', { domain: one('domain') });
        send(res, status);
      },
      (err: unknown) => {
        // Fail closed: a DB hiccup must never turn into a certificate.
        log.error('tls ask failed', { error: String((err as Error)?.message ?? err) });
        res.statusCode = 503;
        res.setHeader('Cache-Control', 'no-store');
        res.end('unavailable');
      }
    );
  };
}
