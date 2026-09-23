/**
 * ERROR_CATALOGUE — every stable error `code` an agent can meet: MCP tool
 * failures (`isError: true` with `{ code, message, hint }`), the per-error
 * codes inside `compile.errors[]`, and the OAuth connect flow (M0-05, NSO-283).
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
    surface: 'MCP tool isError',
    meaning:
      'The app, workspace, version or file does not exist — or you are not a member of its workspace (both answer the same, so ids cannot be probed).',
    fix: 'Call list_apps for the app ids and workspaces you can reach; get_app lists the files and versions of an app.',
  },
  {
    code: 'forbidden',
    surface: 'MCP tool isError',
    meaning: 'You are a member of the workspace, but your role is viewer — changing apps needs editor or workspace-admin.',
    fix: 'Ask a workspace admin for the editor role (the write scope alone does not raise your role), or work in a workspace where you are an editor.',
  },
  {
    code: 'invalid_params',
    surface: 'MCP tool isError',
    meaning:
      'An argument breaks the tool contract: more than 20 files in one write_files, the same path twice, deleting a file that does not exist, reasoning over 300 characters, an empty name, a non-positive version number.',
    fix: 'Read `message`, fix the arguments and call again. Split large changes into several write_files calls of at most 20 files.',
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
    surface: 'MCP tool isError; compile.errors[]',
    meaning:
      'The version would exceed a size limit (COMPILE_MAX_FILES files, COMPILE_MAX_FILE_BYTES per file, COMPILE_MAX_TOTAL_BYTES in total) or an import chain is deeper than COMPILE_MAX_IMPORT_DEPTH.',
    fix: 'Split big files, delete unused ones, load large libraries from esm.sh through drobek.json instead of copying them into the app.',
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
      'An import is neither an app file nor in drobek.json `imports` (bare packages are never installed — the browser loads them from their URL).',
    fix: 'Fix the relative path, or add the package to drobek.json `imports` with a pinned https URL (e.g. "date-fns": "https://esm.sh/date-fns@4.1.0").',
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
