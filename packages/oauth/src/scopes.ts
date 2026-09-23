/**
 * drobek MCP scope vocabulary + the tool → scope table (M0-04, NSO-282).
 *
 * Three scopes, one consent checkbox each. A grant (OAuth token or API key) is
 * bound to a USER; the scope decides WHICH tools exist for it, and the user's
 * membership role in the targeted workspace decides what each call may touch.
 *
 *   read    — look: list apps (+ who am I), get an app, read its files.
 *   write   — change: create apps, write files (new versions), restore.
 *   publish — make a version live at its public URL (tool arrives in M0-06).
 *
 * `TOOL_SCOPES` is the ONE table both `tools/list` filtering and per-call
 * enforcement read (resource/mcp.ts).
 */
export const SCOPES = ['read', 'write', 'publish'] as const;

export type Scope = (typeof SCOPES)[number];

/** What a client that requests no scope gets offered on the consent screen. */
export const DEFAULT_SCOPES: readonly Scope[] = ['read', 'write'];

const SCOPE_SET = new Set<string>(SCOPES);

export function isKnownScope(value: string): value is Scope {
  return SCOPE_SET.has(value);
}

function splitScopes(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The known scopes in `raw`, deduped, in vocabulary order. Unknown ones are dropped. */
export function knownScopes(raw: string | null | undefined): Scope[] {
  const present = new Set(splitScopes(raw));
  return SCOPES.filter((s) => present.has(s));
}

/**
 * Parse a REQUESTED scope string (authorize): the known subset (unknown scopes
 * are dropped, never errored — RFC 6749 §3.3). An absent/empty request →
 * DEFAULT_SCOPES; a request naming only unknown scopes → [] (the caller answers
 * `invalid_scope`).
 */
export function parseScopes(raw: string | null | undefined): Scope[] {
  if (splitScopes(raw).length === 0) return [...DEFAULT_SCOPES];
  return knownScopes(raw);
}

/** Serialize a scope list back to the space-delimited wire form. */
export function serializeScopes(scopes: readonly string[]): string {
  return scopes.join(' ');
}

/** True when `granted` (space-delimited) contains `scope`. */
export function hasScope(granted: string | null | undefined, scope: Scope): boolean {
  return splitScopes(granted).includes(scope);
}

/**
 * Every MCP tool and the scope it needs (null = any valid grant). Adding a
 * tool means adding it HERE, in @drobek/mcp and in the @drobek/agent-dx
 * manifest — all three are drift-guarded by tool-docs-parity.test.ts.
 * `publish` unlocks no tool until the publish tool lands (M0-06).
 */
export const TOOL_SCOPES = {
  list_apps: 'read',
  get_app: 'read',
  read_file: 'read',
  create_app: 'write',
  write_files: 'write',
  restore_version: 'write',
} as const satisfies Record<string, Scope | null>;

export type ToolName = keyof typeof TOOL_SCOPES;

const TOOLS = Object.keys(TOOL_SCOPES) as ToolName[];

/** May a grant holding `granted` call (and see) `tool`? */
export function toolAllowed(granted: string | readonly Scope[], tool: ToolName): boolean {
  const needed = TOOL_SCOPES[tool];
  if (needed === null) return true;
  const scopes = typeof granted === 'string' ? knownScopes(granted) : granted;
  return scopes.includes(needed);
}

/** The tools a grant holding `granted` sees in tools/list, in table order. */
export function allowedTools(granted: string | readonly Scope[]): ToolName[] {
  return TOOLS.filter((t) => toolAllowed(granted, t));
}
