/** How long an MCP session may go without a request before it is closed (1 hour). */
export const MCP_SESSION_IDLE_TTL_MS_DEFAULT = 60 * 60 * 1000;
/** Open MCP sessions one user may hold; a new one past it closes their least recently used. */
export const MCP_SESSIONS_PER_USER_DEFAULT = 10;

export interface McpSessionLimits {
  /** `MCP_SESSION_IDLE_TTL_MS`: a session with no request open for this long is closed. */
  idleTtlMs: number;
  /** `MCP_SESSIONS_PER_USER`: open sessions per user. */
  perUser: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The session limits from the env; a missing or invalid value keeps its default. */
export function mcpSessionLimits(env: NodeJS.ProcessEnv = process.env): McpSessionLimits {
  return {
    idleTtlMs: positiveInt(env.MCP_SESSION_IDLE_TTL_MS, MCP_SESSION_IDLE_TTL_MS_DEFAULT),
    perUser: positiveInt(env.MCP_SESSIONS_PER_USER, MCP_SESSIONS_PER_USER_DEFAULT),
  };
}
