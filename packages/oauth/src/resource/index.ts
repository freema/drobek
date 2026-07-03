/**
 * @drobek/oauth/resource — the Express-mountable MCP OAuth 2.1 Protected
 * Resource + Streamable HTTP `/mcp` endpoint (U5, PHY-71/PHY-53).
 *
 * Extracted verbatim from apps/mcp-server so BOTH editions (selfhost core +
 * saas) can mount it thin: each edition owns only its `/health` + `/version`
 * and calls `mountMcpResource(app)` for everything OAuth/MCP.
 *
 * This entry is PURE Node/Express — it imports NO react / react-router (it is
 * deliberately isolated from `../routes/*`), so an Express consumer never pulls
 * the web framework into its runtime.
 */
import type { Express, Request, Response } from 'express';
import { protectedResourceMetadata } from './oauth-resource.js';
import { mountMcpEndpoint } from './mcp.js';

export {
  mcpResourceUri,
  authorizationServer,
  protectedResourceMetadata,
  send401,
  authenticate,
  stillGrantsRole,
  isSuperAdminEmail,
  type AuthContext,
  type AuthOutcome,
} from './oauth-resource.js';
export { buildMcpServer, mountMcpEndpoint } from './mcp.js';

/**
 * Register the OAuth 2.1 protected-resource discovery routes (RFC 9728) + the
 * Bearer-gated Streamable HTTP MCP endpoint (POST/GET/DELETE `/mcp`) on an
 * existing Express app. Behavior-identical to the previous app-local wiring in
 * apps/mcp-server: the caller is responsible for `express.json()` body parsing.
 */
export function mountMcpResource(app: Express): void {
  // OAuth 2.1 protected-resource metadata (RFC 9728). MCP clients fetch this
  // (directly or via the 401 WWW-Authenticate pointer) to discover the AS.
  const resourceMetadata = (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(protectedResourceMetadata());
  };
  app.get('/.well-known/oauth-protected-resource', resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/*', resourceMetadata);

  // Bearer-gated MCP endpoint (Streamable HTTP) at POST/GET/DELETE /mcp.
  mountMcpEndpoint(app);
}
