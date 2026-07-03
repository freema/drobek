/**
 * ERROR_CATALOGUE — the agent-facing map of every stable error `code` the MCP
 * tools / REST Data API / OAuth flow can surface, what it means, and the fix
 * (M1b Agent DX, PHY-124).
 *
 * The codes mirror the typed error unions in @drobek/data (DataErrorCode) and
 * @drobek/deploy (DeployErrorCode) plus the OAuth error responses. They are
 * kept as plain data here (agent-dx is a zero-dependency leaf) — the numbers +
 * fix guidance are human documentation. The enforced parity contract is the
 * TOOL-NAME drift guard (see tools.ts); error codes are documentation.
 */

export interface ErrorDoc {
  code: string;
  /** Where it shows up: MCP tool result, REST HTTP status, or OAuth response. */
  surface: string;
  meaning: string;
  fix: string;
}

export const ERROR_CATALOGUE: ErrorDoc[] = [
  // ── Data API (MCP data tools + REST) ──────────────────────────────────────
  {
    code: 'validation_failed',
    surface: 'data tool isError / REST 422',
    meaning: 'The document did not match the collection JSON Schema.',
    fix: 'Read the `details` field (ajv errors) and fix the offending property; make sure required fields are present and additionalProperties are allowed.',
  },
  {
    code: 'invalid_schema',
    surface: 'data tool isError / REST 400',
    meaning: 'The JSON Schema passed to collection_define is malformed.',
    fix: 'Pass a valid JSON Schema object (type:"object" with a properties map is the common shape).',
  },
  {
    code: 'invalid_request',
    surface: 'data tool isError / REST 400',
    meaning: 'The request body was not valid JSON or a required argument was missing.',
    fix: 'Send a well-formed JSON body and include every required argument.',
  },
  {
    code: 'too_many_docs',
    surface: 'data tool isError / REST 409',
    meaning: 'The app already holds the maximum number of live documents (DATA_MAX_DOCS_PER_APP).',
    fix: 'Delete stale documents or raise DATA_MAX_DOCS_PER_APP on the server. NOTE: local compose sets this LOW (5) on purpose.',
  },
  {
    code: 'doc_too_large',
    surface: 'data tool isError / REST 413 (entity too large)',
    meaning: 'A single document exceeds DATA_MAX_DOC_BYTES (default 100 KiB).',
    fix: 'Shrink the document or store large blobs as a deployed asset instead of a data record.',
  },
  {
    code: 'app_too_large',
    surface: 'data/deploy tool isError / REST 413',
    meaning: 'The write would exceed the per-app storage cap (DATA_MAX_BYTES_PER_APP) — or, in deploy, the deploy exceeds DEPLOY_MAX_APP_BYTES.',
    fix: 'Reduce total stored data / deploy size, or raise the corresponding cap.',
  },
  {
    code: 'rate_limited',
    surface: 'data tool isError / REST 429',
    meaning: 'Too many writes for this app in the window (DATA_WRITE_RATE_LIMIT per DATA_WRITE_RATE_WINDOW_MS).',
    fix: 'Back off and retry; batch writes; or raise the write rate limit on the server.',
  },
  {
    code: 'unauthorized',
    surface: 'data tool isError / REST 401',
    meaning: 'The collection access mode requires authentication and the caller is anonymous.',
    fix: 'Authenticate (workspace session for REST, or an MCP token with the right scope) — or set the collection to public-read/public-write.',
  },
  {
    code: 'forbidden',
    surface: 'data/deploy tool isError / REST 403',
    meaning: 'The caller is authenticated but lacks the role (editor+ for writes) or the token scope.',
    fix: 'Use a token/role with the required scope: data:write / deploy:write need an editor+ membership.',
  },
  {
    code: 'not_found',
    surface: 'data/deploy tool isError / REST 404',
    meaning: 'The workspace, app, collection, document, or deploy does not exist (or is not yours).',
    fix: 'Check the workspace slug (from whoami), app slug, collection name, and id.',
  },
  {
    code: 'not_implemented',
    surface: 'data tool isError / REST 501',
    meaning: 'The operation is reserved for a later unit — e.g. owner-only collections (per-end-user auth is U11).',
    fix: 'Use public-read / public-write / locked for now.',
  },
  // ── Deploy pipeline ───────────────────────────────────────────────────────
  {
    code: 'invalid_manifest',
    surface: 'deploy_init isError',
    meaning: 'The manifest is empty, has duplicate paths, or malformed { path, sha256, bytes } entries.',
    fix: 'Send one entry per file with a lowercase-hex sha256 and the exact byte length.',
  },
  {
    code: 'index_html_required',
    surface: 'deploy_init isError',
    meaning: 'No index.html at the deploy root.',
    fix: 'Put an index.html at the ROOT of the manifest (not in a subfolder).',
  },
  {
    code: 'file_too_large',
    surface: 'deploy_init isError',
    meaning: 'A single file exceeds DEPLOY_MAX_FILE_BYTES (default 10 MiB).',
    fix: 'Split or compress the asset, or raise DEPLOY_MAX_FILE_BYTES.',
  },
  {
    code: 'missing_blobs',
    surface: 'deploy_commit isError',
    meaning: 'deploy_commit ran before every file in the manifest was uploaded.',
    fix: 'PUT every presigned upload URL returned by deploy_init, then commit.',
  },
  {
    code: 'invalid_state',
    surface: 'deploy_commit / deploy_status isError',
    meaning: 'The deploy is not in a state that allows the requested transition (e.g. committing an already-committed deploy).',
    fix: 'Start a fresh deploy_init, or just poll deploy_status.',
  },
  {
    code: 'no_rollback_target',
    surface: 'rollback isError',
    meaning: 'There is no prior ready deploy to roll back to.',
    fix: 'Nothing to do — the current version is the only ready one.',
  },
  {
    code: 'lint blocked (state=failed)',
    surface: 'deploy_status',
    meaning: 'Strict lint rejected the bundle — e.g. it references chromium/puppeteer or other disallowed runtime. The deploy state becomes "failed" and never activates.',
    fix: 'Remove the flagged code (read the lint report in deploy_status), then redeploy. drobek hosts STATIC apps only.',
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
    code: 'invalid_token (401 on /mcp)',
    surface: 'MCP endpoint 401 + WWW-Authenticate',
    meaning: 'The Bearer token is missing, expired, revoked, or minted for a DIFFERENT resource/audience (RFC 8707).',
    fix: 'Obtain a token whose `resource` is exactly the MCP endpoint from the protected-resource metadata, and send it as `Authorization: Bearer …`.',
  },
];
