/**
 * drobek MCP scope vocabulary + the tool → scope table.
 *
 * Three scopes, one consent checkbox each. A grant (OAuth token or API key) is
 * bound to a USER; the scope decides WHICH tools exist for it, and the user's
 * membership role in the targeted workspace decides what each call may touch.
 *
 *   read    — look: list apps (+ who am I), get an app, read its files and
 *             page its version history (`list_versions`), read skills,
 *             query an app's stored data, read its logs, list its assets and
 *             its custom domains, its form submissions, end users and uploads,
 *             a workspace's members, and (workspace admins) the workspace's
 *             proxy upstreams and activity log.
 *   write   — change: create apps (also as a copy of a gallery app,
 *             `duplicate_app`), write files (new versions), restore,
 *             keep a version and delete old versions (`keep_version`,
 *             `delete_versions`, the clean-up only after the user's yes),
 *             configure platform modules, upload (upload URLs) and delete assets,
 *             add, verify and remove custom domains, register, stream and
 *             remove proxy upstreams without a secret, set which sites may
 *             embed an app, release one's own write lease and delete an app
 *             (`set_frame_ancestors`, `release_lease`, `delete_app`), and
 *             change an app's stored data as its owner (`create_records`,
 *             `update_record`, `delete_record`, `delete_collection`,
 *             `purge_orphan_records`), delete a form submission or an
 *             upload, change an end user's role, block them or sign every
 *             end user out, and remove a module secret (never set one),
 *             create a team workspace and invite a member by e-mail
 *             (`create_workspace`, `invite_member`), change a member's role,
 *             remove a member or leave a workspace, delete a team workspace;
 *             a super-admin also switches a workspace's opt-in modules
 *             (`set_workspace_module`).
 *   publish — make a version live at its public URL (the `publish` tool),
 *             take it offline again (`unpublish`), choose who can open it
 *             (`set_visibility`), list it in the public gallery
 *             (`set_gallery_listing`) and choose the primary domain the
 *             production address redirects to (`set_primary_domain`);
 *             a super-admin also allows or blocks a workspace's publishing
 *             (`set_workspace_publishing`), takes an app down or restores it
 *             (`takedown_app`, `restore_app`) and hides a gallery entry
 *             (`set_gallery_hidden`) — all registered for super-admins only.
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
  get_analytics: 'read',
  list_assets: 'read',
  list_domains: 'read',
  list_upstreams: 'read',
  create_app: 'write',
  // A copy of a gallery app in the caller's workspace, like create_app.
  duplicate_app: 'write',
  write_files: 'write',
  restore_version: 'write',
  // The version history: paging it is a read, keeping a version or cleaning old ones up an app change.
  list_versions: 'read',
  keep_version: 'write',
  delete_versions: 'write',
  configure_module: 'write',
  // A run writes the fetched records into the app's data, like the scheduled run.
  sync_now: 'write',
  create_asset_upload: 'write',
  delete_asset: 'write',
  add_domain: 'write',
  verify_domain: 'write',
  remove_domain: 'write',
  register_upstream: 'write',
  set_upstream_streaming: 'write',
  remove_upstream: 'write',
  // Workspace members: reading them is read, changing a role or removing someone is write.
  list_members: 'read',
  set_member_role: 'write',
  remove_member: 'write',
  // Deleting a team workspace changes what exists, like the other workspace-admin tools.
  delete_workspace: 'write',
  // App lifecycle: embedding, the caller's own lease and deletion (with the user's yes) are app changes.
  set_frame_ancestors: 'write',
  release_lease: 'write',
  delete_app: 'write',
  // The owner's edits of an app's stored data, like the dashboard's Data tab (editor+).
  create_records: 'write',
  update_record: 'write',
  delete_record: 'write',
  delete_collection: 'write',
  purge_orphan_records: 'write',
  // The owner's module tabs (Forms, Users, Uploads, a module's secrets) and the workspace Activity page.
  list_form_submissions: 'read',
  delete_form_submission: 'write',
  list_end_users: 'read',
  set_end_user_role: 'write',
  set_end_user_blocked: 'write',
  sign_out_end_users: 'write',
  list_uploads: 'read',
  delete_upload: 'write',
  remove_module_secret: 'write',
  list_activity: 'read',
  // Taking the production address offline and opening an app to everyone are public exposure, like publishing.
  unpublish: 'publish',
  set_visibility: 'publish',
  publish: 'publish',
  // Listing in the public gallery is public exposure, like publishing.
  set_gallery_listing: 'publish',
  // The primary domain decides where the production address sends every visitor.
  set_primary_domain: 'publish',
  // Who may publish is decided under the publish scope; @drobek/mcp registers it for super-admins only.
  set_workspace_publishing: 'publish',
  // A new team workspace and an e-mailed invite to one change the user's workspaces, like the dashboard's /workspaces.
  create_workspace: 'write',
  invite_member: 'write',
  // Super-admins only (@drobek/mcp): a workspace's opt-in module switch is configuration;
  // a takedown, its restore and hiding a gallery entry decide what the public sees.
  set_workspace_module: 'write',
  takedown_app: 'publish',
  restore_app: 'publish',
  set_gallery_hidden: 'publish',
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
