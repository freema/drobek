/**
 * drobek MCP scope vocabulary + the tool → scope table.
 *
 * Three scopes, one consent checkbox each. A grant (OAuth token or API key) is
 * bound to a USER; the scope decides WHICH tools exist for it, and the user's
 * membership role in the targeted workspace decides what each call may touch.
 *
 *   read    — look: list apps (+ who am I), get an app, read its files, read skills,
 *             query an app's stored data, read its logs, list its assets and
 *             its custom domains, a workspace's members, and (workspace admins)
 *             the workspace's proxy upstreams.
 *   write   — change: create apps (also as a copy of a gallery app,
 *             `duplicate_app`), write files (new versions), restore,
 *             configure platform modules, upload (upload URLs) and delete assets,
 *             add, verify and remove custom domains, register and
 *             remove proxy upstreams without a secret, change a member's
 *             role, remove a member or leave a workspace, delete a team
 *             workspace.
 *   publish — make a version live at its public URL (the `publish` tool),
 *             list it in the public gallery (`set_gallery_listing`) and
 *             choose the primary domain the production address redirects to
 *             (`set_primary_domain`);
 *             a super-admin also allows or blocks a workspace's publishing
 *             (`set_workspace_publishing`, registered for super-admins only).
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
 */
export const TOOL_SCOPES = {
  list_apps: 'read',
  get_app: 'read',
  read_file: 'read',
  skill_info: 'read',
  query_data: 'read',
  get_logs: 'read',
  list_assets: 'read',
  list_domains: 'read',
  list_upstreams: 'read',
  create_app: 'write',
  // A copy of a gallery app in the caller's workspace, like create_app.
  duplicate_app: 'write',
  write_files: 'write',
  restore_version: 'write',
  configure_module: 'write',
  // A run writes the fetched records into the app's data, like the scheduled run.
  sync_now: 'write',
  create_asset_upload: 'write',
  delete_asset: 'write',
  add_domain: 'write',
  verify_domain: 'write',
  remove_domain: 'write',
  register_upstream: 'write',
  remove_upstream: 'write',
  // Workspace members: reading them is read, changing a role or removing someone is write.
  list_members: 'read',
  set_member_role: 'write',
  remove_member: 'write',
  // Deleting a team workspace changes what exists, like the other workspace-admin tools.
  delete_workspace: 'write',
  publish: 'publish',
  // Listing in the public gallery is public exposure, like publishing.
  set_gallery_listing: 'publish',
  // The primary domain decides where the production address sends every visitor.
  set_primary_domain: 'publish',
  // Who may publish is decided under the publish scope; @drobek/mcp registers it for super-admins only.
  set_workspace_publishing: 'publish',
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
