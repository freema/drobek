import { createOriginCheckMiddleware } from '@drobek/auth';
import { coreVersion } from '@drobek/core';
import { mountMcpResource } from '@drobek/oauth/resource';
import { TLS_ASK_PATH, createAppsHostMiddleware, createTlsAskHandler } from '@drobek/serving';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

export interface ServerAppOptions {
  /**
   * The React Router request handler (dashboard, OAuth AS). In
   * dev it loads the build through Vite; in production from `build/server`.
   */
  rrHandler: RequestHandler;
  /** Extra middleware mounted before React Router (Vite dev middlewares). */
  before?: RequestHandler[];
  /** Absolute path of `build/client` — served statically in production. */
  clientDir?: string;
  /**
   * The app-host dispatcher (M0-06). Default: a fresh one from APPS_DOMAIN +
   * PUBLIC_APP_URL; index.ts passes one whose cache is wired to the
   * app-changed events.
   */
  appsHost?: RequestHandler;
  /** Caddy's on-demand TLS `ask` handler (M0-07). Default: from TLS_ASK_TOKEN. */
  tlsAsk?: RequestHandler;
}

/**
 * The single drobek process (M0-01): one Express app serves the dashboard +
 * OAuth 2.1 AS (React Router) and the OAuth-protected MCP resource at `/mcp`.
 *
 * Order matters:
 *  1. the app-host dispatcher (M0-06) runs FIRST: a request whose Host is an
 *     app host (`<slug>[--preview|--v<N>].<APPS_DOMAIN>`) is answered there and
 *     never reaches anything below — no dashboard route, no /mcp, no session
 *     code. The dashboard host never serves app files (there is no app route).
 *  2. the Origin check (CSRF) for every mutating dashboard request;
 *  3. health/version, Caddy's TLS `ask` endpoint (M0-07 — token-guarded,
 *     internal network only, blocked by Caddy on every public site), then `/mcp` (with `express.json()` scoped to it, because
 *     React Router actions must read the raw body), then React Router.
 */
export function createServerApp(opts: ServerAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(opts.appsHost ?? (createAppsHostMiddleware() as RequestHandler));
  app.use(createOriginCheckMiddleware() as RequestHandler);

  // Static liveness (D3) — no dependency checks; `/healthz` (React Router)
  // is the real `{ok, db, redis}` probe.
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/version', (_req, res) => {
    res.json(coreVersion());
  });
  app.get(TLS_ASK_PATH, opts.tlsAsk ?? (createTlsAskHandler() as RequestHandler));

  // Cap the MCP body above the data-layer per-document byte cap (+ JSON-RPC
  // envelope headroom) so legitimate records reach the clean 413 from
  // @drobek/data, while an abusive oversized body is rejected by the parser.
  app.use('/mcp', express.json({ limit: '512kb' }));
  // RFC 9728 discovery + the Bearer-gated Streamable HTTP endpoint.
  mountMcpResource(app);

  for (const mw of opts.before ?? []) app.use(mw);

  if (opts.clientDir) {
    // Fingerprinted Vite assets are immutable; everything else short-lived.
    app.use(
      '/assets',
      express.static(`${opts.clientDir}/assets`, { immutable: true, maxAge: '1y' })
    );
    app.use(express.static(opts.clientDir, { maxAge: '1h' }));
  }

  app.all('*', opts.rrHandler);

  // Clean JSON for body-parser failures (oversized / malformed) — never leak
  // express's default HTML error page (which discloses node_modules paths).
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    const e = err as { type?: string };
    if (e && (e.type === 'entity.too.large' || e.type === 'entity.parse.failed')) {
      res
        .status(e.type === 'entity.too.large' ? 413 : 400)
        .json({ ok: false, error: e.type.replace(/\./g, '_') });
      return;
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ ok: false, error: 'internal' });
  });

  return app;
}
