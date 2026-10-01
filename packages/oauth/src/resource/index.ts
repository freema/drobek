/**
 * @drobek/oauth/resource — the Express-mountable MCP OAuth 2.1 Protected
 * Resource + Streamable HTTP `/mcp` endpoint (user-bound
 * grants, scopes read/write/publish and API keys).
 *
 * The tool bodies live in @drobek/mcp; this entry owns discovery, the Bearer
 * gate, the transport and the sessions.
 *
 * Mounted by the single drobek server process (apps/server) next to the
 * dashboard; each edition owns only its `/health` + `/version` and calls
 * `mountMcpResource(app)` for everything OAuth/MCP.
 *
 * This entry is PURE Node/Express — it imports NO react / react-router (it is
 * deliberately isolated from `../routes/*`), so an Express consumer never pulls
 * the web framework into its runtime.
 */
import type { Express, Request, Response } from 'express';
import { protectedResourceMetadata } from './oauth-resource.js';
import { mountMcpEndpoint, type McpEndpointOptions } from './mcp.js';

export {
  mcpResourceUri,
  resourceMetadataUrl,
  authorizationServer,
  protectedResourceMetadata,
  send401,
  authenticate,
  type AuthContext,
  type AuthOutcome,
} from './oauth-resource.js';
export { buildMcpServer, mountMcpEndpoint, type McpEndpointOptions } from './mcp.js';
export { registerDocs } from './docs.js';

/**
 * Register the OAuth 2.1 protected-resource discovery routes (RFC 9728) + the
 * Bearer-gated Streamable HTTP MCP endpoint (POST/GET/DELETE `/mcp`) on an
 * existing Express app. The endpoint parses its own request bodies (capped at
 * MCP_MAX_BODY_BYTES), so no JSON parser may run before it on `/mcp`.
 */
export function mountMcpResource(app: Express, opts: McpEndpointOptions = {}): void {
  // OAuth 2.1 protected-resource metadata (RFC 9728). MCP clients fetch this
  // (directly or via the 401 WWW-Authenticate pointer) to discover the AS.
  const resourceMetadata = (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(protectedResourceMetadata());
  };
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/*', resourceMetadata);

  // Bearer-gated MCP endpoint (Streamable HTTP) at POST/GET/DELETE /mcp.
  mountMcpEndpoint(app, opts);
}
