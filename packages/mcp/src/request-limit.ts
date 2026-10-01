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
