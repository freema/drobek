/**
 * The ONE error shape every module route answers with:
 *   `{ error, message, details?, hint }` + an HTTP status.
 * `hint` links the agent to the documentation — by default the module's own
 * skill, `skill_info('<module>')`. Handlers throw ModuleError; anything else
 * becomes a 500 `internal_error` without internals.
 */
export type ModuleErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'module_not_enabled'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'limit_exceeded'
  | 'quota_exceeded'
  | 'conflict'
  | 'csrf_rejected'
  | 'password_required'
  | 'unavailable'
  | 'internal_error'
  | (string & {});

const STATUS: Record<string, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  csrf_rejected: 403,
  not_found: 404,
  module_not_enabled: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  limit_exceeded: 429,
  quota_exceeded: 409,
  password_required: 401,
  unavailable: 503,
  internal_error: 500,
};

/** Every code the platform answers module routes with (each has an agent-dx catalogue entry). */
export const MODULE_ERROR_CODES: readonly string[] = Object.keys(STATUS);

/**
 * Every code of the CORE error catalogue (`@drobek/agent-dx`
 * `ERROR_CATALOGUE`, code-shaped entries): the module-route codes above plus
 * the MCP tool, compile and OAuth codes. A module may not declare one of
 * these in `errors`, and a module route may answer any of them. A unit test
 * in @drobek/mcp keeps this list equal to the catalogue.
 */
export const CORE_ERROR_CODES: readonly string[] = [
  ...MODULE_ERROR_CODES,
  // MCP tools
  'invalid_params',
  'invalid_path',
  'edit_mismatch',
  'secret_in_source',
  'app_locked',
  'app_locked_by_admin',
  'busy',
  'slug_taken',
  'not_publishable',
  'compile_error',
  'not_published',
  'user_confirmation_required',
  'gallery_hidden',
  'gallery_disabled',
  'not_duplicable',
  'publish_not_approved',
  'publish_blocked',
  // app assets (MCP asset tools, the upload URL)
  'asset_too_large',
  'asset_type_not_allowed',
  'asset_quota_exceeded',
  'asset_path_taken',
  'asset_size_mismatch',
  'asset_not_found',
  'upload_token_invalid',
  // custom domains (MCP domain tools, the dashboard)
  'invalid_hostname',
  'hostname_not_allowed',
  'domain_already_added',
  'domain_taken',
  'domain_not_verified',
  'dns_unavailable',
  // proxy upstreams (MCP upstream tools)
  'upstream_already_registered',
  // the workspace Modules switch (dashboard)
  'module_requires_not_enabled',
  // compile.errors[]
  'build_error',
  'unresolved_import',
  'invalid_config',
  'timeout',
  // compile.warnings[]
  'missing_reference',
  'blocked_by_csp',
  // readiness.warnings[]
  'missing_title',
  'data_public_write_no_schema', 'data_public_write_unbounded', 'data_public_read_personal', 'rule_needs_auth_module', 'proxy_public_upstream', 'module_change_pending',
  'xss_html_sink', 'xss_eval', 'xss_url_sink',
  'type_error',
  // OAuth
  'invalid_grant',
  'invalid_client',
  'invalid_target',
];

export interface ModuleErrorBody {
  error: string;
  message: string;
  details?: unknown;
  hint?: string;
}

/**
 * Cross-instance brand: the dashboard's Vite SSR runner and the module
 * processes can each hold their own copy of this class, and subclasses
 * (`DataError`, …) rename `name`, so neither `instanceof` nor the name
 * identifies a module error reliably. `Symbol.for` is shared per realm.
 */
const MODULE_ERROR_BRAND: unique symbol = Symbol.for('drobek.module-error') as never;

export class ModuleError extends Error {
  readonly [MODULE_ERROR_BRAND] = true as const;
  readonly code: ModuleErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly hint?: string;
  readonly headers: Record<string, string>;

  constructor(
    code: ModuleErrorCode,
    message: string,
    opts: { status?: number; details?: unknown; hint?: string; headers?: Record<string, string> } = {}
  ) {
    super(message);
    this.name = 'ModuleError';
    this.code = code;
    this.status = opts.status ?? STATUS[code] ?? 400;
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.hint !== undefined) this.hint = opts.hint;
    this.headers = opts.headers ?? {};
  }

  body(defaultHint?: string): ModuleErrorBody {
    const out: ModuleErrorBody = { error: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    const hint = this.hint ?? defaultHint;
    if (hint) out.hint = hint;
    return out;
  }
}

/**
 * ModuleError by shape, not by class identity: a third-party module may bundle
 * its own copy of this package, so `instanceof` is not enough.
 */
export function isModuleError(err: unknown): err is ModuleError {
  if (err instanceof ModuleError) return true;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Partial<ModuleError> & { [MODULE_ERROR_BRAND]?: unknown };
  if (typeof e.status !== 'number' || typeof e.body !== 'function') return false;
  return e[MODULE_ERROR_BRAND] === true || e.name === 'ModuleError';
}

/**
 * An opt-in module (`availability: 'opt-in'`) that is not enabled
 * for the app's workspace — the module route (404), configure_module and the
 * owner's confirm answer this.
 */
export function moduleNotEnabled(name: string): ModuleError {
  return new ModuleError(
    'module_not_enabled',
    `The platform module "${name}" is not enabled for this app's workspace. Only the server operator can enable it.`,
    { details: { module: name }, hint: skillHint(name) }
  );
}

/**
 * A super-admin tried to enable an opt-in module for a workspace while a
 * module it requires (directly or through another one) is off there.
 * `missing` lists those modules in the order to enable them.
 */
export function moduleRequiresNotEnabled(name: string, missing: string[]): ModuleError {
  const list = missing.map((x) => `"${x}"`);
  return new ModuleError(
    'module_requires_not_enabled',
    `The module "${name}" depends on ${list.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not enabled for this workspace.`,
    { status: 409, details: { module: name, missing }, hint: `Enable ${list.join(', then ')} for this workspace first, then enable "${name}".` }
  );
}

/** `skill_info('<name>')` — the hint every module error carries by default. */
export function skillHint(name?: string): string {
  return name ? `skill_info('${name}')` : 'skill_info()';
}

/** zod issues → `[{ path: 'a.b[0]', message }]` (the agent-facing field paths). */
export function issuePaths(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): { path: string; message: string }[] {
  return issues.map((i) => ({ path: formatPath(i.path), message: i.message }));
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out || '(root)';
}

/** A module set the server refuses to start with (the message names the reason and the fix). */
export class ModuleLoadError extends Error {
  constructor(message: string) {
    super(`drobek refuses to start: ${message}`);
    this.name = 'ModuleLoadError';
  }
}
