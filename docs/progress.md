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
- **M0-04 (NSO-282) — user-bound tokens, scopes, CIMD, API keys.** Migration
  `0008_user_bound_tokens` (generated, then hand-edited; destructive, see
  `CHANGELOG.md`) deletes all codes/tokens and drops their
  `workspace_id`/`role`; adds `oauth_clients.source`/`last_used_at` and
  `api_keys`. Scopes `read`/`write`/`publish`; `TOOL_SCOPES` in
  `packages/oauth/src/scopes.ts` drives both `tools/list` (only allowed tools
  are registered) and enforcement. Membership is resolved per call
  (`resource/access.ts`, super-admin override, uniform `not_found`). CIMD in
  `cimd.server.ts` (SSRF-guarded fetch, Redis cache), DCR rate limit + unused
  cap, RFC 9207 `iss`, audience check, `drk_` API keys + `task api-key:create`.

- **M0-05 (NSO-283) — the 6 core MCP tools.** `@drobek/mcp` holds the tool
  bodies (`list_apps`, `create_app`, `get_app`, `read_file`, `write_files`,
  `restore_version`); `packages/oauth` keeps transport/auth and calls
  `registerAppTools`. `write_files` = validate → secret scan (refuse, store
  nothing) → `@drobek/compile` → `createVersion` (source + built) → Redis
  `drobek:app-changed` publish. Single-writer lease `drobek:applock:<app_id>`
  (Lua, 3 min). Briefing + templates live in `@drobek/agent-dx`. The old
  whoami / collection_define / record_* / app_errors / app_logs tools are gone
  (M1 brings configure_module / query_data / get_logs). `APPS_DOMAIN` is
  required in production; migration 0009 adds `apps.name`.

- **M0-06 (NSO-285) — apps on their own origin + `publish`.** Host
  classification lives in `@drobek/apps` (`host.ts`: `classifyHost`,
  `isAppsOrigin`) so `@drobek/serving` and `@drobek/auth` share it without a
  dependency cycle. `@drobek/serving` = `createAppsHostMiddleware` (first
  Express middleware; dashboard host → `next()`, app host → `handleAppRequest`,
  bad Host → 400) + `ServeStore` (host-resolution cache 60 s, manifest cache,
  256 MiB byte LRU of blobs) + `subscribeServeCache` (local EventEmitter +
  Redis `drobek:app-changed`). `notifyAppChanged` in `@drobek/apps` emits
  locally AND publishes, so a single process never serves stale bytes even
  before the Redis round trip. Password gate with an HKDF(DROBEK_MASTER_KEY)
  signed `__Host-drobek_app_access`. `@drobek/auth` `origin-check.ts` refuses
  mutating dashboard requests from app/null/foreign origins. All dashboard
  cookies are `__Host-` (`cookies.ts` `hostCookieHeader`). MCP `publish` tool
  (scope `publish`, no lease). Migration 0010 (`team` → `password`,
  `apps.frame_ancestors`).

- **M0-07 (NSO-286) — TLS: Caddy sidecar, wildcard cert, `ask`.**
  `@drobek/core` `caddy.ts` renders the Caddyfile from env (modes
  internal / wildcard-file / dns / on-demand, strict validation, snapshots in
  `packages/core/src/__snapshots__/Caddyfile.*`); CLI
  `packages/core/dist/cli/caddy-config.js` behind `task caddy:config`.
  `@drobek/serving` `tls-ask.ts` (+ `.server.ts`) = the `ask` endpoint, mounted
  in `apps/server` at `/api/internal/tls/ask`. `TRUST_PROXY=x-real-ip` in
  `@drobek/auth` `getClientIp`. `docker-compose.production.yaml`,
  `docker-compose.tls.yaml` (`task dev:tls`), `deployments/Dockerfile.caddy`,
  `docs/SELF-HOSTING.md`.

- **M0-08 (NSO-289) — e2e loop + CI against the prod image.**
  `tests-e2e/tests/mcp-loop.spec.ts`: (1) `@local` — the official SDK client
  with an `OAuthClientProvider` (401 → discovery → DCR → PKCE consent driven by
  Playwright → `finishAuth`) then list → create → broken write → fix → preview
  host → publish → prod host → restore → get_app, asserted < 90 s (≈1 s
  locally); (2) `@smoke` — the same loop on a `drk_` key from `SMOKE_API_KEY`
  (a throwaway SQL-minted key under TEST_ENV=local), `smoke-<random>` app,
  public HTTP + MCP only. `agent-loop.spec.ts` → `dashboard-insights.spec.ts`
  (the insight panels, unchanged). `helpers/apps-host.ts` = raw app-host
  requests over http or https (127.0.0.1 + Host/SNI for `*.localhost`).
  `docker-compose.e2e.yaml` + `scripts/e2e-image.sh` (= `task e2e:image` = the
  CI `e2e` job): prod image behind Caddy `tls internal` on :8443, fresh
  throwaway datastores, whole `@smoke` + `@local` suite. `ci.yml`: push to
  `next`/`main` only, concurrency cancel, quality → e2e, main pushes the tested
  image.

## Next

- M0-09 (NSO-299) is blocked on Tomáš (VPS/DNS): it must provision
  `SMOKE_API_KEY` (a `read,write,publish` key of a dedicated smoke user —
  inside the prod container: `node node_modules/@drobek/oauth/dist/cli/api-key-create.js
  --email <smoke user> --name smoke --scopes read,write,publish`) and run
  `BASE_URL_WEB=https://… task e2e:smoke` after each deploy.
- M0-10 (NSO-302) is done locally: `freema/drobek-plugin` (PRIVATE until the
  new drobek.app is live — flip it public together with M0-09), local clone
  at `../drobek-plugin`, branch `next`, not pushed. Its `.mcp.json` targets
  `https://drobek.app/mcp`; once M0-09 is deployed, re-run the calculator
  test against production.
- M1-01 (NSO-287) done: `@drobek/modules` (registry, ModuleRouter, runtime,
  SDK build, skills, limits provider, module configs + encrypted module
  secrets), `@drobek/sdk` core, example external module
  `examples/drobek-module-hello` (dev + e2e compose run `DROBEK_MODULES=hello`),
  MCP `skill_info` + `configure_module`, dashboard API
  `POST /api/apps/:id/modules/:m/confirm|reject`, `docs/MODULES.md`.
  The `confirm_url` page (`/workspaces/<ws>/apps/<slug>/modules/<m>`) and the
  secrets form are M2-02. drobek-web does not wire the module runtime yet.
- M1-02 (NSO-294) done locally: built-in module `modules/auth`
  (`drobek-module-auth`; built-ins are `modules/*` workspace packages,
  `BUILTIN_MODULES` is gone), end-user sessions + epoch in `@drobek/modules`
  (`principal.ts`), scoped OTP in `@drobek/auth` (`eu:<app_id>`), inline SDK
  sources (`drobek/auth` → `<LoginGate>` compiled into the app with the app's
  React), dashboard API `POST /api/apps/:id/end-user-sessions/revoke` (shared
  guards in `packages/dashboard/src/app-api.server.ts`). Dev + e2e compose run
  `DROBEK_MODULES=hello,auth`. The dashboard UI for end users (list, disable,
  "sign everyone out" button) is M2-03. Core asks the auth module
  (`endUsers.current`) about every session on every module request, so a
  disabled / removed user is anonymous everywhere on the next request.
- M1-04 (NSO-295) done locally: the SMTP transport + layout moved to the new
  core package `@drobek/email` (`@drobek/auth` re-exports the old names);
  built-in modules `modules/email` (`notifyAdmins` → the app's owners =
  workspace editors/admins; `fromName`/`replyTo`; the mail authority
  `mail.prepare` with `EMAIL_PER_APP_PER_DAY`) and `modules/forms` (token /
  submit / admin list + CSV, honeypot, HMAC time token from
  `DROBEK_MASTER_KEY`, `mod_forms_submissions`, inline `<Form>`). Core:
  `{ appOwners: true }` recipients, the operator-wide mail cap + pause
  (`mail-guard.ts`, `EMAIL_GLOBAL_HOURLY_MAX`, ALERT log line), contract
  `requires` + `mail` + route `bodyTypes` (text-only multipart,
  `multipart.ts`). Dev + e2e compose run `DROBEK_MODULES=hello,auth,email,forms`.
  The dashboard view of submissions is M2 (the owner reaches them through
  the app as an admin today).
- Next: M1-03 data.

## Notes and gotchas

- App hosts in e2e / curl: Node and curl do not resolve `*.localhost` on every
  system — send `Host: <slug>--preview.apps.localhost:3041` to
  `127.0.0.1:3041` instead. Chromium resolves `*.localhost` itself, so
  `page.goto(http://<slug>.apps.localhost:3041)` works.
- Chromium (Playwright 1.50 / 133) REFUSES `__Host-` cookies on
  `http://localhost` and even plain `Secure` ones on `http://*.localhost`.
  That is why `cookieName()` / `appCookiesSecure()` drop the prefix + Secure
  on plain-http dev (NODE_ENV ≠ production and an http origin); production is
  always `__Host-`. The e2e derives the expected names from the target scheme.
- Playwright's `context.cookies(url)` lists a host-only `localhost` cookie for
  `http://x.apps.localhost` too (its own domain-suffix filter) — the browser
  does NOT send it. Assert on `response.request().allHeaders().cookie`.
- Playwright `APIRequestContext` sends no `Origin`, so the dashboard origin
  check lets it through (no `Sec-Fetch-Site` either); pass `Origin` explicitly
  to test the refusal.

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
- e2e specs that only need an app in the DB seed it through SQL
  (`tests-e2e/tests/helpers/seed.ts`); `mcp-core-tools.spec.ts` drives the real
  tools. `task e2e` truncates the local dev DB in global-setup.

- `drizzle-kit generate` DID see the 0008 changes (unlike 0007); the SQL was
  then hand-edited (TRUNCATE of codes/tokens before the column drops,
  `last_used_at` backfill for clients that were already used).
- `tests-e2e/proxy-echo.mjs` is a bind-mounted script, not a watched one:
  after editing it run `docker compose restart proxy-echo`. It also serves the
  CIMD mock documents (`/cimd/…`); `OAUTH_CIMD_DEV_ORIGINS` in
  `docker-compose.yml` allows exactly `http://proxy-echo:8099`.
- Locally every request shares the `unknown` client-IP bucket (NSO-309), so
  the DCR limit (10/h) would trip across specs: `registerClient` in
  `tests-e2e/tests/helpers/mcp.ts` clears the `oauth-register-ip` bucket
  first, and global-setup truncates `oauth_clients`. Behind Caddy with
  `TRUST_PROXY=x-real-ip` (`task dev:tls`, the production compose) requests
  get per-client buckets again (M0-07); the plain-HTTP dev stack still shares
  `unknown`.
- An MCP tool that the grant does not allow is simply not registered; calling
  it yields the SDK's own `isError` "Tool … not found" result, not a
  drobek error code.

- `task check` rebuilds every package's `dist/` on the host bind mount; the
  running dev container can read a half-written file and crash-loop
  (`EACCES … packages/core/dist/health.js`). Don't run `task check` while
  someone is testing against the stack; `docker compose restart drobek` fixes it.

- `task dev:tls` binds host port 443 (Docker Desktop allows it without
  root); `DEV_TLS_PORT=8443` otherwise. curl needs `--cacert .caddy/root.crt`
  and `--resolve <host>:443:127.0.0.1` for `*.localhost`; Node needs
  `NODE_EXTRA_CA_CERTS=.caddy/root.crt`. Behind Docker Desktop, Caddy sees the
  host's requests from a Docker Desktop proxy address (not 127.0.0.1) — that
  is what lands in `X-Real-IP` / the rate-limit keys. Leave with
  `task dev:tls:down` before `task e2e` (the override switches drobek to the
  https, port-less URLs the e2e does not expect).
- `caddy reload` is a no-op when the config text is unchanged; only
  `--force` makes Caddy re-read a renewed certificate FILE (verified: the
  served serial changes only after `reload --force`).
- On-demand with a wildcard site address (`*.<APPS_DOMAIN> { tls { on_demand } }`)
  issues a per-host certificate (SAN = the exact host) after the ask says 200;
  Caddy merges `?domain=` into an ask URL that already has `?token=`.
- The Caddy admin API logs every request at info level — don't poll it from
  a healthcheck; the compose files probe the TLS port with `nc -z`.

- The image e2e flow runs NODE_ENV=production, so it needs TLS: Chromium
  refuses the production `__Host-` cookies on plain http. Playwright gets
  `ignoreHTTPSErrors` (E2E_IGNORE_HTTPS_ERRORS=1); Node clients (MCP SDK,
  node:https) trust Caddy's root through NODE_EXTRA_CA_CERTS
  (`.caddy/e2e-root.crt`, copied per run). `E2E_TARGET_PRODUCTION=1` flips the
  CIMD spec to asserting the refusal of the http dev origin
  (`OAUTH_CIMD_DEV_ORIGINS` is ignored in production).
- Behind Caddy a nested label (`x.<slug>.apps.localhost`) matches no
  certificate — the handshake fails (TLS alert 80) instead of the plain-http
  404; apps-origin.spec asserts either by scheme.
- `healthz-degraded.spec` runs `docker compose stop redis`; under the image
  flow the script exports COMPOSE_FILE + COMPOSE_PROJECT_NAME so it stops the
  e2e stack's redis, not the dev one.
- esbuild's native binary (`@esbuild/linux-<arch>`, fetched for the build
  platform) runs in the production image: every `create_app` in the image run
  compiles the react-ts template.
- There is no app deletion path outside the database (no MCP tool; the
  dashboard delete is M2-01), so the prod smoke leaves one `smoke-*` app per
  run.
- Validate the workflow without installing anything:
  `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`.

- Testing the plugin against the dev stack: copy `plugins/drobek` to a
  scratch dir and replace its `.mcp.json` with the localhost URL plus
  `"headers":{"Authorization":"Bearer ${DROBEK_API_KEY}"}` (Claude Code
  expands the env var, so the key never lands in a file), then
  `claude -p "/drobek:build-app a calculator" --plugin-dir <copy>
  --allowedTools mcp__plugin_drobek_drobek__…`. Mint the key for a synthetic
  user created through the normal OTP login (Mailpit), not an existing one.
- `claude plugin validate` only parses skill/command frontmatter under the
  conventional `skills/` + `commands/` layout; the plugin repo's
  `scripts/validate-claude-components.mjs` stages each skill variant that way.

- Module resolution: `DROBEK_MODULES=x` → package `drobek-module-x`, resolved
  from the server's package.json (`DROBEK_MODULES_ROOT` overrides); a load
  error stops the server at start. The module runtime is memoized on
  `globalThis` so the Vite-loaded dashboard routes share the server's
  instance.
- The platform/module error for a password-locked app is `password_required`
  (401 JSON); `app_locked` stays the MCP single-writer lease code.
- A compile `unresolved_import` hint names a skill only when that skill is
  active on the server; otherwise it is the bare `skill_info()`.

- End-user cookie over plain-http dev is `drobek_eu` without `Secure`
  (Chromium refuses Secure cookies on `http://*.localhost`); production and
  https apps origins use `__Host-drobek_eu` + `Secure`. The auth e2e derives
  the name from `APPS_URL_SCHEME`.
- A built-in module is a NEW workspace package: the dev compose needs its
  anonymous `node_modules` volume (`/repo/modules/<name>/node_modules`) and
  the container must be recreated (`docker compose up -d drobek`), not just
  restarted, after a compose env/volume change.
- Heredocs / the Write tool turn `\u2028` / `\u2029` escapes inside regex
  literals into the literal characters (TS1161 "Unterminated regular
  expression literal"); write them back as escapes.
- After a host `task check`, the dev server can answer 500 with `EACCES`
  reading a freshly rebuilt `packages/*/dist` file from Vite's SSR build;
  another `docker compose restart drobek` clears it.
- `configure_module` issue paths use brackets for array indexes
  (`allow.emails[0]`).
- Mailpit's REST `Text` uses `\r\n` line endings: normalize before matching
  multi-line text in e2e.
- Postgres `jsonb` does not keep the submitted key order (shorter keys first):
  the forms CSV sorts its field columns by name.
- The auth module's `send-code` answers 200 WITHOUT sending inside the
  per-address cooldown: an e2e that expects a refusal (e.g. the mail pause)
  must use a fresh address.
- After a lockfile change the first dashboard page load in dev triggers Vite's
  dependency re-optimization and a full reload — the first e2e sign-in can
  time out once; rerun.
- e2e specs read server log lines with `docker compose logs --since <iso>
  drobek` (works for the dev stack and `task e2e:image`, whose script exports
  `COMPOSE_FILE` / `COMPOSE_PROJECT_NAME`); match on a unique app id and
  start a minute back to tolerate clock skew.

## Failed approaches

- `pnpm deploy --offline` in the Dockerfile builder: fails with
  `ERR_PNPM_NO_OFFLINE_META` (deploy re-resolves peer ranges and needs registry
  metadata that `pnpm fetch` does not cache). Keep deploy online.
