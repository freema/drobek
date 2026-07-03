import { coreVersion } from '@drobek/core';
import { mountMcpResource } from '@drobek/oauth/resource';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';

/**
 * drobek MCP server — U5 (PHY-71/PHY-53), core (selfhost) edition.
 *
 * D3 (ratified): the MCP liveness path is `/health` (NOT /healthz) and returns
 * a static `{ok:true}` — nginx/deploy scripts curl exactly this. Unchanged.
 *
 * The OAuth 2.1 protected-resource discovery + the Bearer-gated Streamable HTTP
 * MCP endpoint at `/mcp` (whoami + list_apps) now live in `@drobek/oauth/resource`
 * so BOTH editions mount them thin via `mountMcpResource(app)`. The deploy tools
 * (deploy_init / deploy_commit / …) land on this same app in U6.
 */
export function createApp(): Express {
  const app = express();
  // Cap the request body above the data-layer per-document byte cap (+ JSON-RPC
  // envelope headroom) so legitimate records reach the clean 413 from
  // @drobek/data, while an abusive oversized body is rejected by the parser.
  app.use(express.json({ limit: '512kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/version', (_req, res) => {
    res.json(coreVersion());
  });

  // OAuth 2.1 protected-resource metadata (RFC 9728) + the Bearer-gated
  // Streamable HTTP MCP endpoint at POST/GET/DELETE /mcp, owned by
  // @drobek/oauth/resource (shared by the selfhost + saas editions).
  mountMcpResource(app);

  // Clean JSON for body-parser failures (oversized / malformed) — never leak
  // express's default HTML error page (which discloses node_modules stack paths).
  app.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
      const e = err as { type?: string; status?: number };
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
    }
  );

  return app;
}
