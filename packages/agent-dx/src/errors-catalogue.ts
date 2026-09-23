/**
 * ERROR_CATALOGUE — every stable error `code` an agent can meet: MCP tool
 * failures (`isError: true` with `{ code, message, hint }`), the per-error
 * codes inside `compile.errors[]`, the platform module routes an app calls
 * (`/__drobek/v1/…`, M1-01) and the OAuth connect flow (M0-05, NSO-283).
 *
 * The MCP tools take their `hint` from HERE (`errorHint`), and a unit test in
 * @drobek/mcp asserts that every code the tools can emit — and every
 * @drobek/compile error code — has an entry, so the catalogue cannot fall
 * behind the code.
 *
 * Anti-enumeration: the plan's `not_member` does not exist on purpose — a
 * workspace or app you cannot reach answers exactly like one that does not
 * exist (`not_found`).
 */

export interface ErrorDoc {
  code: string;
  /** Where it shows up: MCP tool isError, compile.errors[], or OAuth response. */
  surface: string;
  meaning: string;
  /** What to do — returned verbatim as `hint` by the MCP tools. */
  fix: string;
}

export const ERROR_CATALOGUE: ErrorDoc[] = [
  // ── MCP tools (isError: true, body { code, message, hint }) ───────────────
  {
    code: 'not_found',
    surface: 'MCP tool isError; module route 404 (DrobekError)',
    meaning:
      'The app, workspace, version or file does not exist — or you are not a member of its workspace (both answer the same, so ids cannot be probed). From skill_info / configure_module: no such skill or module on this server (`available` lists the ones that exist). From query_data or a data route: the app declares no such collection (`available` lists its collections), or no such record.',
    fix: 'Call list_apps for the app ids and workspaces you can reach; get_app lists the files and versions of an app; skill_info() lists the skills and modules. For data: declare the collection with configure_module(\'data\') first.',
  },
  {
    code: 'forbidden',
    surface: 'MCP tool isError; module route 403 (DrobekError)',
    meaning:
      'You are a member of the workspace, but your role is viewer — changing apps needs editor or workspace-admin. From a module route: the signed-in end user may not do this (the module\'s rule, e.g. owner or admin only).',
    fix: 'Ask a workspace admin for the editor role (the write scope alone does not raise your role), or work in a workspace where you are an editor. In an app: show the end user a friendly message.',
  },
  {
    code: 'invalid_params',
    surface: 'MCP tool isError',
    meaning:
      'An argument breaks the tool contract: more than 20 files in one write_files, the same path twice, deleting a file that does not exist, reasoning over 300 characters, an empty name, a non-positive version number — or a configure_module config that fails the module\'s schema (`issues[]` carries each field path) or contains a credential — or a query_data filter/sort/cursor the collection does not allow, or a limit outside 1–100.',
    fix: 'Read `message` (and `issues[].path`), fix the arguments and call again. Split large changes into several write_files calls of at most 20 files. For a module config, skill_info(module) shows the schema.',
  },
  {
    code: 'invalid_path',
    surface: 'MCP tool isError; compile.errors[]',
    meaning:
      'A file path is unsafe (absolute, `..`, empty segment, control characters) or has an extension apps may not contain / that write_files cannot write as text.',
    fix: 'Use app-relative paths like `src/App.tsx` with a text extension (.tsx .ts .jsx .js .mjs .css .json .html .txt .md .svg .webmanifest).',
  },
  {
    code: 'limit_exceeded',
    surface: 'MCP tool isError; compile.errors[]; module route 429 (DrobekError), Retry-After',
    meaning:
      'The version would exceed a size limit (COMPILE_MAX_FILES files, COMPILE_MAX_FILE_BYTES per file, COMPILE_MAX_TOTAL_BYTES in total) or an import chain is deeper than COMPILE_MAX_IMPORT_DEPTH. On a module route: a quota of the app or the user is used up for the period (`details.limit`, e.g. FORMS_PER_APP_PER_DAY, EMAIL_PER_APP_PER_DAY, EMAIL_NOTIFY_ADMINS_PER_DAY).',
    fix: 'Split big files, delete unused ones, load large libraries from esm.sh through drobek.json instead of copying them into the app. On a module route: show the user a message and stop — the quota resets after Retry-After; the app owner can ask the operator for a higher plan limit.',
  },
  {
    code: 'secret_in_source',
    surface: 'MCP tool isError (nothing is stored); compile.errors[]',
    meaning:
      'A file contains something that looks like a credential (sk-… key, AWS key, GitHub token, private key, `apiKey = "…"`). App files are public — the write is refused and no version is stored.',
    fix: 'Remove the value from the file. Secrets are entered by the app owner in the drobek dashboard and used server-side, never shipped in app files.',
  },
  {
    code: 'app_locked',
    surface: 'MCP tool isError',
    meaning:
      'Another user\'s agent is writing this app right now (single-writer lease, 3 minutes, renewed by each of their writes). The body carries the masked `holder` and `expires_at`.',
    fix: 'Tell the user who holds the app and wait until `expires_at`, then retry. Your own other sessions never block you — they hand the lease over.',
  },
  {
    code: 'busy',
    surface: 'MCP tool isError; compile.errors[]',
    meaning: 'The compiler is saturated (COMPILE_CONCURRENCY builds running, the queue wait exceeded COMPILE_QUEUE_TIMEOUT_MS). Nothing was stored.',
    fix: 'Retry the same write_files call in a few seconds.',
  },
  {
    code: 'slug_taken',
    surface: 'MCP tool isError',
    meaning: 'Every slug tried for the new app is taken (create_app already retries with a free `-xxxx` suffix).',
    fix: 'Call create_app again, or with a more specific name.',
  },
  {
    code: 'not_publishable',
    surface: 'MCP tool isError (publish)',
    meaning:
      'The version you asked publish to put live did not compile (only versions with compile_status ok can be published), or the app has no version that compiled yet. Nothing changed on the production URL.',
    fix: 'Publish a version that compiled: omit `version` to publish the newest one that did, or fix compile.errors with write_files first.',
  },
  {
    code: 'internal_error',
    surface: 'MCP tool isError',
    meaning: 'drobek failed unexpectedly while handling the call (the details are in the server log, never in the response).',
    fix: 'Retry once; if it fails again, tell the user — it is a drobek bug, not something to work around.',
  },
  {
    code: 'compile_error',
    surface: 'write_files / restore_version result (compile.ok: false — not a tool failure)',
    meaning:
      'The new version did not compile. It IS stored (no work is lost); the preview keeps serving the last version that compiled.',
    fix: 'Fix each entry of compile.errors (file, 1-based line, 0-based column, text) and call write_files again.',
  },
  // ── compile.errors[].code (inside a compile result) ───────────────────────
  {
    code: 'build_error',
    surface: 'compile.errors[]',
    meaning: 'esbuild could not parse/transform a file (syntax error, invalid CSS/JSON, …).',
    fix: 'Fix the file at the reported line/column. TypeScript types are stripped, not checked.',
  },
  {
    code: 'unresolved_import',
    surface: 'compile.errors[]',
    meaning:
      'An import is neither an app file nor in drobek.json `imports` (bare packages are never installed — the browser loads them from their URL). When the entry carries a `hint` like skill_info(\'data\'), the package is a backend SDK (Firebase, Supabase, …) the platform replaces.',
    fix: 'Follow the entry\'s `hint` when it has one (call that skill_info and use the drobek SDK instead). Otherwise fix the relative path, or add the package to drobek.json `imports` with a pinned https URL (e.g. "date-fns": "https://esm.sh/date-fns@4.1.0").',
  },
  {
    code: 'invalid_config',
    surface: 'compile.errors[]',
    meaning: 'drobek.json is not valid JSON or has a wrong shape (`imports` must map names to https URLs, `entries` must list existing source files).',
    fix: 'Rewrite drobek.json as { "imports": { "<pkg>": "https://…" }, "entries": ["src/other.tsx"] }.',
  },
  {
    code: 'timeout',
    surface: 'compile.errors[]',
    meaning: 'The build ran longer than COMPILE_TIMEOUT_MS and was stopped (the version is stored with compile_status error).',
    fix: 'Look for an import cycle or a very large generated file.',
  },
  // ── platform module routes (/__drobek/v1/<module>/…, the drobek SDK) ──────
  // Body { error, message, details?, hint } — `error` is the code below; the
  // SDK throws it as DrobekError { status, code, message, details, hint }.
  {
    code: 'invalid_request',
    surface: 'module route 400 (DrobekError)',
    meaning: 'The request body or query failed the route\'s schema; `details[]` lists each `{ path, message }`, or the body is not valid JSON.',
    fix: 'Send what the module\'s skill documents (skill_info(module)); fix the fields named in details[].path.',
  },
  {
    code: 'unauthorized',
    surface: 'module route 401 (DrobekError)',
    meaning: 'The route needs a signed-in end user of this app and the visitor is not signed in.',
    fix: 'Sign the visitor in first (see skill_info(\'auth\') when the server has it), then retry.',
  },
  {
    code: 'csrf_rejected',
    surface: 'module route 403 (DrobekError)',
    meaning: 'A mutating call came from another origin, a sandboxed/opaque origin, or without the `X-Drobek-SDK: 1` header.',
    fix: "Call module routes through the SDK (`import { drobek } from 'drobek'`) from the app's own pages.",
  },
  {
    code: 'password_required',
    surface: 'module route 401',
    meaning: 'The app is password-protected and this browser has not unlocked it yet.',
    fix: 'Open the app URL and enter the password first; module calls then work.',
  },
  {
    code: 'rate_limited',
    surface: 'module route 429 (DrobekError), Retry-After',
    meaning: 'A module limit was hit (per visitor, per user or per app — `details.limit` per `details.window_seconds`).',
    fix: 'Show the user a message and retry after Retry-After seconds; never loop.',
  },
  {
    code: 'payload_too_large',
    surface: 'module route 413 (DrobekError)',
    meaning: 'The request body is bigger than the route allows — for data, one record over the per-record size limit (`details.limit`).',
    fix: 'Send less (the module skill states the size limits).',
  },
  {
    code: 'validation_failed',
    surface: 'module route (data) 422 (DrobekError)',
    meaning: 'The record does not match the collection\'s JSON Schema; `details[]` lists each `{ path, message }`. Nothing was stored.',
    fix: 'Send the fields the schema requires with the right types (get_app shows the data config), or change the schema with configure_module(\'data\').',
  },
  {
    code: 'quota_exceeded',
    surface: 'module route (data) 409 (DrobekError)',
    meaning:
      'The app reached a storage limit — the number of records across all its collections, or their total size (`details.limit` names it, `details.value` is the limit; skill_info(\'data\') lists them). Nothing was stored.',
    fix: 'Delete records the app no longer needs (query_data finds them), or tell the user the app is full; the server operator sets the limits.',
  },
  {
    code: 'unsupported_media_type',
    surface: 'module route 415 (DrobekError)',
    meaning:
      'A body was sent that is not JSON (routes that also take multipart/form-data, like forms, accept text fields only — a file part is refused).',
    fix: 'Use the SDK, which sends JSON; with fetch set Content-Type: application/json. Forms take no files.',
  },
  {
    code: 'conflict',
    surface: 'module route 409 (DrobekError)',
    meaning: 'The request conflicts with the current state (e.g. a record that already exists or changed meanwhile).',
    fix: 'Reload the state and retry; the module skill names its conflict cases.',
  },
  {
    code: 'unavailable',
    surface: 'module route 503 (DrobekError)',
    meaning:
      'A service the module depends on is down or not configured on this server — e.g. module e-mail is paused because the server-wide hourly cap was reached (`details.reason: email_paused`, Retry-After), the server runs no `email` module, or it has no DROBEK_MASTER_KEY (forms).',
    fix: 'Show the user a message and retry later; tell the app owner if it persists.',
  },
  {
    code: 'method_not_allowed',
    surface: 'module route 405 (DrobekError), Allow',
    meaning: 'The route exists but not for this HTTP method.',
    fix: 'Use the SDK call from the module skill.',
  },
  {
    code: 'email_not_allowed',
    surface: 'module route (auth) 403 (DrobekError)',
    meaning: 'The address may not sign in to this app: it is not in `allow` / `adminEmails` of the auth config, or the user is disabled. No code was sent.',
    fix: "Add the address or its domain with configure_module('auth'), or tell the user who may sign in.",
  },
  {
    code: 'invalid_code',
    surface: 'module route (auth) 400 (DrobekError)',
    meaning: 'The sign-in code is wrong, expired (10 minutes) or already used.',
    fix: 'Re-enter the code from the e-mail, or request a new one with drobek.auth.sendCode.',
  },
  {
    code: 'submitted_too_fast',
    surface: 'module route (forms) 429 (DrobekError), Retry-After',
    meaning: 'The form was sent less than 2 s after its token was issued (`details.min_wait_ms`) — the bot check. Nothing was stored.',
    fix: 'Use <Form> or drobek.forms.submit (they fetch the token early and wait); with your own fetch, call GET /__drobek/v1/forms/<form>/token when the form is shown, not on submit.',
  },
  {
    code: 'invalid_form_token',
    surface: 'module route (forms) 400 (DrobekError)',
    meaning: 'The `_t` field is missing, forged, for another form/app, or older than 2 hours (`details.reason`: invalid | expired). Nothing was stored.',
    fix: 'Use <Form> or drobek.forms.submit — they fetch a fresh token and retry once by themselves.',
  },
  {
    code: 'too_many_attempts',
    surface: 'module route (auth) 429 (DrobekError)',
    meaning: 'Five wrong codes were entered for this address; the code is dead.',
    fix: 'Request a new code (drobek.auth.sendCode); <LoginGate> goes back to the e-mail step by itself.',
  },
  // ── OAuth 2.1 connect flow ────────────────────────────────────────────────
  {
    code: 'invalid redirect_uri (redirect_uri mismatch)',
    surface: 'OAuth /authorize or /token 400',
    meaning: 'The redirect_uri does not exactly match one registered for the client (exact-match, RFC 8252).',
    fix: 'Register the exact redirect_uri via DCR (/oauth/register) and pass the identical string on /authorize and /token.',
  },
  {
    code: 'invalid_grant',
    surface: 'OAuth /token 400',
    meaning: 'The authorization code or refresh token is expired, already used (single-use), or its lineage was burned by reuse detection.',
    fix: 'Restart the flow: new /authorize → new code → exchange once; rotate refresh tokens and never reuse an old one.',
  },
  {
    code: 'invalid_client',
    surface: 'OAuth /authorize 400 (shown, not redirected)',
    meaning:
      'Unknown DCR client_id, or the Client ID Metadata Document could not be used: not a canonical https URL with a path, unreachable, private/reserved address, over 64 KiB, slower than 5 s, a redirect, not JSON, its client_id differs from its URL, or a redirect_uri breaks the policy.',
    fix: 'Serve the metadata JSON at the exact https client_id URL (client_id inside = that URL, redirect_uris https or loopback), or register via /oauth/register.',
  },
  {
    code: 'invalid_target',
    surface: 'OAuth /authorize redirect',
    meaning: 'The `resource` parameter is not this drobek MCP endpoint (RFC 8707).',
    fix: 'Send `resource` = the `resource` value from /.well-known/oauth-protected-resource.',
  },
  {
    code: 'rate_limited (429 on /oauth/register)',
    surface: 'OAuth /oauth/register 429',
    meaning:
      'Too many client registrations from one address in the last hour (10), or (503 temporarily_unavailable) too many registered clients that never completed consent.',
    fix: 'Reuse your registered client_id, or identify the client with a Client ID Metadata Document URL instead.',
  },
  {
    code: 'invalid_token (401 on /mcp)',
    surface: 'MCP endpoint 401 + WWW-Authenticate',
    meaning:
      'The Bearer token or API key is missing, expired, revoked, or the token was minted for a DIFFERENT resource/audience (RFC 8707).',
    fix: 'Obtain a token whose `resource` is exactly the MCP endpoint from the protected-resource metadata (or use a live drk_ API key), and send it as `Authorization: Bearer …`.',
  },
];

const BY_CODE = new Map(ERROR_CATALOGUE.map((e) => [e.code, e]));

/** The catalogue entry for `code`, or undefined. */
export function errorDoc(code: string): ErrorDoc | undefined {
  return BY_CODE.get(code);
}

/** The `hint` an MCP tool returns with `code` (the catalogue's fix). */
export function errorHint(code: string): string {
  return BY_CODE.get(code)?.fix ?? 'See the error catalogue in llms-full.txt.';
}
