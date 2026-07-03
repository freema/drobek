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

/** The mcp-server origin (OAuth Resource Server + Streamable HTTP /mcp). */
export function publicMcpUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_MCP_URL?.trim() || 'http://localhost:3042';
  return raw.replace(/\/+$/, '');
}

/** The Streamable HTTP MCP endpoint agents connect to. */
export function mcpEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return `${publicMcpUrl(env)}/mcp`;
}
