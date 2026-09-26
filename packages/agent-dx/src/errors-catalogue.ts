/**
 * ERROR_CATALOGUE — the CORE error catalogue: every stable error `code` of
 * drobek itself an agent can meet: MCP tool failures (`isError: true` with
 * `{ code, message, hint }`), the per-error codes inside `compile.errors[]`,
 * the codes core answers on the platform module routes an app calls
 * (`/__drobek/v1/…`, M1-01) and the OAuth connect flow (M0-05, NSO-283).
 *
 * A module's OWN codes (e.g. auth's `invalid_code`, proxy's
 * `upstream_error`) are not here: each module declares them in its
 * `errors` (`defineModule`), `skill_info('<module>')` returns them and
 * /llms-full.txt renders them in one section per active module
 * (`renderLlmsFull(env, modules)`). @drobek/modules `CORE_ERROR_CODES` lists
 * the code-shaped entries of this catalogue (a module may not declare one);
 * a test in @drobek/mcp keeps the two equal.
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
      'The version would exceed a size limit (COMPILE_MAX_FILES files, COMPILE_MAX_FILE_BYTES per file, COMPILE_MAX_TOTAL_BYTES in total) or an import chain is deeper than COMPILE_MAX_IMPORT_DEPTH. From create_app: the workspace already holds APPS_MAX_PER_WORKSPACE apps (`limit`, `value`; deleted apps do not count). On a module route: a quota of the app or the user is used up for the period (`details.limit`, e.g. FORMS_PER_APP_PER_DAY, EMAIL_PER_APP_PER_DAY, EMAIL_NOTIFY_ADMINS_PER_DAY). In the dashboard: DOMAINS_MAX_PER_APP custom domains per app (0 = custom domains are off for the workspace).',
    fix: 'Split big files, delete unused ones, load large libraries from esm.sh through drobek.json instead of copying them into the app. From create_app (APPS_MAX_PER_WORKSPACE): do not retry — tell the user the workspace is full; they can delete an app they no longer need in the dashboard, work in another workspace, or ask the operator for a higher plan limit. On a module route: show the user a message and stop — the quota resets after Retry-After; the app owner can ask the operator for a higher plan limit.',
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
    code: 'app_locked_by_admin',
    surface: 'MCP tool isError (write_files, restore_version, publish, configure_module); dashboard API 423; app host 451 (module routes: JSON)',
    meaning:
      'The server operator took this app down for a violation of the terms (`reason` is the category: phishing, malware, spam, copyright, illegal or other). Every host of the app answers 451, it is unpublished, and nothing can be written, published or reconfigured. Not the same as `app_locked` (another agent holding the write lease) — waiting does not help.',
    fix: 'Stop changing the app and tell the user it was taken down by the operator (name the reason category). Only the operator can restore it; the user can contact them through the terms / report page linked from the app\'s address. Do not recreate the same content in another app.',
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
    code: 'not_published',
    surface: 'MCP tool isError (set_gallery_listing)',
    meaning: 'Only a published app can be listed in the public gallery, and this app has no version on its production URL.',
    fix: 'Publish the app first — but only when the user explicitly asks to publish — then ask again whether they want it in the gallery.',
  },
  {
    code: 'user_confirmation_required',
    surface: 'MCP tool isError (set_gallery_listing)',
    meaning:
      'Listing an app in the public gallery shows its name, a description and its production link to everyone, so the call needs `user_confirmed: true` — set only after the user explicitly said yes to exactly this listing. Nothing changed.',
    fix: 'Ask the user: "Do you want <app name> shown in the public gallery with the description \"<description>\"?" Call again with user_confirmed:true only if they clearly say yes; otherwise leave the app unlisted.',
  },
  {
    code: 'gallery_hidden',
    surface: 'MCP tool isError (set_gallery_listing); dashboard 400',
    meaning: 'The server operator hid this app from the public gallery; neither the owner nor an agent can list it until the operator shows it again. Nothing changed.',
    fix: 'Do not retry and do not work around it. Tell the user the operator hid the app from the gallery; they can contact the operator.',
  },
  {
    code: 'gallery_disabled',
    surface: 'MCP tool isError (set_gallery_listing)',
    meaning: 'This server runs no public gallery (its operator left GALLERY_ENABLED off). Nothing changed.',
    fix: 'Tell the user this server has no public gallery; do not retry.',
  },
  {
    code: 'asset_too_large',
    surface: 'MCP tool isError (create_asset_upload); upload URL 413',
    meaning:
      'The file is bigger than one asset may be (APP_ASSET_MAX_BYTES, default 100 MiB; `limit`, `value`). Nothing was stored.',
    fix: 'Compress or shorten the file (e.g. re-encode the video at a lower bitrate or resolution) and ask for a new upload URL with the new size. Transcoding is not done by drobek.',
  },
  {
    code: 'asset_type_not_allowed',
    surface: 'MCP tool isError (create_asset_upload); upload URL 415',
    meaning:
      'The declared content_type does not fit the path\'s extension, or the uploaded bytes are not an allowed asset type for it (`allowed`; `type` = what the bytes are). The type comes from the file\'s content, never its name: an HTML page named film.mp4 is refused. Allowed: PNG, JPEG, GIF, WebP, SVG, MP4 (H.264/AAC), WebM, M4A, MP3, Ogg, WAV, WOFF, WOFF2.',
    fix: 'Upload the real file with the matching extension (a .mov or .mkv must be converted to MP4 or WebM first). Text files (HTML, JS, CSS, JSON) go through write_files instead.',
  },
  {
    code: 'asset_quota_exceeded',
    surface: 'MCP tool isError (create_asset_upload); upload URL 413',
    meaning:
      'The app\'s assets would exceed APP_ASSETS_QUOTA (default 1 GiB; `limit`, `value`, `used_bytes`). A file uploaded to an existing path only counts its difference.',
    fix: 'list_assets shows what the app holds; delete_asset what is no longer used, then ask for a new upload URL.',
  },
  {
    code: 'asset_path_taken',
    surface: 'MCP tool isError (create_asset_upload); upload URL 409',
    meaning:
      'A file of the app (written with write_files, in its latest or published version) already sits at that path, and an app file always wins over an asset at the same path (`path`).',
    fix: 'Upload the asset under another path and point the page at it, or delete the text file with write_files first (e.g. a placeholder SVG).',
  },
  {
    code: 'asset_size_mismatch',
    surface: 'upload URL 400',
    meaning:
      'The uploaded body is not exactly the `size` the upload URL was created for (`declared`, `received`), or Content-Length disagrees with it. Nothing was stored; the URL is used up.',
    fix: 'Check the size (`stat -c %s <file>` / `stat -f %z <file>`), then call create_asset_upload again with the exact byte count.',
  },
  {
    code: 'asset_not_found',
    surface: 'MCP tool isError (delete_asset)',
    meaning: 'The app has no asset at that path (`path`).',
    fix: 'list_assets shows the app\'s asset paths.',
  },
  {
    code: 'upload_token_invalid',
    surface: 'upload URL 404',
    meaning:
      'The upload URL is unknown, already used (every URL takes exactly one upload, successful or not) or older than 30 minutes.',
    fix: 'Call create_asset_upload again for a fresh URL (or, in the dashboard, pick the file again on the Assets tab).',
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
    surface: 'module route 429 (DrobekError), Retry-After; MCP tool isError (create_asset_upload)',
    meaning: 'A module limit was hit (per visitor, per user or per app — `details.limit` per `details.window_seconds`). From create_asset_upload: the app has asked for APP_ASSET_UPLOADS_PER_HOUR upload URLs within the last hour.',
    fix: 'Show the user a message and retry after Retry-After seconds; never loop. For upload URLs: upload the files you already have URLs for, and ask for more after the hour.',
  },
  {
    code: 'payload_too_large',
    surface: 'module route 413 (DrobekError)',
    meaning: 'The request body is bigger than the route allows — for data, one record over the per-record size limit; for files, the file over the per-file cap (`details.limit` is `maxBytes` or `FILES_MAX_BYTES`, `details.value` the cap in bytes). Nothing was stored.',
    fix: 'Send less (the module skill states the size limits).',
  },
  {
    code: 'quota_exceeded',
    surface: 'module route 409 (DrobekError)',
    meaning:
      'The app reached a storage limit — for files, FILES_QUOTA_PER_APP (the total bytes of its stored files, `details.used`); for data, the number of records across all its collections, or their total size (`details.limit` names it, `details.value` is the limit; skill_info(\'data\') lists them). Nothing was stored.',
    fix: 'Delete records the app no longer needs (query_data finds them), or tell the user the app is full; the server operator sets the limits.',
  },
  {
    code: 'unsupported_media_type',
    surface: 'module route 415 (DrobekError)',
    meaning:
      'A body was sent that is not JSON (routes that also take multipart/form-data, like forms, accept text fields only — a file part is refused).',
    fix: 'Use the SDK, which sends JSON; with fetch set Content-Type: application/json. Forms take no files; a files upload must be multipart/form-data with one file (drobek.files.upload does that).',
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
      'A service the module depends on is down or not configured on this server — e.g. module e-mail is paused because the server-wide hourly budget of its class (notifications or sign-in codes, `details.class`) or the per-app hourly share of notifications (`details.limit: EMAIL_APP_HOURLY_SHARE`) or the per-workspace share (`EMAIL_WORKSPACE_HOURLY_SHARE`) was used up (`details.reason: email_paused`, Retry-After), the server runs no `email` module, or it has no DROBEK_MASTER_KEY (forms).',
    fix: 'Show the user a message and retry later; tell the app owner if it persists.',
  },
  {
    code: 'method_not_allowed',
    surface: 'module route 405 (DrobekError), Allow',
    meaning: 'The route exists but not for this HTTP method.',
    fix: 'Use the SDK call from the module skill.',
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
