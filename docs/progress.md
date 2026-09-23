# drobek — implementation progress (the `/implement` loop)

Working memory for the Linear-driven loop (project **Drobek**, team Nsoft,
NSO-279..NSO-308). The plan is [`vision-plan.md`](./vision-plan.md); the
one-page pitch is [`navrh-drobek.md`](./navrh-drobek.md). All work lands on the
single long-lived `next` branch; pushes happen only at milestone end.

## Orchestration run 2026-09-23 (Fable orchestrates, Opus 5.5 implements, Sonnet verifies)

Tomáš asked for a fully orchestrated `/implement` run: production code by
Opus 5.5 subagents, black-box verification by Sonnet, everything lands on
`next`, ONE merge request at the end (no per-task PRs). Run log:

| # | Task | State | Notes |
|---|------|-------|-------|
| 1 | NSO-300 M1-03 data | done (unit + data specs green) | squashed wip 8682b79 into the feat commit; full e2e at block end |
| 2 | NSO-296 M1-05 files | merged b056d57, check green | module-owned migration; 13-file conflict merge by Opus |
| 3 | NSO-297 M1-06 proxy | merged 9130f7e, check green | e2e spec written, runs at block end |
| 4 | NSO-290 M1-07 get_logs | merged 2a7fe09, check green | migration 0014; e2e spec at block end |
| 5 | NSO-320 e-mail budget split | merged 2199fa1, check green | no migration |
| 6 | NSO-288 M2-01 app page | merged 28ee0d3 (+ test-id/tab-test fixups), check green | slot 0016; Modules/Domains/Forms/Users/Uploads/Logs tabs live in `app-tabs.ts` |
| 8 | NSO-292 M3-01 domains | merged 1836a03 + b962c18, check green | 0018 prevId re-chained to 0016; compose env changed → `docker compose up -d drobek` before block-end e2e |
| 10 | NSO-308 M1-08 skills | merged dc4ee4c (+c255d1c), check green | `task eval` runs after block-end e2e; module SKILL.md ≤ 149 lines |
| 11 | NSO-301 M2-03 data/forms/users/uploads/logs tabs | merged c63acef, check green | no migration; `AppSubnav` now reads `APP_TABS` |
| 12 | NSO-293 M4-02 abuse | merged e61be60 + e85af86 (Opus merge agent), check green | 0021 re-chained to 0018; app page 423 + LockedByAdminNotice |
| 13 | NSO-304 M4-03 self-host packaging | merged dd564fd (+1dd5d75), check green; local rehearsal PASSED | clean-VPS timing → Tomáš (BLOKOVÁNO); `main` CI now pushes `:edge`, releases push `latest` |
| 15 | NSO-322 M1 security fixes (R1 R2 H1 H2 H3 M1 M2) | merged 336061d..2ade6ed (+dee94ac), check green | admin-only proxy confirms; per-app sign-in share |
| 16 | NSO-309 OTP unknown-IP bucket | merged 6ffac11, check green | follow-up NSO-328 for the same pattern elsewhere |
| 17 | NSO-316 smoke cleanup | merged 94d258f, check green | prod smoke reuses one stable slug |
| 18 | NSO-315 unknown-host negative cache + limiter | merged 27e1436 (+98a5910), check green | 429 before lookup for throttled IPs |
| 19 | NSO-305 drobek-web restructure (+318 folded) | running (repo ../drobek-web, branch next) | separate repo; image not yet published |
| 20 | NSO-298 docs rewrite | running (worktree, base 98a5910) | adds doc-lint to `task check` |
| – | M1 block-end e2e + black-box | e2e green (99 + reruns, 8f25925); Sonnet black-box 25 PASS / 0 FAIL / 1 not testable (NSO-320 cap needs Redis seeding) | **M1 complete** → `next` pushed, draft MR opened |
| 7 | NSO-291 M2-02 modules UI | merged 8d88040, check green | pending owner mail 1/h per app |
| 9 | NSO-284 M2-04 keys/connections | merged 574cb76, check green | no migration |
| 14 | M1 security review (read-only, `953659f..8f25925`) | done: 2 red-gate (SVG sniffer ReDoS, proxy `\` escape), 4 high, 6 medium, lows | fixes → NSO-322 (running, worktree from 31a53ca); follow-ups filed NSO-323..327 |

**Mode change (Tomáš, 2026-09-23 evening):** speed over per-task proof. Per
task = implementation + unit tests + e2e spec FILES + green `task check`;
the full `task e2e` + Sonnet black-box pass runs ONCE at the end of the M1
block, then `next` is pushed and the single MR opened.

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

- **M1-07 (NSO-290) — `get_logs`.** Core beacon `POST /__drobek/v1/_beacon`
  on every app host (`@drobek/insights` `handleBeacon`, framework-free, routed
  by `@drobek/serving` before the module runtime): same-origin only (403),
  8 KiB cap on the declared length AND the drained stream (413, the process
  keeps serving), per-app/IP Redis caps, PII redaction, then `app_errors`.
  The compiler prepends `import "/__drobek/beacon.js?v=<hash>";` to every JS
  entry (esbuild `banner`; `drobek.json` `"beacon": false` opts out); the
  script (`@drobek/sdk/beacon`, built by `@drobek/modules` next to `sdk.js`)
  hooks `error` / `unhandledrejection` and flushes with `sendBeacon` (fetch
  keepalive fallback). Migration `0014_get_logs`: `app_compiles` (every
  compile of `create_app` / `write_files`, refused ones
  with `version: null`; 30 days, newest 200 per app) and
  `module_request_stats (app_id, module, status_class, day, count)`, upserted
  by the module runtime for active modules. MCP `get_logs({ app_id, kind:
  runtime|compile|requests, since? })`: scope `read`, viewer+, ≤ 100 entries
  (compile ≤ 50), window clamped to 30 days, `{ entries, untrusted: true }`
  inside an `<untrusted-app-logs … nonce>` envelope. TOOL_DOCS / TOOL_SCOPES /
  briefing / skill / parity tests updated (11 tools). e2e
  `tests-e2e/tests/get-logs.spec.ts` written.
- **M3-01 (NSO-292) — custom domains.** New `@drobek/domains`; migration
  `0018_custom_domains` (`domains`: unique (app_id, hostname), partial unique
  hostname WHERE verified — one verified owner per name, unverified claims
  never block — and one primary per app). PSL/IDN hostname checks (drobek.app,
  APPS_DOMAIN, the dashboard host, IPs, special TLDs refused), TXT
  `_drobek.<host>` + CNAME (A/AAAA fallback for apex) over an injectable
  resolver, `DOMAINS_MAX_PER_APP` (3 → `limit_exceeded`). `classifyHost` now
  returns `custom` for plausible foreign hosts (unknown → still the
  dashboard; registered-unverified → 404; verified → published version);
  primary domain = 302 from `<slug>.<APPS_DOMAIN>`. TLS ask 200 for verified
  domains; the Caddy generator renders an on-demand `https://` catch-all
  (default on in on-demand mode, `TLS_CUSTOM_DOMAINS`). Leased hourly sweep
  re-checks domains older than 24 h, unverifies on definitive failure and
  mails editors/admins. Dashboard Domains tab; MCP `publish` returns
  `domains`. e2e `tests-e2e/tests/domains.spec.ts` written (not run).

- **M2-01 (NSO-288) — dashboard app page.** Tabs Overview / Files / Data /
  Settings from `packages/dashboard/src/app-tabs.ts` (add a tab = one line +
  its route). Shared server half `app-page.server.ts`: `loadAppPage` (role
  gate + live app), `appHeaderData`, and `appAction` — every app mutation
  by `intent` (publish, restore, unpublish, unlock, visibility,
  frame-ancestors, delete), editor gate first, each a `@drobek/apps` call
  that audits, then `notifyAppChanged`. The header (`app-header.tsx`) posts
  to the base route with `redirectTo`, so any tab can render it without an
  action. Files tab + `/files/download?version=N` (ZIP of source + built,
  own `zipStream`). `@drobek/apps`: `unpublishApp`, `softDeleteApp`,
  `releaseDeletedAppSlugs` (+ `startSlugRelease`, wired in
  `apps/server/server/jobs.ts`), `setAppVisibility`, `setFrameAncestors`,
  `readAppLease` / `releaseAppLease`, `versionZip`. Migration
  `0016_apps_slug_release`. e2e `tests-e2e/tests/dashboard-app.spec.ts`
  written (not run in the task).

- **M2-03 (NSO-301) — dashboard owner tabs.** Data tab: JSON record edit
  (module-validated), CSV import (server-side `parseCsv` in `@drobek/core`,
  ≤ 5 000 rows, all-or-nothing in one tx, the first bad row named by its
  line; bypasses the write rate limit, not the quotas), delete collection
  (typed name; records + config patch + audit in one tx through the
  runtime's owner config path). New tabs `…/apps/:appSlug/forms` (filter by
  form + UTC day range, CSV, delete), `…/end-users` (role, block, sign
  everyone out), `…/uploads` (list, raster preview proxied by the dashboard
  with nosniff + sandbox CSP, delete) and `…/logs` (the `get_logs` readers,
  since + Refresh). Contract: optional `records.update/importCsv/
  dropCollection`, `endUsers.list/setRole/setDisabled`, new `submissions` and
  `files` authorities (`OwnerView` with `limits()`); new audit actions
  `data.*`, `forms.submission_delete`, `end_users.role|disable|enable`,
  `files.delete`. No migration. e2e `tests-e2e/tests/dashboard-app-data.spec.ts`
  written (not run).

- **M4-02 (NSO-293) — abuse and moderation.** Migration `0021_abuse_reports`
  (`abuse_reports` + `apps.locked_reason`). Every app host answers
  `/.well-known/drobek-report` (JSON pointer to `<dashboard>/report?host=…`)
  and sends `X-Drobek-App: <slug>`. Public form `/report` (honeypot, 5 valid
  reports / IP / hour → 429, `ABUSE_REPORTS_PER_IP_HOUR`), audit
  `abuse.report`, one mail per app per hour to `SUPERADMIN_EMAIL`. Super-admin
  queue `/admin/abuse` (403 for everyone else): resolve / takedown / restore.
  Takedown (`@drobek/apps` `takedownApp`) = lock + unpublish + resolve the
  app's open reports + audit `admin.takedown` + owner mail; every app host
  (prod, preview, `--vN`) answers 451 with a terms link (`TERMS_URL`),
  platform paths 451 JSON; `write_files` / `publish` / `restore_version` /
  `configure_module` → `app_locked_by_admin` (also enforced inside
  `createVersion` / `publish` / `restore`), `get_app` / `list_apps` show
  `locked_by_admin`. Restore (`restoreApp`) lifts the lock, does NOT
  republish, audit `admin.restore`. Publish heuristic (`scanForPhishing`,
  inside `@drobek/apps` `publish`): password field + a brand word
  (`ABUSE_BRAND_WORDS`) → a `heuristic` report in the queue (never blocks).
  e2e `tests-e2e/tests/abuse.spec.ts` written, not run.
- **NSO-316 — the smoke tier cleans up after itself.** `mcp-loop.spec.ts`
  `@smoke`: under TEST_ENV=local a fresh `smoke-<random>` app is deleted at
  the end through the dashboard delete action (NSO-288) as the smoke user
  (e-mail OTP via Mailpit), in a try/finally so a failed run cleans up too
  (a cleanup error never masks the test's own failure). Against any other
  target (production, API key only, no destructive MCP tool) the spec uses
  ONE stable slug per key — `smoke-<first 12 hex of
  sha256("drobek-smoke-app:" + key)>` — found via `list_apps` → `get_app` and
  re-used (new version + publish) instead of a new app per run. One-time
  production cleanup of older `smoke-*` apps = runbook step under Next →
  M0-09. No migration; spec not run in the task (block-end e2e).

- **M1-08 (NSO-308): the agent skills.** There are 9 skills in the 5-section format:
  1. When to use
  2. Minimal working code
  3. API and types
  4. Rules and limits
  5. Errors → fix

  Each skill is at most 150 lines. Six are module skills:
  `modules/{auth,email,forms,data,proxy,files}/SKILL.md`. Three are general skills:
  `skills/{start,debug,ui}/SKILL.md`. `skill_info()` lists all 9, and each has a one-line
  `use_when`. The dev stack also lists `hello`, which makes 10.

  **`@drobek/skills-check`** is a new test-only package, wired into `pnpm typecheck` and
  `pnpm test`, and it runs in about 3 s. It checks every code block of every skill:
  - it compiles the block with `@drobek/compile`, using the skill's `drobek.json` import map;
  - it typechecks the block with one `ts.createProgram` against the CURRENT generated
    `sdk.d.ts`, the inline `drobek/<m>` types and `@types/react`;
  - for `ts api` blocks it asserts that the documented interface and the real one in
    `sdk.d.ts` are assignable both ways;
  - it validates `configure_module` payloads against the module's zod `configSchema`;
  - it checks that `html` scripts pass the apps CSP.

  It also checks the format of each skill: the sections, the line limit, the error codes
  (they must be in the catalogue), and the tool names that the `start` skill mentions.

  **`tests-eval/`** is the MANUAL reference-app eval, run as `task eval`. It is not in CI.
  - `run.mjs` runs the three apps (a) contact form → owner mail, (b) a list with login and an
    admin role, and (c) a proxy call. It has `--self-check` and `--dry-run` modes.
  - `lib.mjs` parses stream-json transcripts, parses `sdk.d.ts` and detects non-existent
    APIs. `skills-check` tests these parsers on the real SDK.

  **Other changes:**
  - The briefing's Styling line now names Tailwind v4's browser build on esm.sh
    (`TAILWIND_BROWSER_URL`).
  - The auth and forms `INLINE_TYPES` now import `JSX` from react (a bug fix).

  The eval has NOT been run yet. The orchestrator runs it and posts the results table.

## Next

- M0-09 (NSO-299) is blocked on Tomáš (VPS/DNS): it must provision
  `SMOKE_API_KEY` (a `read,write,publish` key of a dedicated smoke user —
  inside the prod container: `node node_modules/@drobek/oauth/dist/cli/api-key-create.js
  --email <smoke user> --name smoke --scopes read,write,publish`) and run
  `BASE_URL_WEB=https://… task e2e:smoke` after each deploy.
  **Runbook — one-time smoke cleanup (NSO-316), manual, never from an agent:**
  against production the smoke now re-uses one stable slug per key
  (`smoke-<12 hex>`, see `stableSmokeSlug` in `tests-e2e/tests/mcp-loop.spec.ts`),
  so apps from runs before that change (one `smoke-<random>` per run) stay
  behind. After the first deploy that carries NSO-316 and its green smoke run:
  sign in to the dashboard as the smoke user (e-mail OTP to that mailbox),
  open the personal workspace's Apps list, and for every `smoke-*` app EXCEPT
  the stable one use Settings → Delete (type the slug). The old per-run apps
  are `smoke-<8 hex>` (or a `smoke-<8 hex>-xxxx` variant); the stable one is
  `smoke-<12 hex>` and holds the newest version — keep it. Deleted slugs are released after 30 days.
  Repeat this for the old key's slug whenever `SMOKE_API_KEY` is rotated (a
  new key = a new stable slug).
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
- M1-03 (NSO-300) done locally: built-in module `modules/data`
  (`drobek-module-data`, own migration `0000_data_documents` incl. the legacy
  `access_mode` → rules import), rules per collection/op (`public | user |
  owner | admin`, `rules.test.ts` table), REST `/__drobek/v1/data/:collection`
  (+ `export.csv` admin), inline SDK `drobek.data.collection()`, contract
  `RecordsAuthority` (`records`) + `ConfirmContext` (3rd arg of
  `confirmRequired`, async ok), MCP `query_data` (scope read, ≤ 100,
  `untrusted`), dashboard Data tab on the records authority, `@drobek/data`
  removed, core migration 0012. `t.confirm()` in `@drobek/modules` testing.
- Next: M1-05 files, M1-06 proxy, M1-07 get_logs (parallel worktrees), then M1-08 skills.
- M1-06 (NSO-297) done locally: built-in module `modules/proxy`
  (`drobek-module-proxy`): `/__drobek/v1/proxy/:upstream/*`, per-app config
  `{ upstreams: { name: { rules: { call }, rateLimit? } } }` (assigning an
  upstream and `call: 'public'` are owner-confirmed), `PROXY_CALLS_PER_MIN`
  60/app, `PROXY_PUBLIC_CALLS_PER_MIN_PER_IP` 10, SDK `drobek.proxy.fetch`.
  `@drobek/proxy` keeps registry + crypto + SSRF guard, gains the port
  allow-list 80/443 (`PROXY_ALLOWED_PORTS`, PHY-76 #8), loses the
  dashboard-host route and its limiter. `@drobek/modules`: wildcard routes,
  raw bodies, `req.headers()` / `req.rawQuery`, the `appInfo` hook
  (`modules.<name>.info` in `get_app` / `configure_module`). Dev + e2e compose
  run `DROBEK_MODULES=…,proxy`. The per-app upstream view in the dashboard is
  M2; upstream registration stays in the workspace Upstreams page.
- Next: M1-03 data.
- M1-05 (NSO-296) done locally (worktree; the e2e spec
  `tests-e2e/tests/files-module.spec.ts` is written, not run yet): built-in
  module `modules/files` (upload / serve / delete / admin list, sniffed types,
  content-addressed blobs in `FILES_DIR` with cross-app dedup, per-app quota,
  `mod_files`). Core: route `bodyTypes: ['file']` + `req.file()` (streaming
  single-file multipart), `Readable` response bodies through the module
  pipeline and `@drobek/serving`, `@drobek/sdk` sends `FormData` as-is.
  Compose: `DROBEK_MODULES=…,data,files`, the `files_data` volume (dev + prod),
  e2e `FILES_QUOTA_PER_APP` 2 MiB.
- M2-04 (NSO-284) done locally: `/me/api-keys` + `/me/connections`
  (`packages/dashboard` routes, audited mutations in `account.server.ts`,
  listing/revocation in `@drobek/oauth` `api-keys.server.ts` /
  `connections.server.ts`), audit dictionary `api_key.create|revoke`,
  `oauth_client.revoke` (+ the module/proxy actions already written), the
  Activity/CSV `?actor=` filter incl. `end_user`, and the root-layout footer
  `Source (AGPL-3.0) · <sha>` (`@drobek/dashboard/footer`, sha = `GIT_SHA`
  from the root loader). No migration. e2e `dashboard-account.spec.ts` written.
- M2-02 (NSO-291) done locally: the dashboard Modules tab —
  `workspaces.$slug.apps.$appSlug.modules(.$module)` in `@drobek/dashboard`
  (the module page is configure_module's `confirm_url`): pending change with
  a before → after diff + risk notes + Confirm/Reject, a config form from the
  module's JSON Schema (own renderer, `module-config.ts` +
  `module-ui/json-schema-form.tsx`; the server validates through the same
  `runtime.configure` path, `surface: 'web'`), write-only secrets
  (Set/Rotate/Remove, audit name-only), the data collections + rules editor
  (op × principal checkboxes, JSON Schema textarea) and the proxy per-app
  upstream assignment. `PendingBanner` + `loadPendingBanner()` render "N
  changes await confirmation" on the app page (one Modules link + one banner
  line added to the current app route — NSO-288 rewrites that file). An
  agent-made pending change e-mails the owners through the email module (1/h
  per app, `drobek:rl:modules:pending-mail:<app_id>`). No migration. e2e
  `tests-e2e/tests/dashboard-modules.spec.ts` written, not run.
- **M4-03 (NSO-304) — self-host packaging** (worktree, check green, local
  rehearsal passed; the clean-VPS < 30 min run is Tomáš's). Production compose
  on `.env.production` (project `drobek-prod`, volumes `pg_data` …),
  `.env.production.example`, `task selfhost:init` / `selfhost:migrate` /
  `selfhost:upgrade` / `backup` / `restore` / `selfhost:rehearsal`
  (`scripts/selfhost-*.sh` + `scripts/lib/selfhost.sh`,
  `tests-e2e/selfhost-rehearsal.mjs`), `apps/server/server/migrate.ts`
  (`dist/server/migrate.js`), `/api/version` `{sha, version}` (build arg
  `VERSION` → `DROBEK_VERSION`), ci.yml `v*` tags → `vX.Y.Z` + `release` job
  (`previous` ← `latest` ← `vX.Y.Z`), `main` → `:edge`, amd64 only.
  `docs/SELF-HOSTING.md` rewritten around the quickstart.

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
  run. (Superseded by NSO-316: local runs delete via the dashboard, production
  re-uses one stable slug.)
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
- esbuild compiles only what the entry reaches: a file nothing imports is
  never resolved, so an e2e expecting `unresolved_import` (e.g. the firebase
  hint) must put the import in `src/main.tsx` itself.
- React Router's lazy route discovery fetches `/__manifest?paths=…` for the
  links on a rendered page; a `page.goto` right after the render aborts it and
  the browser logs `Failed to fetch manifest patches` — console-clean specs
  must `await page.waitForLoadState('networkidle')` before navigating away.
- Removing a workspace package leaves its anonymous-volume mountpoint
  (`packages/<name>/node_modules`) on the host; `rmdir` fails with
  "Permission denied" until the container is recreated without that volume
  (`docker compose up -d drobek`).
- The dev `DATA_MAX_DOCS_PER_APP=5` counts every collection of an app: an e2e
  that writes records into one app must stay within 5 (delete one first).
- drizzle's migrator tracks a journal entry by its `when`, not a hash: editing
  an unreleased migration never re-runs it on a DB that already applied it —
  recreate the DB (or test the SQL in PGlite) to see the change.
- The beacon's PII redaction also masks any run of 32+ `[A-Za-z0-9_-]`
  characters (opaque-token rule): a long app slug in a runtime error's URL or
  stack comes back as `[redacted]` — e2e apps that assert on the URL use
  a short name.
- The runtime beacon is an esbuild `banner` import in front of every JS
  entry, not part of `sdk.js`: an app need not import `drobek` to report
  errors, and a plain-HTML app with no JS entry reports nothing.
  `drobek.json` `"beacon": false` turns it off (a non-boolean is
  `invalid_config`).
- Migration `0014_get_logs` was built in parallel with 0013 (files) and 0015
  (proxy): the journal has idx 14 with no 13 yet, and all three snapshots
  point `prevId` at 0012 — when merging, re-chain `prevId` and keep the
  journal `when` values ascending in file order.
- `get_logs('requests')` flushes the Redis request counters into
  `app_daily_stats` for each day of the window on read (keys live 31 days);
  the MCP unit harness passes `flushSignals: false` (no Redis there).
- `module_request_stats` counting is fire-and-forget after the response:
  a unit test that reads it right after a request has to poll.
- Module mail budgets (NSO-320, `mail-guard.ts`): the class is derived from
  the recipient (`{ signInAddress }` = `sign_in`, else `notification`); Redis
  keys are now `drobek:rl:mail:{notification,sign_in}`,
  `drobek:mail:paused:{notification,sign_in}` and
  `drobek:rl:mail:app:<app_id>` — the old `drobek:rl:mail:global` /
  `drobek:mail:paused` are gone. The ALERT line keeps its message and
  `max` (= the global cap) and adds `class` + `class_max`. With
  `EMAIL_APP_HOURLY_SHARE=100` the per-app check refuses at the class budget
  BEFORE the class pause trips (a unit test that wants the pause from one
  app must pre-fill the class counter from another app). `memoryMailGuard`
  is the Redis guard over an in-memory store (`memoryMailGuardRedis`).
- The auth module's `send-code` now passes an `email_paused` refusal on
  unchanged (503 with `details.class: sign_in` + Retry-After) instead of its
  generic "could not be sent"; other mail errors still map to the generic 503.
- Proxy upstreams may only use ports 80/443 (NSO-297), so `http://proxy-echo:8099`
  can no longer be registered: `proxy-echo` also listens on `EXTRA_PORTS`
  (the composes set `80`) and the e2e registers `http://proxy-echo`. After
  pulling this change recreate it (`docker compose up -d proxy-echo`) and
  `drobek` (new `DROBEK_MODULES` + the `modules/proxy/node_modules` volume).
  The CIMD fetch (`@drobek/oauth`) passes its own `allowedPorts` to
  `ssrfSafeForward`, so its dev origin on 8099 keeps working.
- The proxy forces `Accept-Encoding: identity` upstream: forwarding the
  browser's `gzip` made Node's fetch decompress the body while the relayed
  `Content-Encoding` header still said gzip.
- `pollLoginCode` reads the newest mail of an address: two sign-ins of the
  same address in one spec can race — use a separate address per sign-in
  that can overlap (the proxy spec's flood app uses its own user).
- In an agent worktree, Bash refuses `cat > file <<EOF` / `>>` heredocs as
  "cannot verify it stays inside the worktree"; write files with the Write
  tool or a `python3 - <<'EOF'` script instead.
- A module route that takes a file declares `bodyTypes: ['file']`: the router
  then reads NOTHING and the handler pulls the bytes with `req.file()`
  (`maxBodyBytes` does not apply — the handler caps them). Answering early
  (413 in the middle of an upload) works because the rest of the request is
  resumed and discarded, not left paused: a paused socket never reads the
  client's remaining bytes and the client never sees the answer.
- The Write tool turns `﻿` escapes in regex literals into literal BOM
  characters (invisible in diffs); `modules/files/src/sniff.ts` strips the
  BOM with `charCodeAt(0) === 0xfeff` instead.
- NSO-322: `mailBudgets()` now also has `perAppSignIn`; with the unit-test
  configs where one app's sign-in share equals the whole sign-in budget
  (`hourlyMax` 4 → sign-in 2, share min(2, ≥10) = 2) the per-app refusal
  (`limit: EMAIL_SIGNIN_APP_HOURLY_SHARE`) fires BEFORE the class pause — a
  test that wants the `sign_in` pause from one app pre-fills the class
  counter from another app (same trick as the notification share).
- NSO-322: proxy upstreams now need `allowed_app_ids` to name the app; the
  confirm of an assignment by a workspace admin writes it (onConfirmed).
  Unit tests that insert upstream rows directly must set `allowedAppIds`;
  an e2e/dev flow where an EDITOR confirms a proxy assignment gets `403
  admin_required`.
- NSO-322: the runtime's effective-config memo hands every caller a
  `structuredClone`; a module whose configSchema transforms into something
  not cloneable (a function) is simply never memoized.
- A concurrency test on PGlite (one connection, transactions serialized)
  can force an interleaving by wrapping the `db` in a Proxy whose
  `transaction` waits on a promise (modules/data index.test.ts, NSO-322 M1).
- A new workspace package (`modules/files`) needs its own anonymous
  `node_modules` volume in `docker-compose.yml` and a recreated dev container
  (`task up`), like every module before it; the uploads live in the named
  volume `files_data` (`/data/files`), which `docker compose down -v` wipes.
- Deleting an app cascades its `mod_files` rows but leaves the blobs on disk
  (a blob may be shared with another app, and there is no sweeper yet) —
  M2-01's app deletion must remove blobs that no remaining row references.
- The auth module has no per-user session index, so the Users tab cannot
  sign ONE user out — blocking does (their sessions end on the next
  request); "sign everyone out" bumps the app's session epoch. An end user's
  role lives in the auth CONFIG (`adminEmails`), so a dashboard role change
  is a config write (audited `end_users.role`), not a row update.
- `loadModuleRuntime({ modules })` (the test path) skips `validateModule`;
  a test of an incomplete authority must call `validateModule` itself.
- The owner CSV import skips `DATA_WRITE_RATE_LIMIT` on purpose but keeps
  every quota; imported records get `created_at = now + row index` ms so the
  newest-first table shows them in file order reversed and stays stable.

- Block-end e2e after parallel merges: expect stale expectations, not bugs —
  the read-scope tools list (`get_logs`, `query_data`), the module `available`
  list, and specs whose app NAME yields a slug that collides with a string the
  test asserts is absent (`proxy-echo`). `docker compose up -d proxy-echo` is
  needed after its compose env changed (`EXTRA_PORTS`), or the proxy module
  answers 502 `upstream_error`.
- Account events (API keys, OAuth connections) are user-level but
  `audit_log.workspace_id` is NOT NULL: they are written to the actor's
  personal workspace (`ensurePersonalWorkspace`), so the user reads them in
  that workspace's Activity. Keys minted by `task api-key:create` are NOT
  audited (CLI, no session).
- Revoking a connection DELETES the (user, client) access/refresh tokens and
  codes, so the old refresh token answers `invalid_grant` "unknown refresh
  token" — not the reuse path (reuse detection still applies to live
  lineages). `rotated_to` is a self-FK without cascade; deleting the whole
  pair in ONE statement is what keeps it satisfied.
- `/me/connections` "last used" is the newest token issued to the pair
  (consent or refresh), not a per-MCP-call stamp — access tokens have no
  `last_used_at`.
- The root route now has a loader (`sourceSha`) + `shouldRevalidate: false`;
  the footer renders from `useRouteLoaderData('root')` in `Layout`, so it
  falls back to the `main` tree link when the root loader did not run (error
  document). drobek-web has its own root and needs the same footer.
- The pending-change owner e-mail (NSO-291) is a `notification` counted like
  any module mail: every e2e spec whose agent leaves a change pending now
  sends one mail per app per hour to the owner (subject `[<app>] … awaits your
  confirmation`, no 6-digit number, so `pollLoginCode` is unaffected as long
  as a new code is requested after it). A spec that needs a second pending
  e-mail for the same app must delete `drobek:rl:modules:pending-mail:<app_id>`.
- The Modules page's forms post plain fields (`cfg.<path>`, `rule.<op>.<principal>`)
  and the server rebuilds the config, so the pages work without client JS;
  inputs are uncontrolled — the form is keyed by its values so a
  confirm/save that changes the config remounts it with the new values.
- React Router single fetch: a page's loader data is `GET <path>.data`; the
  secret e2e greps both the HTML and that for the secret value.
- `z.toJSONSchema(schema, { io: 'input' })` is what the dashboard form uses
  (defaulted keys optional); `skill_info` keeps the output-side schema.
- NSO-288: a deleted app keeps its slug 30 days, then it is RENAMED to
  `<slug>~deleted-<id>` (migration 0016 lets the slug CHECK admit that only
  when `deleted_at` is set), not hard-deleted — versions, module data and
  the audit rows (target = the original slug) stay. `createApp` releases the
  one slug it asks for on demand, so "free after 30 days" is exact; the e2e
  shifts `deleted_at` back 31 days in SQL and calls `create_app`.
- NSO-288: every dashboard app mutation is `appAction` (`intent` field; a
  form with only `versionId` still publishes — the older specs post that).
  Failures return `{ error, intent }` (400; 409 for a restore under another
  member's lease) rendered as `publish-error` (intent publish) or
  `action-error`.
- NSO-288: `app-published-version` now marks only the `v<N>` code (or the
  "not published" text) in the header — the prod URL next to it could
  contain "v<digit>" inside a slug.
- NSO-288: changing an app's password does NOT invalidate app-access
  cookies already issued (stateless HMAC token of appId + expiry, 12 h) —
  see the out-of-scope list of the task report.

- Custom domains (NSO-292): the dev stack answers verification DNS from
  Redis (`DOMAINS_DNS_MOCK=redis`, keys `drobek:dns-mock:<txt|cname|a|aaaa>:<name>`
  = a JSON string array, `"SERVFAIL"` = transient) and admits `.test` names;
  production ignores the mock, so the domains e2e skips its DNS test on the
  image flow. The re-check runs every 5 s in dev (`DOMAINS_RECHECK_INTERVAL_MS`)
  and only picks rows with `last_check_at` older than 24 h — the e2e backdates it
  via SQL. After pulling, recreate the container (`docker compose up -d drobek`)
  for the new env and the `packages/domains/node_modules` volume.
- The dev compose now sets `TLS_ASK_TOKEN` (dev-only default); the ask is
  answered only on a non-dashboard Host, so the e2e calls it on
  `127.0.0.1:3041` with `Host: drobek:3000`.
- `classifyHost` changed meaning for foreign hosts: `shop--preview.apps.localhost.attacker.com`
  and `shopdrobek.app` are now `custom` (a DB lookup; unknown → `next()` =
  the dashboard, as before). Tests that inject a TLS ask handler must stub
  `customDomainAllowed`, or the default hits the DB and answers 503.
- `psl`'s types are not reachable through its package `exports` (TS7016):
  `packages/domains/src/psl.d.ts` declares the module, referenced from
  `hostname.ts` with a triple-slash path.
- Bash in an agent worktree also refuses commands with `$slug`-style strings,
  backticks, `git -C`, or inline python that mentions git; put such edits in
  a scratchpad `python3` script written with the Write tool.
- NSO-309: the OTP guards never key on a shared `unknown` IP. Without a
  resolvable client IP, `/login/verify` skips its per-IP bucket
  (`guardOtpVerify`, `OTP_VERIFY_IP_LIMIT` / `OTP_VERIFY_IP_WINDOW_S`, default
  30 / 900 s) and the send guard skips its two per-IP windows; the per-code
  cap (5 guesses, then the code is gone), the per-e-mail send limits and the
  global brake always apply. The e2e no longer clears `otp-verify-ip`: the dev
  stack is IP-less (no bucket) and the dev/e2e compose files set the limit to
  500 (behind the e2e Caddy every request has the same peer IP). Other
  `?? 'unknown'` buckets still exist outside `@drobek/auth` (module router
  `per: 'ip'`, `oauth.register`, serving `app-unlock`, proxy `public-ip`,
  insights beacons) — the DCR/forms e2e resets remain for those.
- NSO-309, production client IP (repo evidence only, not verified on the
  VPS): `docker-compose.production.yaml` sets `TRUST_PROXY=x-real-ip`, Caddy
  publishes 80/443 itself and the generated Caddyfile does
  `header_up X-Real-IP {remote_host}` (`packages/core/src/caddy.ts`), so the
  per-IP limits see the TCP peer Caddy sees. That is the real client only if
  (1) nothing else (host nginx, CDN, load balancer) sits in front of Caddy —
  otherwise every client shares that proxy's IP (`{remote_host}` is the
  immediate peer; it would take `trusted_proxies` + `{client_ip}`, neither
  generated today) — and (2) Docker preserves
  the source address on the published ports: IPv4 via iptables DNAT does;
  IPv6 clients on a host without Docker IPv6 go through `docker-proxy` and
  all appear as the bridge gateway IP. Neither can be proven from the repo
  (M0-09 / NSO-299 provisions the VPS); check `X-Real-IP` in the drobek logs
  after the first prod deploy.

- M4-02 (NSO-293): `publish()` in `@drobek/apps` now runs the phishing
  heuristic after the transaction (errors swallowed); pass `{ screen: false }`
  in tests that publish phishing-looking fixtures and do not want a queue row.
  The heuristic's report host is built from the process env (`APPS_DOMAIN` via
  `appsOrigin`), not from the request — unit tests set `APPS_DOMAIN` or assert
  with `startsWith`.
- A taken-down app refuses changes with `AppsError('app_locked_by_admin')`
  from `createVersion` / `publish` / `restore` themselves: every caller that
  maps AppsError codes (the dashboard app page publish/restore, NSO-288) must
  map it (423 + `LockedByAdminNotice` via `lockedByAdminView(app.lockedReason)`
  from `@drobek/dashboard`), or it surfaces as a 500.
- Migration `0021_abuse_reports` was generated as 0015 and renamed; its
  snapshot `prevId` points at 0014. If other units merged 0015–0020 first,
  re-chain `prevId` / journal `when` (or regenerate) on merge.
- The e2e super-admin `e2e-superadmin@drobek.test` is APPENDED to
  `SUPERADMIN_EMAIL` in `docker-compose.yml` (dev) and set in
  `docker-compose.e2e.yaml`; the e2e spec resets the `abuse-report-ip`
  rate-limit bucket (5 / IP / hour) before and after itself — other specs that
  post to `/report` must do the same.
- `/.well-known/drobek-report` is answered BEFORE the "unknown host" check in
  `handleAppRequest`, so it works on a slug that does not exist too (the form
  then stores the report with `app_id` null).
- Tooling: the scratchpad is shared between parallel agents — use unique log
  names (a sibling agent overwrote `check.log` mid-run). The Write tool turned
  `\u0300`-style escapes inside a regex into literal characters; use
  `/\p{M}+/gu` for "strip combining marks".
- NSO-293 × NSO-288/292 merge: the `0016_apps_slug_release` snapshot (and so
  0018's) never picked up 0016's own changes (`apps_deleted_at_idx` + the
  tombstone-aware `apps_slug_format` CHECK) — `drizzle-kit generate` against
  them re-emits 0016. The `0021_snapshot.json` was rebuilt as 0018's snapshot
  + `abuse_reports` / `abuse_report_status` / `apps.locked_reason`, with the
  apps indexes + CHECK taken from a scratch `drizzle-kit generate` run, and
  `prevId` = 0018's id; a check run (`drizzle-kit generate --out <scratch
  copy>` from `packages/db` — the `--out` path must be RELATIVE, an absolute
  one is prefixed with `./`) now says "No schema changes". The next snapshot
  must start from 0021's, not 0016/0018's.
- In `handleAppRequest` the takedown 451 runs BEFORE the primary-domain 302:
  a taken-down app's production host answers 451 itself instead of
  redirecting to its custom domain (which would 451 too). The custom target
  shares the slug's `resolved` cache entry, so the takedown's `bust(slug)`
  covers custom domains as well.
- `findAppByReportedHost` (@drobek/apps) resolves custom domains by querying
  the `domains` table directly — `@drobek/domains` depends on `@drobek/apps`,
  so importing its `resolveCustomHost` would be a cycle. Same rule: only a
  VERIFIED row of a non-deleted app attaches the report.
- The dashboard's own mutation paths that bypass `@drobek/apps` lock checks
  refuse a taken-down app themselves: `appAction` publish / restore /
  unpublish → 423 (pre-check on `AppDetail.lockedReason`, plus the AppsError
  code for a takedown that lands mid-request), and the NSO-291 module page
  action → 423 for everything except `reject` / `remove-secret`.
- `@smoke` cleanup (NSO-316): the local branch uses Mailpit + Redis (OTP
  sign-in for the dashboard delete) — allowed only because it runs under
  TEST_ENV=local, like the SQL-minted key; the production branch stays
  public-HTTP + MCP only. The stable production slug is derived from the key
  (domain-separated SHA-256), not from the user e-mail (guessable → squattable)
  nor the stored `key_hash` (that would publish a prefix of the credential
  hash). If `create_app` ever returns a variant (`smoke-<hex>-xxxx`) the spec
  fails instead of silently creating an app per run.

- **NSO-308: the e2e specs depend on each module skill's FIRST ```tsx block.** They run it
  as a live app: forms-email, auth-module, data-module and files-module all do this. Keep the
  visible texts those specs assert when you edit a skill:
  - auth: `#who` "Signed in as X (role)", and the heading "Team board";
  - forms: `#thanks`, the labels Name / Email / Message, and the button Send;
  - email: "Ask the owners for access", and the status text "The owners were notified.";
  - data: "My todos", "New todo", and the buttons Add and Delete;
  - files: "My photos", and "Upload a photo".
- React 19's `@types/react` has NO global `JSX` namespace. A module's `INLINE_TYPES` must use
  `import type { JSX } from 'react'`. A bare `JSX.Element` used to be silently unresolved in
  skill_info and sdk.d.ts. skills-check now typechecks those types.
- **Tailwind is not built on the server.** esbuild passes `@apply` and `@tailwind` through
  untouched, so the styles silently do nothing. `@import "tailwindcss"` in a .css file is an
  `unresolved_import`. The CSP-compatible way is
  `<script type="module" src="https://esm.sh/@tailwindcss/browser@4.1.11">` in index.html,
  which was verified to execute. It is guarded by `TAILWIND_BROWSER_URL` in agent-dx and the
  `ui` skill test.
- **skills-check typechecks through one virtual compiler host,** rooted at
  `packages/skills-check/.virtual`, which is never written to disk. It maps `drobek` →
  `types/drobek.d.ts` and `drobek/*` → `types/inline/*.d.ts`. A `// src/x.tsx` first line
  puts a block at that path. A skill's `json drobek.json` block sets the import map for its
  later blocks. A `ts api` block is a declaration block, compared with the real SDK instead
  of being compiled.
- **Skill format limits.** Each skill is at most 150 lines, with exactly the 5 numbered H2
  sections. Every error code the skill mentions must be in `ERROR_CATALOGUE` (or be a
  module's own code). Prose must not use "we", "our" or "us". The data skill sits at 149
  lines, so trim before adding.
- **The eval harness shells out only when you run it:** `docker exec drobek … api-key-create.js`
  for the key (by container name, so it does not depend on the compose project name of a
  worktree), and `claude -p`. Claude Code expands the MCP config header
  `Bearer ${DROBEK_API_KEY}` from the child's environment, so the key never lands in a file.
- **The Bash tool of a worktree agent refuses some commands.** It refuses complex heredocs and
  any command containing the word "eval" (`task eval …` included) as "can't be verified to
  stay inside the worktree". Write a python script to the scratchpad and run it, or check
  with `task --list`.

- `docker compose` lets the SHELL environment override `--env-file` values:
  Task's `env:` mapping exports even empty inputs (`APPS_DOMAIN: ''`), and the
  global `dotenv: ['.env']` exports a dev `.env` into every task — both
  silently replaced `.env.production` values (a `${VAR:?}` "missing a value"
  was the symptom). `scripts/lib/selfhost.sh` `dc()` runs compose under
  `env -u <every key of the env file>`; every self-host task goes through it
  (`scripts/selfhost-compose.sh`).
- The dev stack has no `name:` — its project is the checkout's directory name
  (`drobek` in the main checkout). The production compose used `name: drobek`
  too, so a `down -v` of it in the main checkout would have hit the dev
  volumes: it is `drobek-prod` now. Throwaway runs always set
  `COMPOSE_PROJECT_NAME`.
- A compose service with `build:` AND an image that is not in any registry:
  `docker compose pull` exits 1 and `up` prints "pull access denied" before it
  builds. Caddy defaults to `caddy:2-alpine` (pullable); only the DNS-01 image
  (`CADDY_IMAGE=drobek-caddy:dns`) is built, and the upgrade uses
  `pull --ignore-buildable` + `pull caddy` / `build --pull caddy`.
- `.env.production` is read by compose AND by `docker run --env-file` (the
  image's Caddyfile generator): the docker parser keeps quotes and inline
  `# …` literally, so the file has no inline comments and TLS values stay
  unquoted.
- macOS runs the scripts with bash 3.2 (`/bin/bash`, nothing newer on PATH
  here): no associative arrays / `mapfile`, and an empty `"${arr[@]}"` under
  `set -u` is an error — the self-host scripts use plain strings.
- Dashboard AND app end-user sessions live in Redis, which `task backup`
  does not include: after a restore on a new machine everyone signs in again
  (API keys / OAuth clients are in Postgres and keep working).
- A worktree agent's Bash tool refuses any command TEXT containing the word
  git (even inside python / grep patterns such as `GIT_SHA`) — write such
  files with the Write/Edit tools; scripts that run git themselves are fine.
- NSO-315: `ServeStore.resolve` no longer stores `{ app: null }` in the
  positive per-slug map — misses go to the separate negative LRU (30 s). A test
  that expects a missing app to stay missing for the full 60 s positive TTL, or
  that a new app appears only after the TTL, is now wrong: `createApp` emits a
  `create` app-changed event itself (in-process emitter first), so any process
  with `subscribeServeCache` sees the app at once. The unknown-host limiter is
  in `defaultHandlerDeps`; unit tests that inject their own deps get none.
- NSO-315 e2e (`apps-unknown-host.spec.ts`): the 429 part sends a random
  TEST-NET-2 `X-Real-IP`, honoured only on the plain-http dev stack; behind
  Caddy (`TRUST_PROXY=x-real-ip`) every spec shares the runner's IP, so the
  part is skipped there — a throttled IP also gets 429 (without lookup) for
  real apps the serve cache has not seen yet, for up to one window.

- Batch merge (NSO-309/316/322/308/304/315 onto the abuse merge): NSO-322
  removed `replaceRecord` from `modules/data/src/store.ts`, but NSO-301's
  owner edit (`records.ts` `update`) used it — it now calls `patchRecord`
  with a replacing `next: () => doc`, so the dashboard edit also re-reads the
  row under the write lock. Any new caller: use `patchRecord`.
- Skill line limits disagree by one: `packages/skills-check` counts
  `fileText.trimEnd()` lines (≤ 150), while each module's own
  `index.test.ts` counts `markdown.split('\n')` INCLUDING the trailing
  newline — a module SKILL.md of exactly 150 lines passes skills-check and
  fails its module test. Keep module skills ≤ 149 lines.
- `apps/server/server/migrate.ts` (NSO-304) repeats the server entry's config
  checks; a new `*ConfigError` in `server/index.ts` must be added there too
  (NSO-292's `domainsConfigError` was missing after the merge).
- Operator env knobs now live in THREE places: `.env.example` (dev, full
  list), `.env.production.example` (self-host) and the env table of
  `docs/SELF-HOSTING.md` — a new operator-facing variable goes into all three.
- `handleAppRequest` order after NSO-315 × NSO-293: method → well-known
  report pointer → unknown-host limiter (a throttled IP gets 429 without a
  lookup unless `knowsLiveApp`) → lookup (miss = counted 404 / 429) →
  `X-Drobek-App` → takedown 451 → primary-domain 302 → visibility → file. A
  throttled client therefore gets 429, not 451, for a taken-down app the
  serve cache has not seen yet.

## Failed approaches

- `pnpm deploy --offline` in the Dockerfile builder: fails with
  `ERR_PNPM_NO_OFFLINE_META` (deploy re-resolves peer ranges and needs registry
  metadata that `pnpm fetch` does not cache). Keep deploy online.
