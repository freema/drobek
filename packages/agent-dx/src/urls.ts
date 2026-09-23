/**
 * Public-origin helpers for the agent docs (M1b, PHY-124). Mirror the resolution
 * in @drobek/oauth/resource and @drobek/deploy so the rendered URLs match what
 * the running stack actually serves — without taking a dependency on those
 * packages (agent-dx is a zero-dep leaf).
 */

/** The drobek web origin (OAuth AS + app serving). */
export function publicAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.PUBLIC_APP_URL?.trim() ||
    env.PUBLIC_ORIGIN?.trim() ||
    'http://localhost:3041';
  return raw.replace(/\/+$/, '');
}

/**
 * The Streamable HTTP MCP endpoint agents connect to — also the canonical
 * OAuth resource identifier (RFC 8707 token audience). One process serves the
 * dashboard, the AS and the MCP RS, so it defaults to `PUBLIC_APP_URL + /mcp`;
 * `PUBLIC_MCP_URL` (a full endpoint URL) overrides it.
 */
export function mcpEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_MCP_URL?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return `${publicAppUrl(env)}/mcp`;
}

/**
 * RFC 9728 protected-resource metadata URL for the MCP endpoint: the
 * well-known suffix goes between the origin and the resource path.
 */
export function protectedResourceMetadataUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  const url = new URL(mcpEndpoint(env));
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}
