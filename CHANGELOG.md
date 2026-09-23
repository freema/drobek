# Changelog — drobek (core)

## Unreleased (`next`)

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
