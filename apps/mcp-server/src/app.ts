import { coreVersion } from '@drobek/core';
import express, { type Express } from 'express';
import { protectedResourceMetadata } from './oauth-resource.js';
import { mountMcpEndpoint } from './mcp.js';

/**
 * drobek MCP server — U5 (PHY-71/PHY-53).
 *
 * D3 (ratified): the MCP liveness path is `/health` (NOT /healthz) and returns
 * a static `{ok:true}` — nginx/deploy scripts curl exactly this. Unchanged.
 *
 * U5 adds: OAuth 2.1 protected-resource discovery + a Bearer-gated Streamable
 * HTTP MCP endpoint at `/mcp` (whoami + list_apps). The deploy tools
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

  // OAuth 2.1 protected-resource metadata (RFC 9728). MCP clients fetch this
  // (directly or via the 401 WWW-Authenticate pointer) to discover the AS.
  const resourceMetadata = (_req: express.Request, res: express.Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(protectedResourceMetadata());
  };
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/*', resourceMetadata);

  // Bearer-gated MCP endpoint (Streamable HTTP) at POST/GET/DELETE /mcp.
  mountMcpEndpoint(app);

  return app;
}
