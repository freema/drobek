# Changelog — drobek (core)

## Unreleased (`next`)

### ⚠️ Breaking: the MCP tool set is replaced — create_app + write tools (NSO-283)

The MCP server now exposes exactly **six tools** (new package
`@drobek/mcp`; `@drobek/oauth` keeps the transport, sessions and auth):

| Tool | Scope | Annotations |
| --- | --- | --- |
| `list_apps` | read | readOnly |
| `create_app` | write | not read-only, not destructive |
| `get_app` | read | readOnly |
| `read_file` | read | readOnly |
| `write_files` | write | destructive |
| `restore_version` | write | destructive |

- **Removed from MCP:** `whoami` (its answer is part of `list_apps`),
  `collection_define`, `record_create` / `record_read` / `record_update` /
  `record_delete` / `record_query`, `app_errors`, `app_logs`, and the
  `add-data-to-app` prompt (replaced by `build-an-app`). The data and insights
  packages stay — the dashboard still uses them. Agents configured against the
  old tools must be updated; `publish` unlocks no tool until M0-06.
- **Apps are addressed by `app_id`** and every call is authorized against the
  app's workspace (viewer+ reads, editor+ writes, super-admin everywhere; a
  foreign or missing app is the same `not_found`).
- **`create_app`** derives the slug from `name` (a free `-xxxx` suffix when
  taken) and stores version 1 from the `react-ts` template (pinned React
  import map) or the `html` template, compiled; it returns the briefing.
- **`write_files`**: 1–20 changes → validate → secret scan → compile → one new
  version (`compile_status` ok | error; sources are kept either way, built
  outputs only when ok) → a Redis `drobek:app-changed` message (cache bust
  for M0-06). A credential in a file is refused with `secret_in_source` and
  nothing is stored.
- **Single-writer lease** `drobek:applock:<app_id>` (3 min, renewed by every
  write): another user gets `app_locked` with the masked holder and
  `expires_at`; the same user's other sessions take it over.
- **`read_file`** output is marked `untrusted: true` and wrapped in an explicit
  untrusted envelope.
- **Errors** are `{ code, message, hint }` (was `{ error, message }`), with the
  hints from the rewritten error catalogue.
- **New config `APPS_DOMAIN`** (+ optional `APPS_URL_SCHEME`): the host apps
  live under — `<slug>.<APPS_DOMAIN>`, preview `<slug>--preview.<APPS_DOMAIN>`.
  Required in production (the server refuses to start without it); dev default
  `apps.localhost:3041` over http.
- **Migration `0009_app_name`** adds the nullable `apps.name` (additive).

### ⚠️ Breaking: user-bound MCP tokens, new scopes, CIMD (NSO-282)

Core migration **`0008_user_bound_tokens`** makes every MCP credential belong
to a **user**, not a workspace. It runs automatically on server start and is
**destructive by design**:

- **Deleted:** every OAuth authorization code, access token and refresh token
  (`TRUNCATE`) — each connected agent must reconnect once and go through the
  consent screen again. Registered clients are kept.
- **Dropped columns:** `workspace_id` and `role` on `oauth_authorization_codes`,
  `oauth_access_tokens` and `oauth_refresh_tokens`. Access is now decided **per
  tool call** from the user's current memberships (super-admins reach every
  workspace); an unknown workspace, a workspace the user is not a member of and
  a missing app all answer the same `not_found`.
- **New scopes** `read` / `write` / `publish` replace the old vocabulary
  everywhere (AS metadata, consent, tokens, docs). The consent screen has no
  workspace picker any more — only the three checkboxes; the grant is the
  checked ∩ requested scopes, and an empty grant is a denial. `tools/list`
  shows only the tools the grant allows (one tool→scope table):
  `read` = `whoami`, `list_apps`, `record_read`, `record_query`, `app_errors`,
  `app_logs`; `write` = `collection_define`, `record_create`, `record_update`,
  `record_delete`; `publish` = no tools yet; `whoami` is always available.
- **`whoami`** now lists all of the user's workspaces with roles;
  **`list_apps`** spans every workspace, with an optional `workspace` filter.
- **CIMD:** an `https` `client_id` URL is a Client ID Metadata Document,
  fetched through the proxy SSRF guard (https only, default port, 64 KiB,
  5 s, no redirects, cached 1 h in Redis); its `client_id` must equal the URL
  and its `redirect_uris` pass the DCR policy. Any failure is `invalid_client`,
  shown, never redirected. AS metadata advertises
  `client_id_metadata_document_supported: true`. New columns
  `oauth_clients.source` (`dcr` / `cimd`) and `oauth_clients.last_used_at`.
- **DCR limits:** 10 registrations per IP per hour (→ `429 rate_limited`), and
  at most 500 never-authorized clients (`OAUTH_DCR_MAX_UNUSED_CLIENTS`; stale
  ones older than 24 h are pruned, otherwise `503`).
- **RFC 9207:** every authorization response carries `iss`
  (`authorization_response_iss_parameter_supported: true`).
- **Audience:** the resource server accepts only tokens whose resource is the
  MCP URL (else `401 invalid_token`); `/oauth/authorize` with a foreign
  `resource` answers `invalid_target`.
- **API keys:** new table `api_keys` (only the SHA-256 is stored). A
  `drk_…` bearer takes the same resource-server path as an OAuth token;
  revoked → `401`. Create one with
  `task api-key:create EMAIL=… [NAME=…] [SCOPES=read,write]`.
- **New config:** `OAUTH_DCR_MAX_UNUSED_CLIENTS` (default 500) and the
  dev-only `OAUTH_CIMD_DEV_ORIGINS` (exact origins allowed over http / on a
  private address for local CIMD mocks; ignored in production).

### ⚠️ Breaking: the upload/deploy pipeline is gone — apps are versions now (NSO-281)

Core migration **`0007_app_versions`** replaces the deploy pipeline with
immutable app versions. It runs automatically on server start and is
**destructive by design**:

- **Dropped tables:** `deploys`, `deploy_files`, `blob_refs` and the old
  metadata-only `blobs` table; **dropped enums** `deploy_state`, `routing_mode`;
  **dropped columns** `apps.active_deploy_id`, `apps.routing_mode`,
  `apps.uses_end_user_auth`. Deploy history is **not** migrated (decided in
  the M0 plan) — back up the database first if you want to keep it.
- **New tables:** `blobs` (sha256 → `bytea`, deduplicated across versions and
  apps), `app_versions` (numbered per app, author kind, reasoning, compile
  status/errors), `version_files` (path → blob, `source` or `built`), and
  `apps.published_version_id`.
- **App slugs are now globally unique** host labels: 3–40 characters of
  `^[a-z0-9]+(-[a-z0-9]+)*$`, no reserved word (`www api mcp preview admin
  mail static app auth oauth`). The migration renames any existing slug that
  breaks the grammar, is reserved, or collides with an older app's slug in
  another workspace to `<slug>-<4hex>` (the oldest app keeps a contested
  slug). Kept: apps, collections, documents, error/stat signals, upstreams and
  the audit log.
- **Removed:** `@drobek/deploy`, the MCP tools `deploy_init`,
  `deploy_commit`, `deploy_status`, `rollback`, the routes `/__upload/:token`,
  `/__blob/:sha256`, `/api/deploys/:id/events`, `/:ws/app/:slug/*` (incl. the
  REST data endpoints and the error beacon on the dashboard host), the MCP
  prompt `deploy-this-project`, `scripts/sign-upload.mjs` / `task blob:sign`.
- **Removed config:** `UPLOAD_SIGNING_SECRET`, `BLOB_DIR`, `DEPLOY_MAX_*`,
  `DEPLOY_WORKER_CONCURRENCY` and the `drobek_blobs` volume. The old blob
  directory is no longer read — delete it once you no longer need it.
- **New:** `@drobek/apps` (`createApp`, `createVersion`, `getVersion`,
  `listVersions`, `publish`, `restore`, hourly blob GC with a 7-day grace
  period under a Redis lease). The dashboard shows each app's version history
  and lets an editor publish a version (publishing an older one is the
  rollback); `app_logs` reports recent versions instead of deploys.

### One process, one image (NSO-279)

`apps/web` + `apps/mcp-server` + the worker became one `apps/server` process
and one image `ghcr.io/freema/drobek`; the server migrates the database on
start and refuses to boot with placeholder secrets.

### `@drobek/compile` (NSO-280)

In-process esbuild compiler for app sources (virtual file system, import map
from `drobek.json`, limits, secret scan).
