# drobek — implementation progress (the `/implement` loop)

Working memory for the Linear-driven loop (project **Drobek**, team Nsoft,
NSO-279..NSO-308). The plan is [`vision-plan.md`](./vision-plan.md); the
one-page pitch is [`navrh-drobek.md`](./navrh-drobek.md). All work lands on the
single long-lived `next` branch; pushes happen only at milestone end.

## Current state

- Branch `next` was created from `origin/main` (b0443d8, PR #1 merged) on
  2026-09-22.
- **M0-01 (NSO-279) — one process, one image.** `apps/web` + `apps/mcp-server`
  → `apps/server` (Express + `@react-router/express` + `mountMcpResource` at
  `/mcp`). The BullMQ worker container and `scripts/worker.mjs` are gone; the
  deploy consumer + audit prune run in-process (`apps/server/server/jobs.ts`)
  until M0-02 removes the upload pipeline. Root `Dockerfile` (`dev` + `runner`
  targets) → `ghcr.io/freema/drobek`. The server migrates itself on start
  (`runCoreMigrations`) and refuses placeholder secrets
  (`@drobek/core` `secretsConfigError`). MCP resource = `PUBLIC_APP_URL + /mcp`.
- **M0-03 (NSO-280) — `@drobek/compile`.** In-process esbuild (`context()` +
  `rebuild()`) over an in-memory file map: virtual-FS plugin (never the disk),
  `drobek.json` import map (bare → `https://` external, `drobek` →
  `/__drobek/sdk.js`), pre-build limits (`COMPILE_*`), secret scan, import
  depth cap, FIFO semaphore (`busy`), per-build timeout via `ctx.cancel()`.
  Not wired into any tool yet — `write_files` (M1) calls it. ~3 ms warm.
- **M0-02 (NSO-281) — app versions, upload pipeline gone.** Migration
  `0007_app_versions` (hand-written; destructive, see `CHANGELOG.md`) drops
  deploys/deploy_files/blob_refs/old blobs and adds `blobs` (bytea, sha256
  dedup), `app_versions`, `version_files`, `apps.published_version_id`; slugs
  are now globally unique host labels (CHECK + rename of offenders).
  `@drobek/apps` = createApp / createVersion / publish / restore / blob GC
  (hourly, Redis lease, 7-day grace). `@drobek/deploy`, the deploy MCP tools,
  `/__upload`, `/__blob`, `/:ws/app/:slug/*` (serving, REST data, beacon) and
  `UPLOAD_SIGNING_SECRET` / `BLOB_DIR` / `DEPLOY_MAX_*` are gone. The dashboard
  shows a version history with a Publish button (editor+). App serving and
  the beacon come back on the apps origin in M0-06.

## Next

- M0-04 (NSO-282), then M0-05 (NSO-283, `create_app` + write tools),
  M0-06 (NSO-285), M0-07 (NSO-286), M0-08 (NSO-289). M0-09 (NSO-299) is
  blocked on Tomáš (VPS/DNS); M0-10 (NSO-302) needs `freema/drobek-plugin`.

## Notes and gotchas

- The containerd image store reports the **compressed** size in
  `docker image inspect .Size`; `scripts/prod-proof.sh` measures the unpacked
  root filesystem (`du -sxm /`) instead.
- `pnpm deploy --legacy` copies whole workspace package dirs (incl. `dist/`,
  `drizzle/`), not a `files`-filtered pack.
- `typescript` arrives as an optional peer of `@react-router/{node,express}`;
  the Dockerfile deletes it from the prod tree (typegen only).
- drobek-web still has its own `apps/web` + `apps/mcp-server` + worker glue
  pinned to the old core submodule sha — it adapts when M0-09 bumps the
  submodule.

- Dev mode runs Vite in middleware mode inside the server; its HMR websocket
  MUST share the app's HTTP server (`hmr: { server }`) — the default port
  24678 is not published from the container and breaks the dashboard
  (caught by the console-clean `auth-smoke` spec).
- e2e now hits Express in dev too (before, `react-router dev` = Vite/connect),
  so text responses carry `; charset=utf-8` like production always did.
- Docker Desktop's VM clock drifts after the Mac sleeps (seen: 15 min behind),
  which breaks token-expiry specs; resync with
  `docker run --rm --privileged alpine:3 hwclock -s`. A sleeping/throttled
  host also produces spurious login-navigation timeouts — rerun the failing
  specs before debugging them.
- The full e2e suite needs Playwright Chromium on the host:
  `pnpm -C tests-e2e exec playwright install chromium`.

- esbuild drops unused TS imports (type-only elision), so an "unresolved
  import" test must actually USE the import or esbuild never resolves it.
- A timed-out compile is stopped with its own `ctx.cancel()`; the global
  `esbuild.stop()` would kill every concurrent build in the process.

- DB-backed unit tests use PGlite (`@electric-sql/pglite`) +
  `setDbForTests()` from `@drobek/db`. PGlite MUST also be a root
  devDependency: otherwise pnpm resolves two peer variants of drizzle-orm and
  the `@drobek/db` table objects stop matching the ones in the test package.
  `db.execute` runs one statement; use `pg.exec` for multi-statement seeds.
- `drizzle-kit generate` did not see the 0007 changes against the snapshot
  (it reported "No schema changes"); 0007 is hand-written, with the snapshot
  taken from a fresh generate. `packages/apps/src/migration.test.ts` applies
  0000–0006, seeds prod-shaped rows, then applies 0007.
- Until `create_app` / write tools exist (M0-05), e2e specs seed apps and
  versions straight into Postgres (`tests-e2e/tests/helpers/seed.ts`).

## Failed approaches

- `pnpm deploy --offline` in the Dockerfile builder: fails with
  `ERR_PNPM_NO_OFFLINE_META` (deploy re-resolves peer ranges and needs registry
  metadata that `pnpm fetch` does not cache). Keep deploy online.
