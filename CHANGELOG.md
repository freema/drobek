# Changelog — drobek (core)

## Unreleased (`next`)

### Changed
- **One dashboard layout** — every workspace and app page has a breadcrumb (`Workspaces › <workspace> › <app> › <section>`, every part a link except the last) in place of the "← back" links, and every page has the same width. The workspace pages share a header with the workspace tabs (Apps, Members, Activity, Upstreams). The app header and its tabs are now on every app page, including Modules and the module detail page. Inputs, selects, buttons and link-buttons share one height, border and radius, so the Activity filters (with Clear and Export CSV) and the app-list filters line up on one row. Wide tables scroll inside their box on a phone instead of scrolling the page.
- **App-list thumbnails** — a public, live app with a published or compiled version shows a small, non-interactive preview of its page. It is a sandboxed, lazy, `inert` iframe (`credentialless` where the browser supports it) of the app's own host, which is never the dashboard origin. Password-protected, taken-down, inactive and never-compiled apps show a placeholder. To make this possible an app's `frame-ancestors` now always includes the dashboard origin (`PUBLIC_APP_URL`), next to the owner's embedding setting. See `docs/SECURITY.md`.
- **Footer** — it now reads `drobek <version> · <sha> · Source (AGPL-3.0) · ★ <stars>`. The star count is read server-side from api.github.com (unauthenticated, 3 s timeout) and kept in memory for an hour. A page never waits for it: a failure just omits the stars. `DASHBOARD_GITHUB_STARS=off` turns the lookup off.
- **Upstreams page** — a short introduction explains what an upstream is, how an app gets access, and that the secret is entered only there: neither the app nor the agent ever sees it.

### Fixed
- **App slugs keep accented letters** — `create_app` derived the slug by dropping every non-ASCII letter, so "Podzimní obloha" became `podzimn-obloha`. Accents are now transliterated (`podzimni-obloha`, ß → ss, ł → l, ø → o). Existing slugs do not change.

## v0.1.3 — 2026-09-24

### Added
- `api-key-create --create-user` (`task api-key:create … CREATE_USER=1`) creates the user when the e-mail never signed in, so an operator can give a smoke test or a headless agent its own service identity without a mailbox. Without the flag the CLI still refuses an unknown e-mail. `docs/SELF-HOSTING.md` → Upgrades and rollback shows the live-server check: such a key plus `task e2e:smoke`, the whole MCP loop over public HTTP.

## v0.1.2 — 2026-09-24

The first published image. It carries the v0.1.1 fix (v0.1.1 was tagged, its CI run was cancelled in favour of this release).

### Added
- `LANDING_URL` — an operator with their own website sends the dashboard's `/` there with a 301 instead of the built-in landing page (drobek.app → www.drobek.app), so the noindex dashboard host never competes with the website in search.

## v0.1.1 — 2026-09-24

### Fixed
- **Sign-in and every dashboard form behind a TLS proxy** — React Router 7.18 (the NSO-333 dependency update) refuses an action whose `Origin` differs from the origin of `request.url`; behind Caddy drobek builds `http://…` while browsers send `Origin: https://…`, so every POST answered 400. The host of `PUBLIC_APP_URL` is now an allowed action origin. v0.1.0 was tagged but never published as an image (its CI e2e run caught this).

## v0.1.0 — 2026-09-24

### Release summary

First release of drobek as a cloud workspace for agent-built web apps. An agent connects over MCP, writes files, drobek compiles them in-process with esbuild, keeps every write as a version with a preview host and publishes on request. App backends are TypeScript platform modules; a dashboard covers secrets, confirmations, domains, data and users. One Node process, one image (`ghcr.io/freema/drobek`), Postgres + Redis, Caddy for TLS.

This release replaces the earlier static-bundle upload product entirely (see the ⚠️ Breaking sections in `CHANGELOG.md`: NSO-281, 282, 283, 285).

#### Highlights
- **Agent loop over MCP** (Streamable HTTP): `list_apps`, `create_app`, `get_app`, `read_file`, `write_files` (esbuild diagnostics back), `publish`, `restore_version`, `get_logs`, `query_data`, `configure_module`, `skill_info`. OAuth 2.1 (user-bound tokens, scopes read/write/publish, CIMD + DCR) and `drk_` API keys.
- **Apps on their own origin** — `<slug>.<APPS_DOMAIN>` (production), `<slug>--preview` and `<slug>--v<N>` hosts, `__Host-` cookies, CSP, password gate, on-demand TLS (`ask` endpoint) with Caddy.
- **Platform modules** (`@drobek/modules` contract, `defineModule`, owner confirmations): built-in `auth` (end-user sign-in), `data`, `forms`, `email`, `files`, `proxy`; external modules via `DROBEK_MODULES` (example: `drobek-module-hello`).
- **Dashboard**: app page (publish / restore / unpublish, versions, zip download), Modules tab with confirmations, owner tabs (Data with CSV import/export, Forms, Users, Uploads, Logs), custom domains with DNS verification and re-check, account area (API keys, OAuth connections, Activity), abuse queue for super-admins.
- **Agent DX**: `@drobek/agent-dx` briefing, tool manifest, limits and error catalogue, `llms.txt`; the `drobek` plugin and skills; directory listing kit.
- **Self-hosting**: production compose, `task selfhost:init`, backup/restore, release image tags, `docs/SELF-HOSTING.md` env reference (kept in sync by `pnpm doc-lint`).
- **Plan limits** (`APPS_MAX_PER_WORKSPACE`, `DOMAINS_MAX_PER_APP`) with an optional HMAC-signed limits provider (`LIMITS_PROVIDER_URL`).

#### Security (M1 review + follow-ups)
- SVG sniffer ReDoS and proxy escape fixed; proxy header allow-list, decoding to a fixed point (double-encoded traversal refused), HEAD, IPv6 private ranges, concurrency caps.
- A failed PKCE exchange burns the authorization code; a replayed code revokes its tokens.
- Per-IP rate limits never share an `unknown` bucket; per-principal write limits in `data` and `files`; per-app password-gate cap.
- MCP `read_file`, `query_data`, `get_logs` answer only inside the untrusted envelope (no `structuredContent`); `_owner` hidden from anonymous callers; removed data collections are purged (with confirmation and audit), never orphaned.
- Beacon URLs stored as origin + path only; e-mail guard pause vs OTP quota fixed; `signInAddress` reserved for the auth module.
- DB errors are read and logged through one helper (`@drobek/db`: `pgErrorCode`, `isUniqueViolation`, `dbErrorForLog`) — no bound query parameters in logs; drizzle-orm 0.45.3, nodemailer 10.
- `docs/SECURITY.md` threat table; `/.well-known/drobek-report` and `/report` abuse flow with takedown (451).

#### Operator notes (new / changed env)
- New: `LOGS_PRUNE_INTERVAL_MS` (3600000), `DATA_WRITES_PER_PRINCIPAL_PER_MIN` (60), `FILES_UPLOADS_PER_PRINCIPAL_PER_MIN` (20), `EMAIL_WORKSPACE_HOURLY_SHARE` (50; single-workspace servers may set 100), `APPS_MAX_PER_WORKSPACE` (50), `DOMAINS_MAX_PER_APP` (3), `LIMITS_PROVIDER_URL` (+ secret), `TRUST_PROXY`.
- Changed: `BEACON_RETENTION_DAYS` default 14 → 30 (errors also capped at the newest 500 per app); logs/stats are pruned by a periodic job instead of on read.
- Migrations run on start (`__drizzle_migrations_core` + one journal per module). Back up before upgrading: `task backup`.
- Full list and defaults: `docs/SELF-HOSTING.md` → Environment reference.

#### Verification
`task check` (doc-lint, build, typecheck, lint, knip, ~1 700 unit tests), Playwright e2e against the dev stack and against the production image behind Caddy (`task e2e:image`), an agent eval over three reference apps, and Sonnet black-box passes per milestone block.

The sections below are the detailed change log of this release, newest first.

### drizzle-orm 0.45; DB errors read and logged through one helper (NSO-333)

- `@drobek/db` exports `pgErrorCode(err)` (the SQLSTATE wherever the driver
  or drizzle put it — `err.code`, or the `cause` of a `DrizzleQueryError`),
  `isUniqueViolation(err)` and `dbErrorForLog(err, { stack? })`: a DB error
  anywhere in the `cause` chain becomes `db error <code> (constraint …,
  table …)` — never its message, `detail`, SQL or bound parameters (a
  Postgres message alone can quote the input, `invalid input syntax for type
  integer: "<value>"`); any other error keeps its message, or its stack with
  `stack: true` (for a DB error: the summary plus the stack frames).
- The four local unique-violation checks (`@drobek/apps` slug,
  `@drobek/domains` hostname, `@drobek/tenancy` team slug + personal-workspace
  slug retry) use `isUniqueViolation`. Every log call that recorded a caught
  error's `message` / `stack` / `String(err)` or the error object — serving,
  domains re-check, MCP tool failures, dashboard abuse mail + logs section,
  the module runtime (hooks, requests, e-mail, limits provider, mail guard),
  moderation, app-changed events, the forms / auth / proxy modules, the
  server's background jobs, migrate and the API-key CLI, `@drobek/auth`'s
  `serializeError` — goes through `dbErrorForLog`. The background-job log
  callbacks (`startBlobGc`, `startSlugRelease`, `startLogsPrune`,
  `startFilesSweep`, `startDomainRecheck`) now take the log-safe error text
  instead of the error.
- Guard: `packages/db/src/error-guard.test.ts` (runs in `task check`; the
  package now has unit tests) scans every package, module, example and the
  server and fails with `file:line rule` for a SQLSTATE literal or a
  `.cause.code` read outside `errors.ts`, and for a raw caught error in a log
  call. An exempt line carries `db-error-guard: allow` with its reason.
- Tests: a taken team slug returns `slug-taken` and a personal slug held by an
  unrelated workspace retries with the next suffix, through PGlite and the
  real constraint (`packages/tenancy/src/workspace-slug.server.test.ts`); a
  failed-query log line whose parameters contain an e-mail does not contain
  it (`packages/db/src/errors.test.ts`, `packages/auth/src/logger.server.test.ts`).
  No migration, no new env var.
- **`drizzle-orm` 0.41 → 0.45.3** in all 21 package.json and **`drizzle-kit`
  0.31.10 → 0.31.11** (`@drobek/db`). Since 0.44 every driver error is a
  `DrizzleQueryError` (class name only — its `name` stays `Error`) whose
  `code` is undefined and whose message is `Failed query: <sql>\nparams:
  <values>`; the helpers above read the `cause`, so behaviour is unchanged
  (`errors.test.ts` asserts the real wrapper shape on PGlite). The migrators
  are unchanged: both journals (`__drizzle_migrations_core`,
  `__drizzle_migrations_mod_<name>`) apply on PGlite (every DB-backed unit
  test) and through postgres-js (`runCoreMigrations` / `runJournalMigrations`
  against a Postgres wire server, idempotent on a second run);
  `drizzle-kit generate` over the existing core snapshots reports no schema
  changes and rewrites nothing. Fixes the high advisory GHSA-gpj5-g38j-94v9.
- Dashboard / OAuth routes: React Router's default `handleError` printed a
  loader or action error whole (`console.error(error)` — a failed query's SQL,
  parameters and Postgres `detail`); the server now installs
  `logRouteError` (`apps/server/server/route-errors.ts`), which logs it
  through `dbErrorForLog`.
- `pnpm audit --prod`: no high; 2 moderate (`qs` via `express` 4, out of scope).

### A failed PKCE exchange burns the authorization code (NSO-332)

- `/oauth/token` (`authorization_code`): the first exchange of a code now
  consumes it whether it succeeds or fails — a wrong `code_verifier`,
  `redirect_uri` or client, or an expired code answers `invalid_grant` and a
  later attempt with the right verifier gets `invalid_grant` too (RFC 6749
  §4.1.2, OAuth 2.1). Presenting an already-consumed code revokes the
  refresh-token lineage it was exchanged for and the grant's access tokens,
  with the refresh-reuse mechanism (`revokeLineage`). The link needs no
  column: the lineage's first refresh token takes the id `ac_<code id>`
  (`authCodeRefreshTokenId`; `issueAccessAndRefresh` accepts
  `refreshTokenId`, `consumeAuthCode` returns it). Unit tests in
  `codes.server.test.ts` (each failure shape, replay revocation) and the
  PGlite route test `routes/oauth.token.test.ts`; `mcp-oauth.spec.ts` checks
  the burn and the replay revocation. `docs/SECURITY.md` threat table row.
  No migration.

### Per-IP limits never share an `unknown` bucket (NSO-328)

- A request without a resolved client IP (no trusted `X-Real-IP` — a
  misconfigured proxy, a request that bypassed it, the plain-HTTP dev stack)
  no longer lands in one shared `…:unknown` bucket, which let a handful of
  such clients lock each other out. Its per-IP bucket is skipped; the
  per-code, per-address, per-app and per-user limits still apply.
- One implementation: `perIpLimitKey(ip, bucket)` in `@drobek/core` (the IP,
  or `null` = skip; one `rate_limit_no_client_ip` warning per bucket per
  process). It replaces the copies in the module router (`per: 'ip'`, and
  `per: 'principal'` for anonymous callers — the auth module's
  `AUTH_ATTEMPTS_PER_IP_15MIN`, forms' `FORMS_SUBMITS_PER_IP_HOUR`), DCR
  (`/oauth/register`), the app password gate, the proxy's `public-ip`
  limit, the error beacon and the abuse report form, and `@drobek/auth`'s
  OTP send and verify guards now use it too (their warning event is now
  `rate_limit_no_client_ip`). `@drobek/modules` re-exports it for modules.
- The password gate gains a per-app cap, `UNLOCK_APP_ATTEMPTS` (100 per
  15 min over all clients), next to the 10 per app + IP, so attempts without
  a client IP stay bounded. `createModuleTestContext().request` accepts
  `clientIp: null`.
- e2e: the specs that count a per-IP limit up to its 429 (hello wave, forms
  burst, DCR, abuse report) send their own `X-Real-IP` (`ownClientIpHeaders`)
  — on the dev stack a request without one has no bucket. The bucket resets
  stay for the Caddy flow (`task e2e:image`), where every request is the
  runner's one IP; the redundant reset before the first forms submit is gone.
  `docs/SECURITY.md` and `docs/SELF-HOSTING.md` describe the behaviour. No
  migration.

### Beacon, get_logs and e-mail guard: M1 review low findings (NSO-327)

- **Beacon bucket order**: `recordBeacon` checks the per-app+IP bucket
  BEFORE the per-app aggregate. A request the per-IP bucket refuses never
  reaches the app bucket, so one client can no longer spend the app's
  600/min and silence its error log; rotating IPs is still bounded by the
  aggregate.
- **Beacon URLs without query or fragment**: the SDK beacon reports the page
  as origin + path (`pageUrl`), and `sanitizeEvent` strips the query string,
  fragment and credentials again server-side — `?code=123456` was too short
  for the redaction.
- **`{ signInAddress }` is reserved for the sign-in provider**: only the
  module that owns end-user sessions (`endUsers`, the built-in `auth`) may
  send to it; any other module gets `403 forbidden`
  (`details.reason: sign_in_address_not_allowed`) and nothing is sent or
  counted — in the runtime and in `createModuleTestContext`
  (`assertSignInSender`).
- **The e-mail pause is a fixed window**: tripping a class pause also resets
  that class's hourly counter, so after `EMAIL_GLOBAL_PAUSE_MINUTES` (15, the
  existing env var) the class starts a fresh budget instead of pausing again
  until the old hour ends; `admit` refuses (uncounted) a message that raced
  past `assertOpen` during a pause. Per-app and per-workspace shares stay
  hourly. Sign-in codes still work while notifications are paused (NSO-320).
- **Auth charges OTP counters only after a send**: the auth module's
  `send-code` uses the new `@drobek/auth` `checkOtpRequest` (all layers,
  counters only read, the cooldown still claimed) and `chargeOtpRequest`
  after the code went out. Retries while sign-in mail is paused cost
  nothing, so the user is not rate-limited after the pause. The dashboard
  login keeps `guardOtpRequest`.
- **Periodic get_logs prune instead of prune-on-read**: `startLogsPrune`
  (`@drobek/insights`, started from `apps/server/server/jobs.ts` under the
  Redis lease) removes browser errors older than `BEACON_RETENTION_DAYS` or
  past the newest `BEACON_MAX_EVENTS_PER_APP` per app, and compiles and
  daily request / module-call stats older than 30 days, for every app. New
  env var `LOGS_PRUNE_INTERVAL_MS` (default 3600000) in `.env.example`,
  `.env.production.example` and the SELF-HOSTING env reference.
  `queryRequestLog` no longer deletes. Retention aligned to **30 days / 500
  errors per app**: `BEACON_RETENTION_DAYS` defaults to 30 (was 14), and the
  `get_logs` description, `docs/MODULES.md` and `skills/debug` say so.
- **`get_logs('requests')` flushes in one round trip**: the whole window (up
  to 31 days) is read in one Redis pipeline and written with at most one
  statement per table (was 2 × 31 serial flushes).
- Unit tests: beacon bucket order + IP rotation, SDK `pageUrl`, server URL
  stripping, `assertSignInSender` (runtime, test context), the fixed pause,
  `checkOtpRequest` / `chargeOtpRequest`, the auth retry-during-pause flow,
  the prune and the batched flush (Redis/SQL call counts). No migration.

### Data + files: per-user write limits, no orphan records, text-only untrusted MCP output (NSO-324)

- **Per-principal rate limits** before the per-app ones: one anonymous
  client on `create: public` could use up an app's whole write budget for
  every user. `DATA_WRITES_PER_PRINCIPAL_PER_MIN` (default 60) and
  `FILES_UPLOADS_PER_PRINCIPAL_PER_MIN` (default 20) count per signed-in end
  user, or per client IP for a visitor; a visitor without a resolvable IP
  gets no shared bucket (NSO-309), the per-app limits
  (`DATA_WRITE_RATE_LIMIT`, `FILES_UPLOAD_RATE_LIMIT`) still hold, and a
  refused write counts only against its own bucket. `429 rate_limited` with
  `details.limit` naming the limit that tripped. A small helper in each
  module (`principal-bucket.ts`), not the router. New env vars in
  `.env.example`, `.env.production.example` and the SELF-HOSTING env
  reference; skills and `docs/MODULES.md` updated.
- **Removing a collection no longer orphans its records.** Removing a
  collection that holds records is `confirmRequired` (the pending summary
  names the count); on confirmation `onConfirmed` purges them in the confirm
  transaction, audited `data.collection.purge` (collection + count). An empty
  collection is removed at once. `ConfirmedContext` gains `audit(action,
  meta)` (written in the confirm transaction, actor: the confirming user).
  Stragglers — rows of an undeclared collection — are listed on the Data tab
  as orphan records with a purge form (editor+, the owner types the name;
  `RecordsAuthority.orphans` / `purgeOrphan`, `BoundRecords.orphans` /
  `purgeOrphan` under the config lock, audited `data.collection.purge` with
  `orphan: true`).
- **`_owner` is hidden from visitors**: a caller who is not signed in gets
  records without `_owner` (list, get, create, update) — the opaque id linked
  one user's records for anyone reading a `public` collection. Signed-in
  users, `query_data` and the Data tab keep it; the SDK type is now
  `_owner?: string | null`.
- **`read_file`, `query_data`, `get_logs` answer text only**: no
  `structuredContent`, so a client that feeds `structuredContent` to the
  model can no longer skip the nonce envelope (wrapping the payload's
  strings could not cover it — the keys of a schemaless record are user
  input too). Every other tool keeps both. Tool descriptions (agent-dx),
  `docs/AGENT.md` and `docs/SECURITY.md` say so; the unit harness and the
  e2e `callTool` decode the envelope for assertions.
- The dashboard record delete was already audited (`data.record_delete`,
  NSO-301); it now has a unit test.
- Unit tests in `modules/data`, `modules/files`, `@drobek/modules`
  (runtime), `@drobek/mcp`, `@drobek/agent-dx` and the dashboard Data routes;
  e2e: `data-module.spec.ts`, `files-module.spec.ts`,
  `dashboard-app-data.spec.ts`. No migration.

### Apex landing describes the cloud workspace (NSO-331)

- The anonymous landing at `/` (`apps/server/app/routes/_index.tsx`) no
  longer talks about static micro-apps and dropping a folder. It describes
  the current product in a neutral voice: an agent connected over MCP, the
  write → compile (esbuild diagnostics) → instant preview → publish loop,
  the built-in platform modules (auth, data, forms, email, files, proxy), the
  dashboard (write-only secrets, confirmations, domains, data, users) and the
  AGPL-3.0 self-hostable instance. It links sign-in, `/build-with-your-agent`,
  `docs/AGENT.md` (`AGENT_GUIDE_URL`), `/llms.txt` and the GitHub repository
  (`SOURCE_REPO_URL`, now re-exported from `@drobek/dashboard/footer`); the
  `/healthz` and `/api/version` links stay. Unit test `_index.test.tsx`; the
  `index-console` e2e spec asserts the new copy. No migration.

### Plan limits: apps per workspace, custom domains per app (NSO-329)

- **`APPS_MAX_PER_WORKSPACE`** (default 50): live apps one workspace may
  hold. `create_app` beyond it answers `limit_exceeded` with
  `limit: APPS_MAX_PER_WORKSPACE` and `value`; soft-deleted apps do not
  count. Enforced in `@drobek/apps` `createApp` (the one create path —
  creates in a workspace are serialized on its row), which takes the
  workspace's effective value as `maxApps`.
- **`DOMAINS_MAX_PER_APP`** is now per workspace too, and `0` is valid
  (custom domains off): the Domains tab says why and hides the add form,
  every add answers `limit_exceeded` (`value: 0`). The startup check accepts
  0; `addDomain` takes the workspace's value as `opts.maxPerApp`.
- Both are **core limits** (`CORE_LIMITS`, exported from `@drobek/modules`)
  in the limits catalogue, so `LIMITS_PROVIDER_URL` can set them per
  workspace (plans); a module may not declare either name.
  `ModuleRuntime.workspaceLimits(workspaceId)` returns a workspace's
  effective limits. `docs/MODULES.md` lists them (a unit test keeps that
  table in sync with `CORE_LIMITS`), llms-full.txt's limits and the
  `limit_exceeded` catalogue entry name them. New env var in `.env.example`,
  `.env.production.example` and the SELF-HOSTING env reference. e2e:
  `plan-limits.spec.ts` (@local, fills a workspace to the default 50). No
  migration.

### nodemailer 10, drizzle-orm 0.45 evaluated and deferred (NSO-330)

- **`nodemailer` 6.10 → 10.0.10** (`@drobek/email`, and `apps/server`, which
  keeps it as a direct dependency for the SSR bundle's `import("nodemailer")`).
  7.x was not enough: of the three high advisories, only the recursive
  address-parser DoS (GHSA-rcmh-qjqh-p98v) is fixed in 7.0.11; the quadratic
  address-list parsing (GHSA-2x7j-588g-ccc2, fixed in 9.1.0) and the
  message-level `raw` file access / SSRF (GHSA-p6gq-j5cr-w38f, fixed in
  9.0.1) need 9.x, and the moderates (envelope/EHLO CRLF injection,
  recipient-domain bypasses, `resolveContent` sandbox bypass) go up to 9.1.1.
  10.x additionally makes the remaining address-parser paths linear
  (10.0.5 / 10.0.6 / 10.0.9) and ships its own TypeScript declarations, so
  `@types/nodemailer` (which stops at 8.x) is removed. The breaking changes
  of 7–10 (SES SDK v2, `NoAuth` → `ENOAUTH`, TLS verification for remote
  content fetches, Node ≥ 20) touch nothing drobek uses. The SMTP transport
  is unchanged: `SMTP_SECURE=1` implicit TLS, otherwise STARTTLS on
  `SMTP_PORT` (587), auth only when both `SMTP_USER` and `SMTP_PASS` are set;
  the option mapping is now the tested `smtpTransportOptions()` and the
  message the tested `messageFor()` (address objects for From / Reply-To,
  rendered through nodemailer's stream transport in the unit test).
- The default e-mail footer (`renderEmailLayout`) says "a cloud workspace for
  agent-built web apps" instead of the retired static-micro-app tagline.
- **`drizzle-orm` stays on 0.41** (evaluated, not upgraded). The bump to
  0.45.3 builds, typechecks and passes every unit test, and the migrators
  (`__drizzle_migrations_core`, `__drizzle_migrations_mod_<name>`, PGlite +
  postgres-js), `pgTable` typings and relations need no change — but 0.44
  wraps every driver error in `DrizzleQueryError`, which changes runtime
  behaviour the tests do not cover: (1) `err.code` is undefined on the
  wrapper (the Postgres code moves to `err.cause.code`), so the unique-
  violation checks in `packages/tenancy/src/team-workspace.server.ts` and
  `personal-workspace.server.ts` stop matching — a taken team slug would be
  a 500 instead of `slug-taken` and the personal-workspace slug retry loop
  would abort (`packages/apps` and `packages/domains` already check
  `cause`); (2) the wrapper's message is `Failed query: <sql>\nparams:
  <values>`, so every log line that records `err.message` / `err.stack` of a
  failed query (about 25 sites, e.g. `modules/forms` notification failures
  and `modules/auth` sign-in mail failures, which land in the app log that
  `get_logs` returns to the agent, and `@drobek/auth`'s logger) would start
  carrying bound values such as end-user e-mail addresses and token hashes.
  Upgrading needs a shared DB-error helper (unwrap `cause` for codes, keep
  params out of logs) applied across packages that other work is changing
  now. Remaining high: GHSA-gpj5-g38j-94v9 (identifier escaping in
  `sql.identifier()` / `.as()`) — not reachable, drobek never passes runtime
  input to either; the only `sql.raw` calls (`modules/data` store) take
  fixed literals.
- `pnpm audit --prod` after this change: 1 high (`drizzle-orm`, above),
  2 moderate (`qs` 6.15 through `express` 4). No migration, no new env var.

### files + serving: M1 security review, low findings (NSO-325)

- **No drain after an early answer.** An app-host response sent before the
  request body fully arrived (a `413` in the middle of an upload, a `401`
  before a route read anything, an oversized beacon) now carries
  `Connection: close`; once it is flushed the socket is half-closed, what the
  client still sends is discarded for 2 s (so its kernel does not drop the
  answer on a reset) and the socket is destroyed. Before, keep-alive read the
  whole rest of the upload, for up to the server's 300 s `requestTimeout`.
  New `APPS_MODULE_BODY_TIMEOUT_MS` (120000): a `/__drobek/*` request body
  that does not arrive in time gets `408 request_timeout`.
- **Files sweep** (`startFilesSweep` in `drobek-module-files`, started by the
  server's background jobs when `files` is active, Redis lease): removes the
  uploads of apps deleted `FILES_SWEEP_RETENTION_MS` (24 h) ago, stale
  `tmp/*.part` files and old blobs that no `mod_files` row of any app
  references (per-sha256 advisory lock + a fresh count, like a delete);
  every `FILES_SWEEP_INTERVAL_MS` (1 h).
- **Downloads** open the blob before any header: a file deleted during the
  download still streams in full, one already gone is a clean `404` instead
  of a connection reset.
- **`Content-Security-Policy: sandbox`** on every served file type except
  PDF. The apps host now keeps a module's CSP as a second policy after the
  app CSP (`<app csp>, sandbox`) instead of overwriting it — a module can
  only tighten the app's policy.
- **Public files** are `public, max-age=300, must-revalidate` (was
  `max-age=31536000, immutable`): the URL names the file id, not its
  content, so a delete or a stricter `read` rule reaches shared caches within
  5 minutes. `modules/files/SKILL.md`, `docs/MODULES.md`, `docs/SECURITY.md`
  and the env reference updated. No migration.

### Proxy hardening — M1 review low findings (NSO-326)

- **Response headers are an allow-list** (`@drobek/proxy` `filterResponseHeaders`):
  `Content-Type`, `Content-Language`, `Content-Range`, `Accept-Ranges`,
  caching (`Cache-Control` — then `no-store` —, `ETag`, `Last-Modified`,
  `Expires`, `Pragma`, `Vary`, `Date`, `Age`), `Retry-After`, request ids
  (`X-Request-Id`, `X-Correlation-Id`, `X-Trace-Id`, `Request-Id`,
  `X-Amzn-RequestId`), rate-limit hints (`X-RateLimit-*`, `RateLimit-*`),
  `Content-Disposition` unless the answer is HTML, and `Location` only as a
  relative reference. `Clear-Site-Data`, `Refresh`, `Link`,
  `Strict-Transport-Security`, `Service-Worker-Allowed`, an absolute
  `Location` (it revealed the upstream's base URL) and everything else no
  longer reach the app origin.
- **Encoded bodies are decoded**: an upstream that answers `gzip`, `deflate`
  (zlib or raw) or `br` despite `Accept-Encoding: identity` is decoded, and
  the DECODED size must fit `PROXY_MAX_RESPONSE_BYTES` (a small gzip bomb is
  `upstream_error`); an unknown encoding is `upstream_error` instead of a
  body the app cannot read.
- **Double-encoded path traversal closed** (`normalizeForwardPath`, found by
  the block black-box pass): every path segment is decoded FULLY (up to 3
  rounds; a 4th that still changes it, a malformed escape in the raw
  segment, or a valid escape left beside a literal `%` → `403
  path_not_allowed`) and the `..` / encoded `/` / `\` / control-character
  checks run on that value, so `%252e%252e%252f` (and triple encoding) is
  refused like `../`. Only validated bytes are forwarded: a segment encoded
  at most once goes as written (its one decoding is the checked value), a
  multiply encoded one as `encodeURIComponent` of its decoded value — a
  literal percent sent as `a%2525b` reaches the upstream as `a%25b`.
- **HEAD** on a resource larger than the cap answers again (the declared
  `Content-Length` of a HEAD / 204 / 304 is not a body).
- **Request bodies** go out with `Content-Length`, never chunked.
- **Assignments are bound to the upstream record** (`modules/proxy`): the
  config gains `upstreams.<name>.id`, written by drobek when a workspace
  admin confirms (never by the agent; a written `id` that differs is a
  rebind and needs an admin). A deleted and re-registered upstream no longer
  inherits the old assignments or their `public` rule: calls answer `403
  forbidden` (`details.reason: upstream_replaced`) until the assignment is
  removed, added again and confirmed. Configs from before (name only) keep
  working and are bound lazily by their first call when the app is on the
  current record's allow-list — no migration. `allowAppOnUpstream` returns
  the record id.
- **IPv6 SSRF ranges**: 6to4 `2002::/16` (blocked whole; a blocked embedded
  IPv4 is named in the reason), local-use NAT64 `64:ff9b:1::/48`, site-local
  `fec0::/10` and discard `100::/64`.
- **Concurrency caps**: `PROXY_MAX_CONCURRENT` (32, the whole server) and
  `PROXY_MAX_CONCURRENT_PER_APP` (8) calls in flight; over either → `429
  proxy_busy` + `Retry-After: 1` (new catalogue code). Documented in
  `.env.example`, `.env.production.example`, `docs/SELF-HOSTING.md` and
  `docs/MODULES.md`; `modules/proxy/SKILL.md` names the new errors.
- e2e: `proxy-module.spec.ts` expects the dropped absolute `Location`, a
  relayed relative one and a decoded gzip answer (`proxy-echo` serves
  `/redirect/relative` and `/echo/gzip`).

### Module runtime follow-ups of the M1 security review (NSO-323)

- **Request stats no longer write per response (M3).** The module runtime
  counts a response only for a MATCHED route of an active module — never a
  429 and never an unknown route or method — and the count goes to Redis
  (`drobek:signals:mod:<app_id>:<day>`, one hash field per module and status
  class, 31-day TTL), not to Postgres. `module_request_stats` is written
  lazily: at most once a minute per app and day (a `SET NX EX` marker) and on
  every `get_logs('requests')` / dashboard Logs read, one statement per day
  (`greatest()` so a restarted Redis never lowers a stored count). A cheap
  429 flood therefore costs no SQL at all. The daily numbers of the counted
  classes are unchanged; a 404 of an unknown module route no longer shows up
  in `4xx`. New `@drobek/insights` exports `flushModuleRequests`,
  `memoryModuleStatsRedis`; `recordModuleRequest` takes `{ now, redis,
  flushEverySec }`.
- **Module e-mail budget per workspace (M4).** On top of the per-app shares,
  one workspace (all its apps together) may use at most
  `EMAIL_WORKSPACE_HOURLY_SHARE` percent of each class (notifications and
  sign-in codes; default 50, never less than one app's share) — four apps of
  one workspace can no longer take a whole class. Both shares must pass;
  refusals are `503 unavailable` with `details.limit:
  EMAIL_WORKSPACE_HOURLY_SHARE` (log event `email_workspace_share_exceeded`,
  Redis `drobek:rl:mail:ws:<workspace_id>[:sign_in]`). `MailGuardMeta` has a
  required `workspace_id`. New env var in `.env.example`,
  `.env.production.example` and the SELF-HOSTING reference — raise it to 100
  on a single-workspace server.
- **Streamed CSV export (M5).** `GET /__drobek/v1/data/:collection/export.csv`
  answers a `Readable` of ~64 KiB chunks (the new shared `csvChunks` of
  `@drobek/modules`, which the dashboard's Data export now uses too) instead
  of one string of the whole file; a schemaless collection's columns come
  from one `jsonb_object_keys` statement, so the records are read once. The
  header is pulled before the 200 (a bad filter is still a clean 400); the
  `data.export` audit is written when the stream ends, with `complete:
  false` when the download was cut off. The CSV bytes are unchanged.
- **A stored config that fails its schema degrades per part (M6).** New
  optional module contract field `salvageConfig(merged)` → `{ config, issues
  }`: the runtime serves it (logging the issues once per stored content)
  instead of silently falling back to the defaults. The data module keeps
  every collection that is valid on its own — also a legacy import of more
  than 100 collections, which used to make EVERY collection answer 404 — and
  drops only the invalid ones. No migration.

### Directory listing kit + explicit `idempotentHint` (NSO-307)

- New `docs/listing/`: `README.md` is the submission kit for the Claude
  connectors directory, the Cursor Marketplace and the Codex plugin
  marketplace (shared metadata, tagline, description, example prompts, the
  tool permission summary, per-directory checklists incl. OAuth 2.1, the
  negative-test protocol, the blockers and every `TODO(Tomáš)`);
  `inspector-log.md` is an MCP Inspector (`@modelcontextprotocol/inspector`
  CLI) pass over all 11 tools of a running server with one real call each,
  the negative tests (a write never publishes; a dashboard secret never comes
  back through any of 29 MCP results; credentials refused in files and
  config) and the OAuth metadata checks on the local server.
- Every tool now declares `idempotentHint` explicitly in `TOOL_DOCS`
  (`true` for the reads, `publish` and `configure_module`; `false` for
  `create_app`, `write_files`, `restore_version`); the other hints are
  unchanged. `llms-full.txt` / `drobek://docs/tools` print it. The full hint
  table is guarded in `packages/agent-dx/src/tools.test.ts`, the tools/list
  snapshot and the e2e specs `mcp-core-tools` / `apps-origin`.
- `docs/AGENT.md` and the README link the kit. The plugin
  (`freema/drobek-plugin`, 0.2.0) names `query_data`, `get_logs` and the nine
  skills. No migration.

### Dead code removal, knip gate, dependency audit (NSO-306)

- **`pnpm knip`** (`knip.ts`, knip 6) runs in `task check` (after lint) and
  in the CI quality job; the gate is 0 unused files, exports, types and
  dependencies across the whole workspace. Entry points the plugins cannot
  see (CLIs run by path, the module SDK entries esbuild bundles, scripts
  started from compose / shell) are declared per workspace; every ignore
  carries its reason. New `task knip`.
- Deleted dead code: `inlineSpecifiers` (`@drobek/skills-check`),
  `normalizeEmail` (`modules/auth` config), the `migrationsUpTo` test helper
  (`packages/domains`), the `AppActionIntent` type (`@drobek/dashboard`), the
  `Json` type (`@drobek/modules` merge-patch). About 70 exports that only
  their own file used are module-local now (no behaviour change).
- Removed unused dependencies: `@drobek/insights`, `@drobek/proxy` and
  `@types/nodemailer` from `apps/server`; `@drobek/core` from
  `@drobek/proxy` and `drobek-module-proxy`; the root
  `@electric-sql/pglite`. `apps/server` keeps `nodemailer` (the SSR bundle
  imports it) and the `drobek-module-*` packages (loaded by the registry).
- The DROP list of the plan was already gone after M0-02 and was verified,
  not re-deleted: the old MCP tool bodies (`@drobek/oauth` keeps only the
  transport), the old `serve.server.ts` branches, the MCP part of the dev
  entrypoint, the per-service GHCR images (no mention left), dead
  `.env.example` keys (every key is read by code or compose). `@drobek/sdk`
  is the browser SDK now, not a placeholder, and stays.
- Security updates (`pnpm audit --prod`): `react-router`,
  `@react-router/{node,express,dev}` 7.14.0 → 7.18.4 (Framework Mode DoS /
  turbo-stream advisories); lockfile refresh within the existing ranges for
  `fast-uri` 3.1.8, `ip-address` 10.7.2, `hono` 4.13.8,
  `@hono/node-server` 1.19.17, `body-parser` 1.20.8.
- **Known, not upgraded** (the fixes are major upgrades, left for a
  deliberate change): `nodemailer` 6.10 — high advisories fixed only in 7.x
  / 9.x (address-parser DoS, message-level `raw` file access) plus moderate
  ones; `drizzle-orm` 0.41 — identifier-escaping SQL injection fixed in 0.45
  (a breaking 0.x minor), exploitable only when runtime input reaches
  `sql.identifier()` / `.as()`, which drobek never does; `qs` 6.15 through
  `express` 4 (moderate). No migration.

### Docs rewritten for the cloud workspace + doc-lint (NSO-298)

- New: `docs/SECURITY.md` (threat model as shipped, status of every PHY-76
  finding, known limitations, private vulnerability reporting through GitHub),
  `docs/LICENSING.md` (AGPL-3.0 §13, the arm's-length boundary with
  drobek-web; one licence — the old "dual-license" line is gone),
  `docs/AGENT.md` (connecting Claude / Claude Code / Cursor / Codex, all 11
  tools with scopes, the briefing, skills, llms.txt) and a root `CLAUDE.md`.
- Rewritten: `README.md` (the loop, the self-host quickstart copied verbatim
  from `docs/SELF-HOSTING.md`, agent connection, local development, e2e
  tiers), `docs/ARCHITECTURE.md` (one process, origins, versions, compile,
  serving order incl. 451/404/429 and the negative cache, modules, TLS,
  jobs), `docs/POSITIONING.md` (Macaly Cloud comparison). `SELF-HOSTING.md`
  gains a complete environment reference.
- Archived to `docs/archive/`: TECHNICAL_DESIGN, ROADMAP, USER_FLOWS,
  ANALYSIS, REVIEW*, ROADMAP-critique, prompt-oneshot-implementation,
  fable-prompt-seo-visibility, research/04 (deploy pipeline — deploy_init /
  deploy_commit, BullMQ, `/:ws/app/:slug`) and threat-model-phy-76
  (superseded by SECURITY.md).
- `/llms.txt` links `docs/AGENT.md` (`AGENT_GUIDE_URL` in `@drobek/agent-dx`).
- **`pnpm doc-lint`** (`scripts/doc-lint.mjs`, first step of `task check`
  and of the CI quality job): fails on retired vocabulary outside
  `docs/archive/` and `CHANGELOG.md` (a deliberate negative assertion carries
  `doc-lint: allow`), on a README quickstart that differs from
  SELF-HOSTING's, and on any `.env.example` / `.env.production.example` key
  missing from the SELF-HOSTING environment reference. `.env.example`
  documents `DROBEK_MIGRATE_ON_START` and `AUDIT_RETENTION_DAYS`. No
  migration.

### OTP rate limits: no shared "unknown" client-IP bucket (NSO-309)

- **`/login/verify`**: a request without a resolvable client IP no longer
  lands in one instance-wide `otp-verify-ip:unknown` bucket (~30 sign-ins per
  15 min used to lock everyone out with "That code is not valid"); the per-IP
  bucket is skipped for it. The per-code cap (5 guesses, then the code is
  destroyed) is unchanged and applies to every request.
- The per-IP verify limit is configurable: `OTP_VERIFY_IP_LIMIT` (default 30)
  and `OTP_VERIFY_IP_WINDOW_S` (default 900). `@drobek/auth` exports
  `guardOtpVerify` / `otpVerifyLimitsFromEnv`.
- **Code sends** (`guardOtpRequest`, the dashboard login and the platform
  `auth` module): without a client IP the two per-IP windows are skipped
  instead of shared; per-e-mail cooldown / hourly limits and the global brake
  still apply.
- e2e: the `otp-verify-ip` bucket reset is gone; the dev and e2e compose files
  set `OTP_VERIFY_IP_LIMIT=500`. No migration.

### e2e: the `@smoke` tier cleans up its `smoke-*` app (NSO-316)

- `tests-e2e/tests/mcp-loop.spec.ts` `@smoke`: under `TEST_ENV=local` the
  fresh `smoke-<random>` app is deleted at the end (try/finally, so failed
  runs too) through the dashboard delete action as the smoke user (e-mail
  OTP). Against production (API key only; MCP has no destructive tool) the
  spec re-uses ONE stable app per key, `smoke-<12 hex of a SHA-256 of the
  key>`, via `list_apps` → `get_app`, so deploys no longer accumulate smoke
  apps. One-time cleanup of the older `smoke-*` apps is a manual runbook step
  (docs/progress.md → Next → M0-09). No migration.

### Security: M1 review fixes (NSO-322)

- **files**: the SVG sniffer's regex backtracked exponentially on repeated
  `<?xml?>` / `<!---->` (a few hundred bytes from any signed-in end user
  blocked the event loop for hours). It is a linear scanner now (PIs,
  comments, one DOCTYPE with an internal subset, at most 64 prolog items,
  then `<svg`); an unterminated item is not an SVG.
- **proxy**: a backslash in the forwarded path (`/\evil.com/x`,
  `..\..\admin`, `%5c`) is refused — the WHATWG URL parser reads `\` as
  `/`, so it reached another host with the upstream secret injected, or
  left the base path. The built target must keep the base origin and base
  path, and the allowed prefixes are checked against the parsed target path.
- **proxy**: assigning an upstream to an app and opening its `call` to
  `public` now need a **workspace admin** (editors may still reject);
  confirming puts the app on the upstream's `allowed_app_ids`, which the
  forward path enforces (`403 upstream_not_allowed`; empty = no app). The
  module contract gains `confirmRequired` items `{ change, confirmRole:
  'admin' }` (pending `confirm_role`, `403 admin_required` for others;
  `confirm_role: "admin"` in configure_module / get_app; the dashboard
  pending panel says so) and an `onConfirmed(before, after, { app, db,
  userId, role })` hook inside the confirm transaction.
- **module e-mail**: one app can no longer pause sign-in codes for every
  app: `EMAIL_SIGNIN_APP_HOURLY_SHARE` (default 25 % of the sign-in budget,
  at least 10) per app, Redis `drobek:rl:mail:app:<app_id>:sign_in`; the
  auth module clamps `AUTH_CODES_PER_APP_HOUR` to it
  (`ctx.email.signInShare`).
- **data**: a PATCH merges onto the record inside the app's write lock
  (re-read `FOR UPDATE`) — concurrent PATCHes no longer lose fields.
  Widening a collection's `read` to every signed-in user (`user`) needs the
  owner's confirmation, except for a new empty collection.
- **Performance**: effective module configs are memoized by the stored
  config's content, and the data module's compiled JSON Schemas by the
  schema's content (before, every module request re-parsed the config and
  recompiled every collection schema — ~2 ms each).

### Apps origin: negative cache + per-IP limit for unknown hosts (NSO-315)

- **Negative cache** in `ServeStore`: a slug with no live app and a hostname
  that is no custom domain are remembered for 30 s in their own count-capped
  LRUs (10 000 each), apart from the positive caches — repeating the same
  unknown host is one DB lookup, and a random-slug flood cannot evict a real
  app's entry. One miss answers every host of the slug (prod, preview, `--vN`).
- `createApp` (`@drobek/apps`) now announces an app-changed **`create`** event;
  any event of a slug drops its cached miss, so a new app is reachable on the
  very next request. A `domain` event also drops every hostname miss.
- **Per-IP limit** on "no app here" 404s: `APPS_UNKNOWN_HOST_LIMIT` (default
  60) per `APPS_UNKNOWN_HOST_WINDOW_MS` (default 60 000), counted in Redis
  (`drobek:rl:apps-unknown-host:<ip>`). Past it the answer is `429 Too Many
  Requests` (plain text, `Retry-After`, the base app security headers), and
  while throttled the IP gets 429 without any lookup for hosts the cache does
  not already know as live apps. A client without a recognised IP is never
  counted (NSO-309); the limiter fails open when Redis is down. Other 404
  pages and headers are unchanged. No migration.

### Dashboard account area: API keys, OAuth connections, Activity filter, source footer (NSO-284)

- **`/me/api-keys`**: create a personal `drk_` key (name + `read` / `write` /
  `publish`), shown once in the create response (`Cache-Control: no-store`),
  list with last use, revoke (immediate — the MCP endpoint reads the key row on
  every request). At most 25 active keys per user.
- **`/me/connections`**: the OAuth clients (DCR or CIMD) holding a live grant
  for you — name, source, scopes, last token issued. Revoke deletes the
  client's access tokens, refresh tokens and pending codes for you; its next
  MCP call is 401 and its refresh token `invalid_grant`.
- **Audit**: `api_key.create`, `api_key.revoke`, `oauth_client.revoke` (written
  to the actor's personal workspace), and the dictionary now also lists the
  actions modules/proxy already wrote (`data.export`, `proxy.blocked`,
  `proxy.upstream.create|delete`). Activity + its CSV gain an actor filter
  (`?actor=user|agent|end_user`); end-user rows get their own badge.
- **Footer** on every dashboard page: `Source (AGPL-3.0) · <sha>` linking to
  `https://github.com/freema/drobek/commit/<GIT_SHA>` (AGPL-3.0 §13); a build
  without a sha links to the `main` tree.
- `@drobek/oauth`: `listApiKeys`, `revokeUserApiKey`, `listConnections`,
  `revokeConnection`. No migration.
### Dashboard: the Modules tab (NSO-291)

- **`/workspaces/<ws>/apps/<app>/modules`** lists the server's platform
  modules for the app (configured, pending, missing required secrets);
  **`…/modules/<module>`** (configure_module's `confirm_url`) shows the pending
  change (before → after diff, the module's confirmRequired strings with a
  plain-language risk note, Confirm / Reject), a config form generated from
  the module's JSON Schema (own renderer; the server validates through the
  module's configSchema and puts each error at its field), the write-only
  secrets (Set / Rotate / Remove, `hasSecret` + when set; audit
  `module.secret_set` / `module.secret_remove` with the name only), the data
  module's collections + rules editor (operation × principal, JSON Schema)
  and the proxy module's per-app upstream assignments. Every save goes
  through the configure path, so relaxations wait for confirmation. Viewers
  see everything without controls (POST → 403). The app page shows "N
  changes await confirmation" (`PendingBanner`).
- **`@drobek/modules`**: an agent's `configure_module` that leaves a change
  pending e-mails the app's owners (the `email` module's `{ appOwners: true }`
  path, a `notification`), at most once per app per hour (Redis
  `drobek:rl:modules:pending-mail:<app_id>`), listing everything that waits.
  `configure({ surface: 'web' })` audits as the user and sends no e-mail;
  `moduleView()`, `pendingSummary()`, `secretsStatus()`.
### Dashboard: the app page (NSO-288)

- **App page tabs** (`@drobek/dashboard`): Overview (header + versions +
  health panels), Files, Data, Settings — listed in ONE data-driven array
  (`app-tabs.ts`). The header shows the production / preview URLs (links,
  never a frame), the newest version's compile state, the agent's
  single-writer lease ("your agent / an agent of X is working, last write
  N s ago") with **Unlock**, and **Unpublish**.
- **Versions**: number, time, author, reasoning, compile status + first
  error; **Publish** (an older version = the rollback), **Restore** (a new
  version with that version's files → the preview; refused with 409 while
  another member's agent holds the lease), **Open** `<slug>--v<N>`, Files.
- **Files**: the version's tree (source + built), a read-only viewer with a
  dependency-free highlighter (text only, never markup), **Download .zip** of
  the version (`<slug>-v<N>/source/…` + `<slug>-v<N>/built/…`, streamed,
  `@drobek/apps` `zipStream` on `node:zlib` — no new dependency).
- **Settings**: visibility public / password (scrypt, the app-host gate's
  hasher), the CSP `frame_ancestors` override (validated by
  `parseFrameAncestors`), **Delete app** (type the slug).
- **Apps list**: search (name / slug), published / not published, sort by
  last change / newest / name; deleted apps never appear.
- Everything is role-gated (editor+ mutations — a viewer gets no control and
  403 on POST; viewer+ reads) and audited: new actions `app.unpublish`,
  `app.delete`, `app.slug_release`, `app.lock.release`,
  `app.visibility.public`, `app.visibility.password`,
  `app.frame_ancestors.change`.
- **Soft delete + slug release** (`@drobek/apps`): `softDeleteApp` hides the
  app everywhere (dashboard, MCP `not_found`, every app host 404 — the serve
  cache is busted at once); the slug stays taken for 30 days, then
  `releaseDeletedAppSlugs` renames it to `<slug>~deleted-<id>` (hourly sweep
  next to the blob GC, Redis lease; `createApp` also releases the one slug it
  asks for). Migration **0016** lets the slug CHECK admit that tombstone on
  deleted rows only and adds a partial index on `apps.deleted_at` (additive).
- The lease key + value parsing moved from `@drobek/mcp` to `@drobek/apps`
  (`leaseKey`, `parseLease`, `readAppLease`, `releaseAppLease`; `@drobek/mcp`
  re-exports them); leases now carry `renewed_at`.
### Custom domains (NSO-292)

- **`@drobek/domains`** (new): `domains` table (migration `0018_custom_domains`
  — per-app unique hostname, at most one VERIFIED row per hostname instance-wide,
  one primary per app). Hostname checks (PSL via `psl`, IDN → punycode; names
  under `APPS_DOMAIN`, the dashboard host or `drobek.app`, IP literals and
  special-use TLDs refused with `hostname_not_allowed`), TXT
  `_drobek.<host> = drobek-verify=<token>` + CNAME to `<slug>.<APPS_DOMAIN>`
  (A/AAAA fallback for apex / ALIAS) against an injectable resolver, 5 s per
  lookup; transient failures never drop a verification. `DOMAINS_MAX_PER_APP`
  (default 3, then `limit_exceeded`), `DOMAINS_DNS_SERVERS`,
  `DOMAINS_RECHECK_INTERVAL_MS`, dev-only `DOMAINS_DNS_MOCK=redis`.
- **Daily re-check**: verified domains older than 24 h are re-checked by a
  leased background sweep; a definitive failure unverifies the domain and
  e-mails the workspace's editors and admins.
- **Dashboard**: the app's **Domains** tab (`/workspaces/:slug/apps/:appSlug/domains`)
  — add, DNS instructions, verify, make primary, remove.
- **`@drobek/apps`**: `classifyHost` returns `custom` for a plausible host
  outside `APPS_DOMAIN` (it used to be the dashboard's); `AppHostTarget`
  `{ kind: 'custom' }`; the `domain` app-changed event.
- **`@drobek/serving`**: a verified custom host serves the published version
  (unknown → dashboard, registered-but-unverified → 404, lookup error → 503);
  a primary domain makes `<slug>.<APPS_DOMAIN>` answer 302 to it; the TLS ask
  answers 200 for verified custom domains of live apps.
- **Caddy** (`@drobek/core` generator): an on-demand catch-all `https://` site
  behind the ask — on by default in on-demand mode, `TLS_CUSTOM_DOMAINS=1|0`
  otherwise (needs `TLS_ASK_TOKEN`).
- **Audit**: `domain.add`, `domain.verify`, `domain.unverify`,
  `domain.primary`, `domain.remove`. **MCP** `publish` returns
  `domains: [<default host>, …verified custom domains]`.
### Dashboard: the owner's app tabs (NSO-301)

- **Data tab**: edit a record as JSON (validated by the module), import a
  CSV (≤ 5 000 rows, all or nothing, the first bad row named by its line;
  skips `DATA_WRITE_RATE_LIMIT`, keeps the quotas), delete a collection
  after typing its name. New tabs **Forms** (`/workspaces/:slug/apps/:appSlug/forms`:
  filter, CSV, delete), **Users** (`…/end-users`: role, block, sign everyone
  out), **Uploads** (`…/uploads`: list, nosniff raster preview, delete) and
  **Logs** (`…/logs`: the `get_logs` data, since + Refresh). All mutations
  editor+, audited (`data.import`, `data.record_update`, `data.record_delete`,
  `data.collection_delete`, `forms.submission_delete`, `end_users.role`,
  `end_users.disable`, `end_users.enable`, `files.delete`).
- **`@drobek/modules`** (contract stays 1.0.0 — additive, all optional):
  `records.update/importCsv/dropCollection`, `endUsers.list/setRole/
  setDisabled`, new `submissions` and `files` authorities, `OwnerView`
  (with `limits()`), `RECORDS_IMPORT_MAX_ROWS`. Built-in `data`, `auth`,
  `forms`, `files` implement them. `@drobek/core`: `parseCsv`, `csvUnguard`,
  `CsvParseError`.

### Abuse and moderation (NSO-293)

- **Report pointer + form**: `GET /.well-known/drobek-report` on every app host
  → `{ report_url, app, terms_url }` (public, 1 h); the public form
  `/report?host=` on the dashboard origin (no login, honeypot,
  `ABUSE_REPORTS_PER_IP_HOUR` = 5) stores `abuse_reports`, audits
  `abuse.report` and e-mails the super-admins (once per app per hour).
  `X-Drobek-App: <slug>` on every app-host response.
- **Takedown / restore** (`/admin/abuse`, super-admins only): unpublish + lock
  (`apps.locked_reason`) → 451 on every host of the app (link to `TERMS_URL`),
  `app_locked_by_admin` from `write_files` / `restore_version` / `publish` /
  `configure_module` (and `@drobek/apps` createVersion / publish / restore),
  423 from the module confirm API, `locked_by_admin` in `list_apps` /
  `get_app`, owners e-mailed; audit `admin.takedown` / `admin.restore`.
  Restore does not republish.
- **Publish heuristic** (`@drobek/apps` `screenPublishedVersion`, run by every
  `publish`): password field + a brand word (`ABUSE_BRAND_WORDS`) in the title
  / h1 / text / JS strings → a `heuristic` report + a warn log line. Never
  blocks.
- Migration **0021_abuse_reports** (additive): `abuse_reports`,
  `abuse_report_status`, `apps.locked_reason`.
- **With the app page and custom domains** (NSO-288 / NSO-292): the 451
  also answers on a verified custom domain, and a taken-down app's production
  host answers 451 instead of its primary-domain 302; a report naming a
  verified custom domain attaches to its app. The app page shows the "taken
  down by the operator" banner on every tab and answers publish / restore /
  unpublish with 423; the module page refuses changes with 423 (reject and
  removing a secret stay allowed).

### Self-host packaging: production compose, `selfhost:init`, backup/restore, release tags (NSO-304)

- **`docker-compose.production.yaml`** rewritten: drobek + postgres 17 +
  redis 7 + caddy, `${VAR:?}` fail-fast for every secret, host and
  `SMTP_HOST`, a healthcheck on all four, `restart: unless-stopped`, image
  `ghcr.io/freema/drobek:${DROBEK_IMAGE_TAG:-latest}`, `DROBEK_MODULES`
  defaulting to all six built-ins, configurable `HTTP_PORT` / `HTTPS_PORT` /
  `PUBLISH_IP`, Caddy = the stock `caddy:2-alpine` unless DNS-01. ⚠️ It now
  reads **`.env.production`** (`--env-file .env.production` + `env_file`),
  the project is **`drobek-prod`** and the volumes are `pg_data`,
  `redis_data`, `files_data`, `caddy_data`, `caddy_config` (were
  `postgres_data`, … under project `drobek`, which collided with the dev
  stack's project name) — an instance started from the M0-07 file must move
  its data with `task backup` / `task restore`.
- **`.env.production.example`**: every variable commented (what, how to
  generate, secret or not), the four TLS paths.
- **`task selfhost:init`** (`scripts/selfhost-init.sh`): non-interactive and
  idempotent — `.env.production` (mode 600), `openssl rand -hex 32` for every
  empty secret (never overwrites one), `DOMAIN` / `APPS_DOMAIN` / `TLS_MODE` /
  `HTTPS_PORT` / SMTP from the environment, the Caddyfile rendered with the
  image's own generator (no Node on the host), a `docker compose config` check
  and the next steps.
- **`task backup`** / **`task restore BACKUP=…`** (`scripts/selfhost-backup.sh`,
  `scripts/selfhost-restore.sh`): `backups/drobek-<UTC>.tar.gz` with
  `pg_dump -Fc`, the `files_data` and `caddy_data` volumes, `SHA256SUMS` and
  a `manifest.json` (image tag / id / version / sha, checkout sha, master-key
  fingerprint, counts, sizes, sha256s). Restore verifies, refuses a
  non-empty database (`FORCE=1`) and a different `DROBEK_MASTER_KEY`
  (`ALLOW_KEY_MISMATCH=1`), stops drobek + caddy, restores, starts.
- **`task selfhost:migrate`** = `node dist/server/migrate.js` in the image
  (new: the server's config checks + core and module migrations, then exit);
  **`task selfhost:upgrade`** = backup → pull → stop drobek → migrate ×2 → up.
- **Image versioning** (`ci.yml`): `v*` tags run the full pipeline and push the
  tested image as `vX.Y.Z`; a `release` job retags in the registry (former
  `latest` → `previous`, `vX.Y.Z` → `latest`; pre-releases get only their
  tag). ⚠️ `main` now pushes `:<sha>` + **`:edge`** — no longer `:latest`,
  which means "newest release". Builds are `linux/amd64` only.
- **`/api/version`** returns `{ sha, version }` — `version` from the new
  `VERSION` build arg (`DROBEK_VERSION`, the release tag; `dev` otherwise);
  OCI labels `org.opencontainers.image.{source,revision,version}`.
- **`task selfhost:rehearsal`** (`scripts/selfhost-rehearsal.sh` +
  `tests-e2e/selfhost-rehearsal.mjs`, not in `check` / CI): the quickstart and
  a backup → restore onto a second fresh stack, end to end, timed.

### The built-in `proxy` module (NSO-297)

- **`modules/proxy`** (`drobek-module-proxy`): `/__drobek/v1/proxy/:upstream/*`
  (GET/HEAD/POST/PUT/PATCH/DELETE, raw body 1 MiB) forwards to a workspace
  upstream with its secret injected server-side. Config `{ upstreams: { <name>:
  { rules: { call }, rateLimit? } } }` assigns an upstream to the app —
  assigning one and `call: 'public'` wait for the owner's confirmation.
  `X-Drobek-SDK: 1` on every call, `PROXY_CALLS_PER_MIN` (60 per app),
  `PROXY_PUBLIC_CALLS_PER_MIN_PER_IP` (10) for public upstreams, an optional
  per-assignment `rateLimit`. `get_app` / `configure_module` show
  `info.upstreams[]` with `hasSecret` (never the value). SDK
  `drobek.proxy.fetch(upstream, path, init)`.
- **`@drobek/proxy`**: port allow-list 80/443 (`PROXY_ALLOWED_PORTS`, PHY-76 #8)
  at registration (`invalid_request`) and at connect time (`ssrf_blocked`);
  20 s forward deadline, 5 MiB response cap; the client's `Origin`, `Referer`,
  `Forwarded`, `Via`, `Sec-*` are no longer forwarded, `Accept-Encoding` is
  forced to `identity`; upstream `Access-Control-*` headers are dropped and
  responses are `Cache-Control: no-store`. **Removed:** the dashboard-host
  route `/<ws>/api/proxy/<name>/*`, `PROXY_RATE_LIMIT` /
  `PROXY_RATE_WINDOW_MS`, `canCallProxy`.
- **`@drobek/modules`**: trailing `*` route segments (`req.params['*']`),
  `bodyTypes: ['raw']`, `req.headers()`, `req.rawQuery`, and the optional
  `appInfo(view)` hook surfaced as `modules.<name>.info`.
### The built-in `files` module (NSO-296)

- **`modules/files`** (`drobek-module-files`): end-user uploads. `POST
  /__drobek/v1/files` / `drobek.files.upload(file)` streams one file to
  `FILES_DIR` (per-file cap `FILES_MAX_BYTES` 10 MiB → `413`, aborted while
  streaming; per-app quota `FILES_QUOTA_PER_APP` 500 MiB → `409
  quota_exceeded`; `FILES_UPLOAD_RATE_LIMIT` 60/min). The type is sniffed
  from the bytes — PNG, JPEG, GIF, WebP, PDF, SVG, CSV; anything else (an
  HTML page named `.png`) → `415 unsupported_type`. `GET /:id` serves the
  sniffed type with `nosniff`, `inline` only for images and PDF (SVG and CSV
  as attachments), an ETag and an immutable cache when `read` is public.
  `DELETE /:id` (owner or admin). Blobs are content-addressed and shared
  across apps; one is unlinked when no file references it. Config `{ rules:
  { upload, read }, maxBytes?, allowedTypes }`; opening either rule to
  public waits for the owner. Table `mod_files`.
- **`@drobek/modules`**: route `bodyTypes: ['file']` with `req.file()` (a
  streaming single-file multipart parser); handlers may answer with a Node
  `Readable` body. **`@drobek/serving`** streams request and response
  bodies; **`@drobek/sdk`** sends a `FormData` body as-is.

### The built-in `forms` and `email` modules (NSO-295)

- **`@drobek/email`** (new core package): the SMTP transport and the e-mail
  layout moved out of `@drobek/auth` (which re-exports the old names), plus
  `sendEmail` (sender name sanitized, the address always `EMAIL_FROM`) and
  `renderTextEmailHtml` (plain text escaped into the layout). The dashboard
  login, invites and module mail share it.
- **`modules/email`** (`drobek-module-email`): `POST
  /__drobek/v1/email/notify-admins` / `drobek.email.notifyAdmins(subject,
  text)` (signed-in users) e-mails the app's owners — the editors and
  workspace-admins of its workspace; `EMAIL_NOTIFY_ADMINS_PER_DAY` (20 per
  app) → `limit_exceeded`. Config `{ fromName, replyTo }` (a new `replyTo`
  waits for the owner). It is the app's **mail authority**: every
  notification any module sends counts against `EMAIL_PER_APP_PER_DAY` (50)
  and carries the app's sender name and reply-to.
- **`modules/forms`** (`drobek-module-forms`, requires `email`): `GET
  /__drobek/v1/forms/:form/token`, `POST /__drobek/v1/forms/:form` (JSON or
  text-only multipart, 32 KiB; honeypot `_hp` dropped silently with a log
  counter; HMAC time token `_t` keyed from `DROBEK_MASTER_KEY`, ≥ 2 s old →
  otherwise `429 submitted_too_fast` / `400 invalid_form_token`;
  `FORMS_SUBMITS_PER_IP_HOUR` 10, `FORMS_PER_APP_PER_DAY` 200), admin-only
  `GET :form/submissions` (keyset pagination) and `submissions.csv` (formula
  cells neutralized, audit `forms.export`). Table `mod_forms_submissions`
  (IP stored as a keyed hash). Notifications to the owners and
  `notify.emails` (any change waits for the owner). SDK `drobek.forms` and
  the inline React `<Form>` (`import { Form } from 'drobek/forms'`).
- **Module e-mail in core**: the recipient kind `{ appOwners: true }` and
  recipient lists (validated, de-duplicated, one message per address); the
  operator-wide cap `EMAIL_GLOBAL_HOURLY_MAX` (500 recipients per hour, all
  module mail) is split into two budgets (NSO-320): sign-in codes
  `EMAIL_SIGNIN_HOURLY_MAX` (default 20 % of the cap, ≥ 50, ≤ half) and
  notifications (the rest; one app ≤ `EMAIL_APP_HOURLY_SHARE` %, default
  25). Past its budget a class pauses for `EMAIL_GLOBAL_PAUSE_MINUTES` (15)
  with an `email_global_pause` ALERT log line for the super admin (`503
  unavailable`, `details.reason: email_paused`, fail closed) — notifications
  pausing never blocks sign-in codes; audit
  `email.send` (counts, never addresses). Texts are capped at 20 000
  characters.
- **Module contract** (additive): `requires` (missing dependency → the server
  refuses to start with a message naming `DROBEK_MODULES`), `mail.prepare`
  (the mail authority, at most one), route `bodyTypes: ['json',
  'multipart']` (text fields only; files → `415`), `RateLimitResult.count`.
- Error catalogue: `submitted_too_fast`, `invalid_form_token`; module-route
  meanings of `limit_exceeded`, `unavailable`, `unsupported_media_type`.
- The dev and e2e composes run `DROBEK_MODULES=hello,auth,email,forms`.
  e2e `forms-email.spec.ts`.

### The built-in `auth` module: end-user sign-in (NSO-294)

- **`modules/auth`** (`drobek-module-auth`, a workspace package and a
  dependency of the server, loaded like any module with
  `DROBEK_MODULES=auth`): the people who use an app sign in with a 6-digit
  code e-mailed to them. Routes `/__drobek/v1/auth/send-code`, `verify`, `me`,
  `logout`; config `{ allow: { emails, domains, anyone }, adminEmails }`
  (`anyone: true` waits for the owner); table `mod_auth_users` (migration
  `0000_auth_users`, its own journal); the workspace's editors always sign in
  as `admin`; `disabled_at` users cannot sign in and are signed out on `me`;
  every `me` re-checks the allowlist and the role. Limits
  `AUTH_CODES_PER_IP_15MIN`, `AUTH_CODES_PER_IP_DAY`,
  `AUTH_CODES_PER_EMAIL_HOUR`, `AUTH_CODES_PER_APP_HOUR`,
  `AUTH_ATTEMPTS_PER_IP_15MIN`, `END_USERS_MAX_PER_APP`. Audit
  `auth.sign_in`. Errors `email_not_allowed` (403, no e-mail sent),
  `invalid_code` (400), `too_many_attempts` (429) are in the error catalogue.
  Its skill (`skill_info('auth')`) carries a `<LoginGate>` example.
- **`drobek.auth`** in `/__drobek/sdk.js` (`me`, `sendCode`, `verify`,
  `logout`, `onChange`) and **`import { LoginGate, useAuth } from
  'drobek/auth'`**: React components compiled into the app with the app's own
  React.
- **Inline SDK sources** (`sdk.inline { entry, types }` in the module
  contract): `@drobek/compile` builds `drobek/<module>` into the app bundle,
  resolving its bare imports through the app's `drobek.json`; relative imports
  are refused; an unknown `drobek/<x>` lists the available ones.
- **End-user sessions in core** (`@drobek/modules`): host-only cookie
  `__Host-drobek_eu` (`drobek_eu`, without `Secure`, only in plain-http dev),
  `HttpOnly`, `SameSite=Lax`; Redis `drobek:eu:<app_id>:<token>`, 30 days
  rolling; a per-app epoch (`drobek:eu-epoch:<app_id>`) revokes every session
  of an app at once (PHY-76 #9). The principal resolver fails closed.
- **The principal is authoritative**: the Redis record alone never makes a
  principal. On every module request that carries a session, core asks the
  module that owns end-user sessions (new contract field `endUsers.current`,
  declared by `auth`; at most one per server, none → no session is honoured)
  who the user is now. Disabled, deleted, no longer allowed (allowlist,
  `adminEmails`, workspace editor removed) → anonymous in every module and
  the session deleted; a role change applies on the next request. No cache.
- **`drobek-module-hello`**: `GET /whoami` / `drobek.hello.whoami()` returns
  the visitor as `ctx.principal`.
- **Dashboard API `POST /api/apps/:id/end-user-sessions/revoke`**: the owner
  signs every user of an app out (the confirm API's guards: session, required
  dashboard `Origin`, editor, non-member → 404). Audit
  `end_users.sessions_revoke` (actor user). The two owner APIs share one guard
  implementation (`packages/dashboard/src/app-api.server.ts`).
- **`@drobek/auth`**: the e-mail code and the OTP guard take an optional scope
  (`otpKeyPrefix`), so an app's end-user codes, counters, cooldowns and pauses
  are separate from the dashboard login's; the operator kill switch still
  applies.
- **Module e-mail**: the recipient kind `{ signInAddress }` (one address, for
  a sign-in code); subjects are forced to one line of at most 200 characters.
- The built-in module list moved from the registry (`BUILTIN_MODULES` is
  gone) to `modules/*` packages. The dev and e2e composes run
  `DROBEK_MODULES=hello,auth` with relaxed `AUTH_*` limits.

### Platform modules: the contract, `skill_info`, `configure_module` (NSO-287)

- **`@drobek/modules`** (new): the module contract (`defineModule`, contract
  1.0.0), the registry that loads `DROBEK_MODULES` (short name `x` →
  package `drobek-module-x`, resolved from the server's dependencies; any
  misconfiguration stops the server at start), the per-request app-scoped
  `ModuleContext` (principal from the end-user cookie, `rules.decide`,
  `limits`, `rateLimit`, `secrets.get`, `audit`, `db`, `email`), the
  `ModuleRouter` pipeline (CSRF, rule, rate limit, zod body/query with field
  paths) with one error shape `{ error, message, details?, hint }`, module
  migrations with their own journal (`__drizzle_migrations_mod_<name>`), and
  `@drobek/modules/testing` (`createModuleTestContext`). Contract:
  `docs/MODULES.md`.
- **`/__drobek/sdk.js` + `sdk.d.ts`** on every app host: the SDK core
  (`@drobek/sdk`) plus every active module, bundled with esbuild at start. The
  compiler maps `import { drobek } from 'drobek'` to `sdk.js?v=<hash>`
  (immutable under the current hash, revalidate + ETag otherwise).
  `/__drobek/v1/<module>/…` routes answer after the app's visibility gate; a
  locked app answers `401 password_required`.
- **Migration `0011_modules`**: `module_configs` (sparse merge-patch config +
  one pending change per app and module), `module_secrets` (envelope-encrypted
  per-app module secrets, written only from the dashboard, never returned by
  any API), audit actor kind `end_user`; both tables cascade on app delete.
- **MCP `configure_module`** (scope `write`, editor, takes the lease): a merge
  patch validated against the module's schema; changes the module marks as
  risky are held as pending and return `confirm_url`; values that look like
  secrets are refused; `secrets_missing` lists unset required secrets by name.
  Audit `module.configure` / `module.pending` (actor agent).
- **Dashboard API `POST /api/apps/:id/modules/:module/confirm|reject`**
  (session, required dashboard `Origin`, editor; non-member → 404; nothing
  pending → 409). Audit `module.confirm` / `module.reject` (actor user).
- **MCP `skill_info`** (scope `read`) replaces the planned `module_info`:
  `skill_info()` lists the skills (name + use_when), which `create_app`,
  `get_app` and the briefing list too; `skill_info('<name>')` returns the skill
  plus, for a module, the SDK types, the config JSON Schema and defaults,
  limits and secret names. It never returns a secret value or any app's
  config. General skills come from `skills/<name>/SKILL.md` (the platform
  skill `skills/drobek` is not listed); the image now ships `skills/`.
  Module route errors hint `skill_info('<module>')`; an `unresolved_import` of
  a backend SDK hints the matching skill (`skill_info()` when none is active).
  `get_app` returns `modules.<name>` (config, pending, `confirm_url`, secret
  names with `hasSecret`). The MCP server now has nine tools; the consent
  screen labels list them.
- **`LIMITS_PROVIDER_URL`** (+ `LIMITS_PROVIDER_SECRET`, ≥ 32 chars, checked
  at start): HMAC-signed `GET /limits/<workspace_id>`, cached 60 s in Redis,
  env defaults when the provider is down.
- **`@drobek/agent-dx`**: `MODULE_INFO_RULE` is now `SKILL_INFO_RULE`
  ("Before using a backend … call `skill_info` and follow the skill;
  `create_app`/`get_app` list the available skills."), stated verbatim in
  `skills/drobek/SKILL.md` (guard test) and the plugin's skills; tool docs and
  the error catalogue cover the new tools and every module error code.
- **`examples/drobek-module-hello`**: the example module as an external
  workspace package (routes, SDK, config with a confirm rule, optional secret,
  a limit, its own table and SKILL.md). The dev and e2e composes run with
  `DROBEK_MODULES=hello`.
### Agent DX v0: the drobek plugin, install lines, skill guard (NSO-302)

- **`freema/drobek-plugin`** (new repo, MIT): marketplace `drobek` with plugin
  `drobek` for Claude Code, Codex and Cursor — `.mcp.json` on
  `https://drobek.app/mcp`, a `build-app-on-drobek` skill per host (the Claude
  variant acts only once the user has chosen drobek), the Cursor rule
  `route-app-builds-to-drobek.mdc` and the `/drobek:build-app` command.
  `claude plugin validate --strict` plus the Codex/Cursor validators run in its
  CI.
- **`@drobek/agent-dx` `plugin.ts`**: the plugin's repo, marketplace, install
  commands and MCP URL, and `MODULE_INFO_RULE` — the present-tense module rule
  every drobek skill states verbatim. `/llms.txt` gains a "Plugin (Claude Code,
  Codex, Cursor)" section; `/llms-full.txt` and `/build-with-your-agent` show
  `claude plugin marketplace add freema/drobek-plugin` +
  `claude plugin install drobek@drobek` and point Codex / Cursor at the plugin
  repo, next to the manual MCP connect + skill install.
- **`skills/drobek`**: SKILL.md states the module rule and the hosted
  `https://drobek.app/llms-full.txt`; its README points at the plugin.
  `skill.test.ts` now also guards the loop rules (preview_url, publish only on
  an explicit request, single writer, no secrets) and the module rule;
  `render.test.ts` asserts every input field, result shape and example of every
  manifest tool is in llms-full.txt (with the `@drobek/oauth` parity test:
  tools/list == TOOL_DOCS == llms-full.txt).

### e2e agent loop + CI against the production image (NSO-289)

- **`tests-e2e/tests/mcp-loop.spec.ts`**: the agent loop through a real MCP
  client — the SDK's OAuth provider does discovery, Dynamic Client
  Registration and PKCE (consent driven by Playwright), then list_apps →
  create_app → write_files (compile error → fix) → preview host → publish →
  production host → restore_version → get_app, under 90 s. A second, `@smoke`
  loop authenticates with `SMOKE_API_KEY` (a `drk_` key, env only) and is safe
  against production: public HTTP + MCP, one `smoke-<random>` app, no
  database / Redis / Mailpit. `agent-loop.spec.ts` is now
  `dashboard-insights.spec.ts`.
- **`task e2e:image`** / `scripts/e2e-image.sh` / `docker-compose.e2e.yaml`:
  the production image behind Caddy (`tls internal`, `https://localhost:8443`)
  with throwaway postgres / redis / mailpit / proxy-echo, migrations on boot,
  then the whole `@smoke` + `@local` suite. Runs next to the dev stack.
- **CI** (`.github/workflows/ci.yml`): push to `next` / `main` only (no PR
  trigger), cancel-in-progress; lint + typecheck + unit, then build the image
  once, run the e2e flow against it, and on `main` push exactly that image.
  pnpm store + Playwright browsers cached; no secrets beyond `GITHUB_TOKEN`.
- `task e2e:smoke` takes `BASE_URL_WEB` / `SMOKE_API_KEY` from the environment
  (the post-deploy smoke of M0-09).

### TLS for the apps origin: Caddy, wildcard cert, `ask` endpoint (NSO-286)

- **Caddy in front** (`docker-compose.production.yaml`: drobek + postgres +
  redis + caddy, only Caddy publishes 80/443, volumes `caddy_data` /
  `caddy_config`, secrets only from `.env` / `.env.caddy`). The Caddyfile is
  generated from the environment by **`task caddy:config`**
  (`@drobek/core` `caddyfileFromEnv`, CLI `packages/core/dist/cli/caddy-config.js`
  → `deployments/Caddyfile`, gitignored) and holds no secrets. The dashboard
  host gets a normal ACME certificate; `*.<APPS_DOMAIN>` uses exactly one of:
  a wildcard certificate file (`TLS_WILDCARD_CERT_FILE` /
  `TLS_WILDCARD_KEY_FILE`, picked up after renewal by **`task tls:reload`** =
  `caddy reload --force`), ACME DNS-01 with a Caddy DNS module
  (`TLS_DNS_PROVIDER`, `TLS_DNS_PROVIDER_ARGS`,
  `TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN` for `_acme-challenge` CNAME delegation;
  `deployments/Dockerfile.caddy` builds the module with xcaddy — there is no
  Hostinger module), or on-demand per host, always behind the `ask` guard.
  `TLS_INTERNAL=1` = Caddy's local CA (dev). Ambiguous combinations are
  refused.
- **`GET /api/internal/tls/ask?domain=<host>&token=…`** (`@drobek/serving`):
  200 only for `<slug>[--preview|--v<N>].<APPS_DOMAIN>` of a live,
  non-deleted app; 401 without / with a wrong `TLS_ASK_TOKEN`
  (constant-time); 404 for anything else, for every request while the token
  is unset, and on the public dashboard host; 503 when the lookup fails.
  Caddy returns 404 for `/api/internal/*` on every public site. A set but weak
  `TLS_ASK_TOKEN` (< 32 URL-safe chars, or a `change-me` placeholder) stops
  the server from starting.
- **`TRUST_PROXY`** (`auto` default | `x-real-ip`): with `x-real-ip`
  `getClientIp` reads ONLY `X-Real-IP` (and only a literal IP) — never
  `X-Forwarded-For`. Caddy overwrites `X-Real-IP` with the TCP peer, so
  per-IP rate limits key on the real client behind Caddy. Unset keeps the
  PHY-76 #4 behaviour for nginx fronts. An unknown value stops the server.
- **`task dev:tls`** (`docker-compose.tls.yaml` override): the dev stack
  behind Caddy with `tls internal` on `https://localhost` and
  `https://<slug>--preview.apps.localhost`; Caddy's root CA is copied to
  `.caddy/root.crt` (never installed into a trust store). `task dev:tls:down`
  returns to the plain-HTTP dev stack, which is unchanged.
- Docs: `docs/SELF-HOSTING.md` (production compose, the three TLS paths with a
  CNAME delegation example, the ask contract and its limits, dev TLS).

### ⚠️ Breaking: apps on their own origin, `publish` tool, `__Host-` cookies (NSO-285)

- **Everyone is signed out once.** The dashboard session cookie is renamed
  `drobek_session` → **`__Host-drobek_session`** (always `Secure`, `Path=/`,
  no `Domain` — host-only, so it can never reach an app host). The old cookie
  is ignored. The Google-login state and login-return cookies get the same
  prefix (`__Host-drobek_google_oauth_state`, `__Host-drobek_login_return`).
  The prefix (and `Secure`) is used whenever `NODE_ENV=production` or the
  dashboard origin is https; only plain-http development drops it (browsers
  refuse `__Host-` on `http://localhost`) — the cookies stay host-only there.
- **App serving (host dispatch in `apps/server`).** `<slug>.<APPS_DOMAIN>` →
  the published version (a 404 "not published yet" page before the first
  publish), `<slug>--preview.<APPS_DOMAIN>` → the newest version that
  compiled, `<slug>--v<N>.<APPS_DOMAIN>` → exactly version N. Files come from
  `version_files`: built outputs win over a source on the same path,
  `*.ts`/`*.tsx`/`*.jsx` sources and `drobek.json` are never served, other
  paths fall back to `index.html`. `ETag` = the sha256 (304 on
  `If-None-Match`); `Cache-Control: public, max-age=0, must-revalidate`, and
  `public, max-age=31536000, immutable` for js/css requested with a hash query
  (`?v=<8–64 url-safe chars>`); password apps use `private`. Bytes are cached
  in-process (LRU by sha256, 256 MiB), host resolutions for 60 s; both are
  busted on every new version / publish through the Redis
  `drobek:app-changed` channel (and a full drop on a Redis reconnect).
- **App headers:** the app CSP (`default-src 'self'; script-src 'self'
  https://esm.sh 'unsafe-inline'; …; frame-ancestors 'none'; form-action
  'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex` on preview/version hosts. App hosts never read the
  dashboard session and never set a dashboard cookie. A malformed `Host` is a
  400.
- **The dashboard never serves an app** and refuses mutating requests (POST,
  PUT, PATCH, DELETE) whose `Origin` is an app host, `null` or a foreign site
  with **403** (`/oauth/token`, `/oauth/register` and `/mcp` are exempt — they
  are cross-origin by design and cookie-less). This also applies to the BFF
  proxy route: an app page can no longer call it with the dashboard session.
- **Password gate:** `apps.visibility` is now `public | password`. A password
  app answers 401 with a form on every host; `POST /__drobek/password` (10
  attempts per 15 min per app + IP) sets `__Host-drobek_app_access`
  (host-only, `Secure`, `HttpOnly`, `SameSite=Lax`, 12 h; plain-http dev:
  `drobek_app_access` without `Secure`), an HMAC token bound to the app and
  signed with a key derived from `DROBEK_MASTER_KEY`.
- **New MCP tool `publish(app_id, version?)`** — scope `publish`, editor+,
  annotations destructive + open-world; the default is the newest version that
  compiled, an older one is the production rollback; a version that did not
  compile → `not_publishable`. Audited as `app.publish`; returns
  `{ published_version, previous_version, published_url, domains }`. No
  write lease (it only moves the published pointer). `tools/list` now has
  seven tools; the briefing, `/llms*.txt`, the `build-an-app` prompt and the
  skill say to publish only when the user explicitly asks.
- **Migration `0010_apps_origin`**: the `app_visibility` enum becomes
  `public | password` (existing `team` apps become `password` — with no
  password set they stay closed until an owner sets one) and adds the
  nullable `apps.frame_ancestors` (`'self'` or up to 10 http(s) origins,
  space-separated; anything else falls back to `'none'`).

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
