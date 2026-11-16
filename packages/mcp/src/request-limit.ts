import { limitsFromEnv } from '@drobek/compile';

/**
 * `MCP_MAX_BODY_BYTES`: the largest `/mcp` request body (one JSON-RPC
 * message, e.g. one write_files call). Default: twice the version total
 * (`COMPILE_MAX_TOTAL_BYTES`), so a write of a whole maximal app fits with
 * its JSON escaping.
 */
export function mcpMaxBodyBytes(
  env: NodeJS.ProcessEnv = process.env,
  maxTotalBytes: number = limitsFromEnv(env).maxTotalBytes
): number {
  const n = Number(env.MCP_MAX_BODY_BYTES);
  return Number.isInteger(n) && n > 0 ? n : 2 * maxTotalBytes;
}

const MCP_REQUESTS_PER_USER_MINUTE_DEFAULT = 600;

/**
 * `MCP_REQUESTS_PER_USER_MINUTE`: the `/mcp` requests one user may send in a
 * fixed minute, over all their API keys and OAuth connections together.
 * `0` turns the limit off; a missing or invalid value keeps the default.
 */
export function mcpRequestsPerUserMinute(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCP_REQUESTS_PER_USER_MINUTE?.trim();
  if (!raw) return MCP_REQUESTS_PER_USER_MINUTE_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : MCP_REQUESTS_PER_USER_MINUTE_DEFAULT;
}
