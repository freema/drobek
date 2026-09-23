/**
 * ERROR_CATALOGUE — the agent-facing map of every stable error `code` the MCP
 * tools / OAuth flow can surface, what it means, and the fix
 * (M1b Agent DX, PHY-124).
 *
 * The codes mirror the typed error union in @drobek/data (DataErrorCode) plus
 * the OAuth error responses. They are
 * kept as plain data here (agent-dx is a zero-dependency leaf) — the numbers +
 * fix guidance are human documentation. The enforced parity contract is the
 * TOOL-NAME drift guard (see tools.ts); error codes are documentation.
 */

export interface ErrorDoc {
  code: string;
  /** Where it shows up: MCP tool result or OAuth response. */
  surface: string;
  meaning: string;
  fix: string;
}

export const ERROR_CATALOGUE: ErrorDoc[] = [
  // ── Data API (MCP data tools) ─────────────────────────────────────────────
  {
    code: 'validation_failed',
    surface: 'data tool isError',
    meaning: 'The document did not match the collection JSON Schema.',
    fix: 'Read the `details` field (ajv errors) and fix the offending property; make sure required fields are present and additionalProperties are allowed.',
  },
  {
    code: 'invalid_schema',
    surface: 'data tool isError',
    meaning: 'The JSON Schema passed to collection_define is malformed.',
    fix: 'Pass a valid JSON Schema object (type:"object" with a properties map is the common shape).',
  },
  {
    code: 'invalid_request',
    surface: 'data tool isError',
    meaning: 'The request body was not valid JSON or a required argument was missing.',
    fix: 'Send a well-formed JSON body and include every required argument.',
  },
  {
    code: 'too_many_docs',
    surface: 'data tool isError',
    meaning: 'The app already holds the maximum number of live documents (DATA_MAX_DOCS_PER_APP).',
    fix: 'Delete stale documents or raise DATA_MAX_DOCS_PER_APP on the server. NOTE: local compose sets this LOW (5) on purpose.',
  },
  {
    code: 'doc_too_large',
    surface: 'data tool isError',
    meaning: 'A single document exceeds DATA_MAX_DOC_BYTES (default 100 KiB).',
    fix: 'Shrink the document or keep large content in an app file instead of a data record.',
  },
  {
    code: 'app_too_large',
    surface: 'data tool isError',
    meaning: 'The write would exceed the per-app storage cap (DATA_MAX_BYTES_PER_APP).',
    fix: 'Reduce total stored data, or raise DATA_MAX_BYTES_PER_APP.',
  },
  {
    code: 'rate_limited',
    surface: 'data tool isError',
    meaning: 'Too many writes for this app in the window (DATA_WRITE_RATE_LIMIT per DATA_WRITE_RATE_WINDOW_MS).',
    fix: 'Back off and retry; batch writes; or raise the write rate limit on the server.',
  },
  {
    code: 'unauthorized',
    surface: 'data tool isError',
    meaning: 'The collection access mode requires authentication and the caller is anonymous.',
    fix: 'Authenticate with an MCP token that has the right scope — or set the collection to public-read/public-write.',
  },
  {
    code: 'forbidden',
    surface: 'data tool isError',
    meaning: 'The caller is authenticated but lacks the role (editor+ for writes) or the token scope.',
    fix: 'Use a token/role with the required scope: data:write needs an editor+ membership.',
  },
  {
    code: 'not_found',
    surface: 'data tool isError',
    meaning: 'The workspace, app, collection, or document does not exist (or is not yours).',
    fix: 'Check the workspace slug (from whoami), app slug, collection name, and id.',
  },
  {
    code: 'not_implemented',
    surface: 'data tool isError',
    meaning: 'The operation is reserved for a later unit — e.g. owner-only collections (per-end-user auth is U11).',
    fix: 'Use public-read / public-write / locked for now.',
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
