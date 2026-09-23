/**
 * The ONE error shape every module route answers with (§3.5):
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
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'limit_exceeded'
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
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  limit_exceeded: 429,
  password_required: 401,
  unavailable: 503,
  internal_error: 500,
};

/** Every code the platform answers module routes with (each has an agent-dx catalogue entry). */
export const MODULE_ERROR_CODES: readonly string[] = Object.keys(STATUS);

export interface ModuleErrorBody {
  error: string;
  message: string;
  details?: unknown;
  hint?: string;
}

export class ModuleError extends Error {
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
  return (
    err instanceof ModuleError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as ModuleError).name === 'ModuleError' &&
      typeof (err as ModuleError).status === 'number' &&
      typeof (err as ModuleError).body === 'function')
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

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out || '(root)';
}
