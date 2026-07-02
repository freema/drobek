import { coreVersion } from '@drobek/core';
import express, { type Express } from 'express';

/**
 * drobek MCP server — M0 skeleton.
 *
 * D3 (ratified): the MCP liveness path is `/health` (NOT /healthz) and
 * returns a static `{ok:true}` — nginx/deploy scripts curl exactly this.
 *
 * The real MCP tools (deploy_init / deploy_commit / deploy_status, OAuth
 * 2.1 resource metadata, Streamable HTTP transport) are M1a deliverables —
 * mount them on this app in createApp() when U5/U6 land.
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

  return app;
}
