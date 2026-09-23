import { coreVersion } from '@drobek/core';
import { mountMcpResource } from '@drobek/oauth/resource';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

export interface ServerAppOptions {
  /**
   * The React Router request handler (dashboard, OAuth AS, app serving). In
   * dev it loads the build through Vite; in production from `build/server`.
   */
  rrHandler: RequestHandler;
  /** Extra middleware mounted before React Router (Vite dev middlewares). */
  before?: RequestHandler[];
  /** Absolute path of `build/client` — served statically in production. */
  clientDir?: string;
}

/**
 * The single drobek process (M0-01): one Express app serves the dashboard +
 * OAuth 2.1 AS (React Router) and the OAuth-protected MCP resource at `/mcp`.
 *
 * Order matters: the MCP/health routes are registered before React Router so
 * its `:ws/app/:slug/*` splat can never shadow them, and `express.json()` is
 * scoped to `/mcp` because React Router actions must read the raw body.
 */
export function createServerApp(opts: ServerAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  // Static liveness (D3) — no dependency checks; `/healthz` (React Router)
  // is the real `{ok, db, redis}` probe.
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/version', (_req, res) => {
    res.json(coreVersion());
  });

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
