/**
 * drobek MCP scope vocabulary (U5, PHY-71). Forward-compatible with the tool
 * batches that land later — U5 only *enforces* the read/whoami path; the
 * deploy/data scopes are issued + consented now so no token migration is
 * needed when U6/U10 mount their tools.
 *
 *   mcp:whoami   — identify the authed user/workspace/role (whoami tool is
 *                  ALWAYS available; this scope is granted for forward-compat).
 *   apps:read    — list apps in the token's workspace (ENFORCED now: gates the
 *                  list_apps tool).
 *   deploy:write — create/commit deploys (U6 — consented now, tool lands later).
 *   data:read    — read app data/collections (U10 — consented now).
 *   data:write   — mutate app data/collections (U10 — consented now).
 */
export const SCOPES = [
  'mcp:whoami',
  'apps:read',
  'deploy:write',
  'data:read',
  'data:write',
] as const;

export type Scope = (typeof SCOPES)[number];

/** Scopes an MCP client gets when it requests none — the read/whoami baseline. */
export const DEFAULT_SCOPES: readonly Scope[] = ['mcp:whoami', 'apps:read'];

const SCOPE_SET = new Set<string>(SCOPES);

export function isKnownScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

/**
 * Parse a space-delimited scope string into the known-scope subset (unknown
 * scopes are dropped, never errored — RFC 6749 §3.3). Empty/absent input →
 * the DEFAULT_SCOPES baseline so a client that omits `scope` still works.
 */
export function parseScopes(raw: string | null | undefined): Scope[] {
  const requested = (raw ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isKnownScope);
  const unique = Array.from(new Set(requested));
  return unique.length > 0 ? unique : [...DEFAULT_SCOPES];
}

/** Serialize a scope list back to the space-delimited wire form. */
export function serializeScopes(scopes: readonly string[]): string {
  return scopes.join(' ');
}

/** True when `granted` (space-delimited) contains `scope`. */
export function hasScope(granted: string | null | undefined, scope: Scope): boolean {
  if (!granted) return false;
  return granted.split(/\s+/).includes(scope);
}
