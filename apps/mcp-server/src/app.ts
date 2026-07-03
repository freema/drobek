import { coreVersion } from '@drobek/core';
import { mountMcpResource } from '@drobek/oauth/resource';
import express, { type Express } from 'express';

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
  app.use(express.json());

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

  return app;
}
