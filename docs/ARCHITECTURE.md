# drobek — architecture

drobek is a cloud workspace for web apps that people build with their own AI
agent. The agent connects over MCP and works **directly in drobek**: it writes
files, drobek compiles them in-process with esbuild and returns the compile
result in the same response, every write becomes an immutable version with an
instant preview host, and a version goes live when the user asks for it. An
app's backend is never code the agent writes: it is a set of **platform
modules** (TypeScript, installed by the operator) that the app calls through a
small browser SDK. The dashboard is for what does not belong in a chat with an
LLM: secrets, confirmations, domains, data, users, logs.

This document is the map of how that works. The neighbours:
[`SELF-HOSTING.md`](./SELF-HOSTING.md) (running it),
[`MODULES.md`](./MODULES.md) (the module contract and the built-in modules),
[`AGENT.md`](./AGENT.md) (the agent-facing contract),
[`SECURITY.md`](./SECURITY.md) (the threat model),
[`LICENSING.md`](./LICENSING.md) (AGPL and the hosted instance boundary).

## 1. One process, one image

```
                     dashboard host (PUBLIC_APP_URL)                  apps origin (*.APPS_DOMAIN + custom domains)
                     ────────────────────────────────                 ─────────────────────────────────────────────
  MCP client  ──►  /mcp  (Streamable HTTP, Bearer)                    <slug>.<APPS_DOMAIN>            published version
  browser     ──►  /     (React Router 7 SSR dashboard)               <slug>--preview.<APPS_DOMAIN>   newest version that compiled
  MCP client  ──►  /oauth/*, /.well-known/*  (OAuth 2.1 AS)           <slug>--v<N>.<APPS_DOMAIN>      exactly version N
  browser     ──►  /api/*    (dashboard JSON API)                     shop.example.org (verified)     published version
                                                                      /__drobek/sdk.js, /__drobek/v1/<module>/…
 ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ caddy: TLS for the dashboard host, *.APPS_DOMAIN and verified custom domains  ──►  drobek:3000                │
 ├──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
 │ drobek — one Node 22 process (apps/server, Express)                                                          │
 │   1. apps-host middleware (@drobek/serving): an app host is answered here and never reaches the dashboard    │
 │   2. origin check (@drobek/auth): mutating dashboard requests from app / null / foreign origins → 403        │
 │   3. /health, /version, /api/internal/tls/ask (internal address only)                                        │
 │   4. /mcp: @drobek/oauth resource server (Bearer → user, scopes, audience) + @drobek/mcp tool bodies          │
 │   5. everything else: React Router (@drobek/dashboard routes, OAuth AS routes, /llms.txt, /report …)         │
 │      behind the body cap: DASHBOARD_MAX_BODY_BYTES → 413 (the CSV import keeps its own limit)                │
 │   in-process jobs (apps/server/server/jobs.ts): blob GC, slug release, domain re-check, audit, files sweep   │
 └──────────────┬───────────────────────────────────────────┬────────────────────────────────┬──────────────────┘
                │ postgres-js + drizzle                     │ ioredis                        │ SMTP (nodemailer) or Resend
          Postgres 17: users, workspaces, apps,       Redis 7: sessions, rate limits,     any SMTP server
          versions + blobs, module data, OAuth,       OTP counters, leases, caches,       (EMAIL_TRANSPORT; Mailpit in dev)
          API keys, domains, abuse, audit             serve-cache + live data pub/sub
```

- **`apps/server`** is the only process: Express with
  `@react-router/express` for the dashboard, `mountMcpResource` for `/mcp` and
  the apps-host middleware in front of everything. There is no worker
  container and no job queue; background work runs on timers inside the
  process, each under a Redis lease so only one replica does it. An error
  nothing caught (`uncaughtException`, `unhandledRejection`) is logged,
  reported and stops the process like `SIGTERM` (requests drain), exit
  code 1 (`installFatalErrorHandlers` in `@drobek/core`).
- **Postgres connections**: two pools per process (`@drobek/db`, shared by
  the dashboard build's bundled copy), `DB_POOL_MAX` each — requests with
  `statement_timeout` (`DB_STATEMENT_TIMEOUT_MS`) and `lock_timeout`
  (`DB_LOCK_TIMEOUT_MS`), background jobs with the lock timeout only;
  migrations use one connection of their own without either. A query cut
  off by a timeout answers `busy` (`reason: "database_timeout"`) over MCP
  and `503 unavailable` on module routes, never the driver's message.
- **One image**, `ghcr.io/freema/drobek` (root `Dockerfile`, targets `dev` and
  `runner`; linux/amd64 releases). The image applies every pending migration
  on start (core journal `__drizzle_migrations_core`, one
  `__drizzle_migrations_mod_<name>` per module) under one Postgres advisory
  lock, so replicas migrate one after the other, and **refuses to start** on a
  database whose journal holds migrations it does not know (a newer release
  migrated it — the message names that release), stored secrets that
  neither `DROBEK_MASTER_KEY` nor `DROBEK_MASTER_KEY_PREVIOUS` opens (a key
  rotation is `task selfhost:rekey`), a
  placeholder secret, a weak `TLS_ASK_TOKEN`, a missing `APPS_DOMAIN` in
  production or a module it cannot load (one from `DROBEK_MODULES_DIR`, the
  `modules_data` volume, whose files no longer match `modules.lock.json`
  included).
- **Feature logic lives in packages**, not in `apps/server`: the server wires
  them together. The main ones:

  | Package | Holds |
  | --- | --- |
  | `@drobek/apps` | apps, globally unique slugs, versions, publish/restore, host classification, single-writer lease, blob GC, takedown, deletion, the public gallery |
  | `@drobek/compile` | the in-process esbuild compiler over an in-memory file map |
  | `@drobek/serving` | the apps-host handler: host → app → version → file, CSP, caches, password gate, TLS `ask` |
  | `@drobek/modules` | the module contract, registry, router, runtime, SDK build, limits provider, end-user sessions |
  | `@drobek/mcp` | the MCP tool bodies; `@drobek/oauth` = OAuth 2.1 AS + MCP resource server + API keys |
  | `@drobek/agent-dx` | the briefing, the tool manifest, limits, error catalogue, `/llms.txt` renderers |
  | `@drobek/dashboard` | the dashboard routes and their server halves |
  | `@drobek/auth`, `@drobek/tenancy`, `@drobek/audit` | dashboard sign-in (e-mail code, Google), sessions, rate limits, origin check; workspaces and roles; the audit log |
  | `@drobek/domains`, `@drobek/email`, `@drobek/insights`, `@drobek/proxy` | custom domains; the one mail transport of the dashboard and the modules (`EMAIL_TRANSPORT=smtp` via nodemailer, `resend` via the Resend HTTP API over `fetch`, or the id of a module's `email.transport` contribution, installed at start); the error beacon and request stats; upstream registry, envelope crypto, SSRF guard |
  | `@drobek/core`, `@drobek/db`, `@drobek/sdk` | env/config, health, logger, the installed error reporter (`reportError`), Caddyfile generator; drizzle schema + migrations; the browser SDK core |
  | `modules/{auth,email,forms,data,proxy,files,sync,oidc,webhooks}` | the built-in platform modules (`drobek-module-<name>`) |
  | `create-drobek-module` | the scaffold for external modules; with `@drobek/modules` + `@drobek/sdk` published to npm as `@freema/drobek-modules` + `@freema/drobek-sdk` from each release tag (`scripts/npm-packages.mjs` bundles the private packages in; modules install them under the `@drobek/*` names via npm aliases) |

## 2. Workspaces, apps and versions

- A **workspace** has members with a role: `workspace-admin`, `editor` or
  `viewer`. Every user has a personal workspace. `SUPERADMIN_EMAIL` (a list)
  names the operator's super-admins; super-admin is an env flag, not a role
  row. Sign-up is open: anyone can create workspaces and build and preview
  apps.
- **Members** of a team workspace join through single-use invites (Redis,
  7 days, indexed per workspace in `drobek:invites:<workspace_id>` so its
  admins list and revoke the pending ones on the Members tab). Workspace
  admins change roles and remove members, any member leaves — on the Members
  tab or over MCP (`list_members`, `set_member_role`, `remove_member`), both
  through `@drobek/tenancy` `members.server.ts`: a workspace always keeps a
  workspace-admin (the change locks the workspace row) and a personal
  workspace's one member never changes. Access is resolved on every request,
  so a removed member is out at once; the leases they held on the
  workspace's apps are released too (also when a member becomes a viewer).
  Every change is audited (`member.role_change`, `member.remove`,
  `member.leave`, `member.invite_revoke`).
- **Deleting a workspace or an account** goes through `@drobek/tenancy`
  `deletion.server.ts`. A workspace admin deletes a team workspace after
  typing its slug (`/workspaces/<slug>/delete`) or over MCP
  (`delete_workspace` with `user_confirmed`): every app is soft-deleted (the
  modules' `onAppDelete` runs, the app hosts drop it) and then purged at once
  like the app purge job does, then the workspace row goes, and its
  memberships, upstreams and module opt-ins go with it through `ON DELETE
  CASCADE`. The row is locked first, and an app created meanwhile restarts the
  pass; the pending invites are dropped from Redis. A user deletes their
  account at `/me/delete` after a fresh e-mailed code (its own OTP scope),
  only there: it deletes the personal workspace and every team workspace they
  are the last member of the same way, leaves the others (releasing their
  edit locks), deletes the `users` row (its API keys and OAuth codes and tokens
  cascade) and every dashboard session (a SCAN over
  `drobek:session:*`). It is refused while the user is the only
  workspace-admin of a team workspace other members use. A member who joins
  one of the team workspaces it deletes meanwhile stops it
  (`workspaces_changed`): the members are counted again before each app is
  deleted or purged and under the row lock before the row goes, so the team
  and its new member stay. Authors stay
  without a name: `app_versions.created_by_user_id`, `audit_log.actor_user_id`
  and `upstreams.created_by` are set null. `audit_log.workspace_id` has no
  foreign key, so a deleted workspace's audit rows stay until the audit
  retention removes them; audited `workspace.delete`, `account.delete` and,
  in each workspace left, `member.leave` with `reason: account_deleted`.
- **Changing the sign-in e-mail** goes through `@drobek/tenancy`
  `email-change.server.ts`, on `/me` only (no MCP tool). The user enters the
  new address and a code goes to it: the sign-in code's guard with the same
  `OTP_*` limits, counted under the scope `email-change`; the code lives
  under `email-change:<user_id>`, so it changes only that account and only to
  that address. An address another account signs in with gets an "already
  has an account" e-mail instead of a code, and the page answers the same, so
  it never tells whether an address has an account. The code changes
  `users.email` under the row lock with `account.email_change` audited in the
  personal workspace in the same transaction, ends every dashboard session
  (the same SCAN) and signs the browser in again, and e-mails a notice to the
  previous address. API keys, OAuth connections, memberships, the personal
  workspace's slug and a linked Google sign-in hang on the user id and stay;
  the previous address now signs in to a new, empty account. What is bound to
  the address follows the new one at once: `SUPERADMIN_EMAIL`
  (`meta.super_admin` records `gained` / `lost`) and a workspace editor's
  admin role in its apps' sign-in (platform module `auth`).
- **Who may publish** (`PUBLISH_APPROVAL`, `open` by default, plus a
  super-admin's per-workspace state `default` / `allowed` / `blocked`,
  `workspaces.publish_approved_at` / `publish_blocked_at`): a super-admin
  publisher is always allowed, a blocked workspace is refused in both modes
  (`publish_blocked`), an allowed one or one with a super-admin member may
  publish, otherwise `open` allows and `approval` refuses
  (`publish_not_approved`, naming `OPERATOR_EMAIL` or the first super-admin,
  recording an approval request and e-mailing the operator at most once per
  24 h). `@drobek/apps` `publish()` checks it inside its transaction, so the
  MCP tool, the dashboard publish and the rollback share one gate.
  Super-admins decide at `/admin/publishing` or with the super-admin-only
  MCP tool `set_workspace_publishing`; blocking and unblocking e-mail the
  workspace's editors and admins. `PUBLISH_NOTIFY` (`first` / `every`)
  e-mails the operator after a publish without holding it up. Everything
  else about an app is never gated.
- An **app** belongs to one workspace and has a **globally unique slug**
  (a host label; `--` is not allowed in a slug, so the preview and version
  host names never collide with another app). `create_app` picks a free slug
  and falls back to `<name>-<4 hex>`. A deleted app keeps its slug for 30
  days, then the slug is released. `APP_PURGE_AFTER_DAYS` (30) after the
  delete the app is deleted for good: its row and every row that references
  it (versions, module data, end users, uploads, domains, assets, logs,
  statistics) go; audit rows stay until their own retention.
- A **version** is an immutable, numbered snapshot of the app's files
  (`app_versions` + `version_files`): the sources the agent wrote AND the
  compiled output, plus who made it, the agent's one-line `reasoning` and the
  compile status. File bytes are content-addressed blobs in Postgres
  (`blobs`, sha256, deduplicated across versions and apps); unreferenced blobs
  are garbage-collected hourly after a 7-day grace period.
- **Publishing** moves one pointer, `apps.published_version_id`, to a version
  that compiled. Rolling production back is publishing an older version.
  `restore_version` rolls the working copy back by writing a NEW version with
  the old files — a version is never changed. There is no git and there are
  no branches.
- **History retention**: an app keeps its newest `APP_VERSIONS_KEEP` versions
  (default 200; a limits provider may set it per workspace). The hourly
  retention job deletes older ones, except the published version, the newest
  version that compiled (the one the preview serves), a version a member
  keeps (`kept_at`, at most `APP_VERSIONS_KEPT_MAX` per app), a version whose
  asset set is kept for a rollback (`assets_frozen_at`), the newest version
  and versions from the last hour (they still count against the version
  rate). A member's clean-up (`deleteVersions`, over MCP `delete_versions`
  after the user's yes: every version up to a number, or only the failed
  builds) leaves the same versions alone — one SQL rule
  serves both. The clean-up deletes only the set it worked out under the
  row lock of its first batch, and refuses (`plan_changed`) when that set's
  fingerprint is not the `plan_id` the user confirmed. Both work app by app under the app's row lock, in batches,
  audit each batch (`app.versions.prune`, a system action; `app.versions.delete`,
  the member — shown in Activity) and bust the serve cache; `version_files`
  go with their version and the blob GC frees the bytes. Version numbers are
  never reused, so a missing number below the
  newest one was deleted: `read_file`, `restore_version` and `publish` answer
  `not_found` with "is no longer stored" and the oldest version still stored.
  `get_app` (`version_retention`) and the dashboard's version history state
  how many versions the app keeps and has; `list_versions` pages the history
  by number (`APP_VERSIONS_PAGE` per page) with the published, preview and
  kept versions pinned, and `keep_version` keeps one. While a configured limits
  provider does not answer for a workspace (`LimitsProvider.settled` → null),
  the job leaves it alone, so the env fallback never deletes history a plan
  keeps.
- **Source quota**: the unique bytes (`version_files` by sha256, sources and
  build output) the versions of a workspace's live apps store may not pass
  `WORKSPACE_SOURCE_QUOTA` (default 1 GiB; per workspace through a limits
  provider; deleted apps do not count, so deleting an app frees its bytes at
  once). `createVersion` checks it after the rate, under the app's row lock and
  a per-workspace advisory lock, before any blob is stored: a version whose
  NEW bytes do not fit answers `limit_exceeded` (`limit`, `value`,
  `used_bytes`). A version that adds no bytes — a restore, a revert — always
  fits. `create_app` and gallery copies check the files ahead of creating the
  app, so a refusal leaves no empty app behind.
- **New versions are rate-limited** (`VERSIONS_PER_APP_HOUR`, default 600 per
  app, and `VERSIONS_PER_USER_HOUR`, 1200 per person across all apps, within
  the last hour; a limits provider may set both per workspace), so a loop of
  writes cannot fill the database. Every way to a version counts — writes,
  `create_app`'s version 1, restores, gallery copies. `createVersion` /
  `restore` count `app_versions` rows inside their transaction under the
  app's row lock and a per-person advisory lock, before any blob is stored;
  the MCP tools repeat the check before the compile and the lease. A refusal
  is `rate_limited` with `retry_after_seconds` (when the oldest version of the
  full window leaves it).
- **The public gallery** (`GALLERY_ENABLED`, off by default): an editor+
  lists a PUBLISHED app with a ≤ 160-character public description
  (`apps.gallery_listed` / `gallery_description`) in the dashboard, or an
  agent does with `set_gallery_listing` and the user's explicit yes
  (`user_confirmed: true`). `GET /api/public/gallery` on the dashboard host
  returns name, description, production URL, `apps.published_at` (set by
  every publish) and `modules` (names with non-empty saved configurations,
  without config values or pending proposals; not a claim of current usage
  or availability), newest first with a cursor or in numbered pages (`?page`,
  with `pages` / `total`), searchable (`?q`, name or description, ignoring case
  and combining accents) and
  sortable by name (`?sort=name`) or popularity (`?sort=popular`: 5 × likes
  + opens in the last 30 days), CORS `*`, cached 60 s — no owner data. Each
  item carries `likes` (`gallery_likes`, one row per app and signed-in
  account, liked on the dashboard page `/gallery/like/<slug>`) and `opens`
  (`gallery_opens`, a count per app and UTC day, raised by the redirect
  `/gallery/open/<slug>` for a GET that is not a prefetch, per-IP limited;
  nothing about the visitor is stored) with their `likeUrl` / `openUrl`. It
  filters at query time (listed, published, public, not taken down, not
  deleted, not hidden by a super-admin); unpublish and takedown also clear
  the flag. With `GALLERY_FRAME_ANCESTORS` the operator's gallery website may
  frame the production host of an app it shows (a live preview): the app
  hosts' resolve row carries `galleryVisible` (the same conditions), and a
  listing change busts the serve cache.
- **Duplicating a gallery app**: the owner opts in with "Allow duplicates"
  (`apps.gallery_allow_duplicate`, off by default, kept while unlisted; the
  agent's `allow_duplicate` rides on the listing's confirmation). Each gallery
  item then also carries `duplicable`, `duplicateUrl` (the dashboard's
  `/duplicate/<slug>`, null when not duplicable) and `duplicates` (live
  copies). The dashboard page (sign-in first, `returnTo` back) and the MCP
  tool `duplicate_app` run the same code: @drobek/apps
  `duplicateAppFiles` copies the PUBLISHED version's files (source and built,
  with its compile status — no recompile) as version 1 of a new, unpublished
  app in a workspace where the person is an editor+, storing
  `apps.duplicated_from_app_id` / `duplicated_from_slug` (the app header
  shows "Duplicated from"); @drobek/modules `duplicateModuleConfigs` then
  proposes the source's saved module configs through the copy's normal
  `configure` path, so a change that needs confirmation waits on the copy's
  Modules page. The whole `proxy` config (upstreams of the source workspace)
  and every value holding an e-mail address are dropped; secrets, pending
  proposals, data, end users, uploads, app assets (stored per app on disk),
  domains and the listing are never copied. Audited as `app.duplicate` in
  the target workspace and `app.duplicated` in the source's (without the
  copier); `DUPLICATES_PER_USER_HOUR` (default 10) caps copies per person,
  counted from those audit rows.
- **One writer at a time**: a write takes the app's Redis lease
  (`drobek:applock:<app_id>`, 3 minutes, renewed per write). Another user's
  agent gets `app_locked`; the same user's other sessions take the lease over.
  `release_lease` frees the caller's own lease early; the dashboard's unlock
  frees anyone's (both audited `app.lock.release`).

## 3. The compile step

`write_files` (1–20 changes) → apply them to the latest version (whole
files, deletions, and exact-string `edits`; a call with edits is stored only
on top of the version it was applied to and re-applied when the same user's
other session stored one in between) → validate the paths and limits → scan for
secrets (a hit refuses the write and stores nothing) → compile → store the new
version (also when the compile failed, so no work is lost) → notify the serve
cache. The compile result is part of the tool response.

- `@drobek/compile` runs esbuild **in-process** (`context()` + `rebuild()`)
  over an in-memory file map. A virtual-filesystem plugin resolves relative
  imports only inside that map — **never the disk**. Bare imports resolve
  only through the app's `drobek.json` import map to pinned `https://` URLs
  (esm.sh), marked external: the browser loads them, the server never fetches
  them. `drobek` maps to the platform SDK (`/__drobek/sdk.js`);
  `drobek/<module>` imports inline module components (compiled with the
  app's own React).
- `src/main.{tsx,ts,jsx,js}` → `/main.js`, the CSS it imports → `/main.css`,
  `drobek.json` `entries` → more bundles. An app without `src/main.*` is plain
  HTML served as written. The compiler prepends the beacon import to every
  JS entry (`"beacon": false` opts out): each page reports its load and its
  browser errors, failed resource loads and CSP blocks with the version it
  was served from (`get_app` `render`, `get_logs` runtime).
- Limits (`COMPILE_*`): 200 files, 512 KiB per file, 5 MiB per version, an
  import depth of 50, 10 s per build (cancelled with its own `ctx.cancel()`),
  4 builds at once and a FIFO queue whose wait answers `busy`.
- **The server never executes app code** — not at compile time (the esbuild
  plugins are drobek's, not the author's), not to render, not to test. What it
  produces is served to browsers and runs there only.

## 4. Origins and hosts

| Origin | Serves | Never |
| --- | --- | --- |
| dashboard host (`PUBLIC_APP_URL`) | dashboard, dashboard API, OAuth AS, `/mcp`, `/llms.txt`, `/report` | any app file or app JavaScript |
| `<slug>.<APPS_DOMAIN>` | the published version (indexable) | the dashboard session cookie is never read here |
| `<slug>--preview.<APPS_DOMAIN>` | the newest version that compiled (`noindex`) | |
| `<slug>--v<N>.<APPS_DOMAIN>` | exactly version N (`noindex`) | |
| a verified custom domain | the published version (indexable) | |

- `APPS_DOMAIN` should be a **different registrable domain** from the
  dashboard's (cookies, the Public Suffix List, phishing optics); every app is
  its own origin, so apps are isolated from each other and from the dashboard
  by the browser's same-origin policy.
- Host classification (`@drobek/apps` `classifyHost`) is shared by serving,
  the origin check and the TLS `ask`. An unknown foreign host is the
  dashboard's (and 404s there); a registered but unverified custom domain
  answers 404 on the apps side.
- A **custom domain** is a CNAME (or ALIAS / matching A/AAAA at an apex) to
  `<slug>.<APPS_DOMAIN>` plus a TXT record `_drobek.<host>`; verified names are
  re-checked daily and lose their verification on a definitive DNS failure.
  One domain can be **primary**: the production host then answers 302 to it.
- Dev: `APPS_DOMAIN=apps.localhost:3041` — browsers resolve `*.localhost` to
  loopback, so there is nothing to put in `/etc/hosts`.

## 5. Serving

`@drobek/serving` answers every app-host request in a fixed order, each step
before any byte of the app is touched:

1. method: GET/HEAD (plus the password-unlock POST); else **405**;
2. `/.well-known/drobek-report` → the report pointer (works for any host);
3. the unknown-host limiter: a client IP past `APPS_UNKNOWN_HOST_LIMIT`
   "no app here" answers per window gets **429** (without a lookup for hosts
   the cache does not know as live apps — for a version host, that very
   version);
4. the app lookup — a miss is a counted **404** page; a version host whose
   version does not exist or did not compile counts against the same budget
   (its 404 follows at step 10). Misses (unknown slugs and missing versions)
   are kept in a separate negative cache for 30 s, hits in the positive cache
   for 60 s; both are capped (LRU over every host of every app) and drop
   expired entries, so no range of `--v<N>` numbers grows the process;
5. `X-Drobek-App: <slug>` on every response from here on;
6. a taken-down app: **451** on every host and path (JSON 451 on platform
   paths), before the redirect, the password gate and the modules;
7. the primary-domain **302** (production host, GET/HEAD page requests);
8. visibility: a `password` app shows the password page (**401**) until the
   host-only `__Host-drobek_app_access` cookie (HMAC, key derived from
   `DROBEK_MASTER_KEY`) is set;
9. `/__drobek/*`: the SDK, the module routes and the beacon — handed to the
   module runtime, never to the app's files;
10. the version the host serves (**404** "not published" / "nothing compiled"),
    then the file: built output wins over sources, `.ts/.tsx/.jsx` sources and
    `drobek.json` are never served, extension-less paths fall back to
    `index.html`, `ETag` = sha256 → **304**; an HTML response names its
    version in `Server-Timing: drobek-version;desc="<N>"` (the beacon reads
    it). Every JS/CSS bundle is stored
    with an inline source map; the preview and version hosts serve it as
    stored, while the production host and custom domains serve the code
    without it (ending in `sourceMappingURL=<file>.map`) and answer
    `/<file>.map` with the map, split at serve time and cached — browsers
    fetch it only when devtools opens;
11. no such file: the app's **asset** at that path, if any (see below).

**Assets** (video, audio, images, fonts) share the app's URL space: the
asset `img/s1.jpg` answers `/img/s1.jpg`, so a page keeps its own relative
paths (`<video src="film.mp4" poster="poster.jpg">`). The app's own file at
the same path wins; an asset path always has a media extension, so the SPA
fallback never swallows one. Assets honour publish: `app_assets` is the
**draft** — uploads, replacements and deletes change only it, and the preview
host serves it; `publish` freezes a set for the version it puts live
(`app_version_assets`, `app_versions.assets_frozen_at`) and the production
host and custom domains serve only the live version's set; a version host
serves its version's set, or the draft when it was never published.
Publishing the newest version that compiled freezes the draft; publishing an
older one (the rollback) keeps the set it had when it was last live;
`restore_version` of a published version resets the draft to its set. The
bytes live on disk under `ASSETS_DIR` (`/data/assets/<app_id>/<sha256>` —
content-addressed and never rewritten, so the draft and any number of sets
share a file; files from before this keep a random key; the `assets_data`
volume). `APP_ASSETS_QUOTA` counts unique files: what the draft and the live
set need must fit; the sets of up to ten earlier publishes are kept for a
rollback while they fit besides, the oldest dropped first.
Serving: the sniffed `Content-Type`, `Accept-Ranges: bytes`, one byte range
→ **206** (`Content-Range`) or **416**, `ETag` (sha256) / `Last-Modified` →
**304**, `If-Range`, HEAD; `public, max-age=300, must-revalidate` on the
published and custom hosts, revalidate-always on preview and version hosts,
`private` for a password app; SVG as an attachment with a second CSP
`sandbox`. Takedown, the password gate and "not published" answer first,
like for any file.

Uploading never goes through MCP or the model: `create_asset_upload` (or the
dashboard's Assets tab) checks the path, the declared size and type, the
quota and the hourly budget, then mints a **single-use upload URL** on the
dashboard host — `PUT /api/assets/upload/<token>`, 32 random bytes, only
its sha256 stored in Redis for 30 minutes, bound to the app, the path, the
size, the type family and the user who asked (the upload is audited as
theirs). The PUT takes the token before reading a byte, streams the body to
a temp file while it counts (over `APP_ASSET_MAX_BYTES` or past the declared
size → stop), hashes and sniffs it (png, jpeg, gif, webp, avif, ico, svg, mp4, webm,
m4a, mp3, ogg, wav, woff, woff2 — the bytes decide, never the name), renames
it into place under its sha256, and writes the draft row under a per-app
advisory lock that re-checks `APP_ASSETS_QUOTA` — and that the user the URL
was issued for is still an editor of the app. A browser GET on the URL shows
a small upload page (strict CSP, the token never in the page). A delete or
replace removes a file nothing references any more; an hourly sweep removes
the assets of apps deleted 24 h ago, stale temp files and files neither the
draft nor a kept set references.

Every response carries the app CSP (`default-src 'self'`, scripts from the app
and `https://esm.sh`, `connect-src 'self' https://esm.sh`, images, fonts,
styles and `media-src` (`<video>`, `<audio>`) from the app, `blob:` or any
https URL, `frame-src` only the curated embeds — YouTube
(`www.youtube-nocookie.com`, `www.youtube.com`), `player.vimeo.com`,
`drive.google.com` — plus the operator's `APP_FRAME_SRC_EXTRA`,
`frame-ancestors` = the dashboard origin only, plus the origins the owner
set in `apps.frame_ancestors`, plus — on the production host and custom
domains of an app the public gallery shows, never on preview or version
hosts — the operator's `GALLERY_FRAME_ANCESTORS`; the dashboard frames an app
solely for the app-list thumbnail, the gallery for its live preview, see
[`SECURITY.md`](./SECURITY.md)),
`nosniff` and `Referrer-Policy: no-referrer`; preview and version hosts add
`X-Robots-Tag: noindex`. Bytes come from a 256 MiB in-memory LRU; the host
and manifest caches are busted through a local event emitter first and Redis
pub/sub (`drobek:app-changed`) for other replicas, so a write is visible on
its preview host at once.

## 6. Platform modules

A module is an npm package whose default export comes from `defineModule()`
(`@drobek/modules`, contract `1.3.0`; a module states the versions it works
with in `contract`, e.g. `'^1.1'`, and one this server does not satisfy
refuses the start). The operator enables modules with `DROBEK_MODULES`; a
short name `x` loads `drobek-module-x` (which must export the module `x`), a
full package name may replace a built-in. Each entry is looked up first in
`DROBEK_MODULES_DIR` (the `modules_data` volume: modules installed without a
new image, each listed with its integrity in `modules.lock.json`, given the
server's own `@drobek/*` / `zod` / `drizzle-orm` through a `node:module`
resolve hook, migrations linted to `mod_<name>[_*]`), then among the server's
dependencies; `/healthz` and `/api/version` list the active modules with
their source (`dir` | `builtin`). A module contributes routes under
`/__drobek/v1/<name>/…` on every app host, a slice of the browser SDK
(`drobek.<name>`), a zod per-app config schema (its defaults overridable per
server with `DROBEK_MODULE_<NAME>_DEFAULTS`), access rules, secrets (names
only), env-named limits, its own error codes, its own tables and migrations,
and a skill the agent reads with `skill_info` — left out only by an
operator-only module, of which nothing reaches apps (it contributes to
`operatorOnly` slots such as `errors.reporter` and `email.transport`): agents
and app owners never see it, `/api/version` marks it `operatorOnly`.
Modules extend each other through typed **slots**: a host module declares
one with a zod schema, other modules contribute values, checked at start and
read with `contributions(slot)` (a host may `compose` its config schema,
confirm rules and secrets from the contributions at start). Core itself hosts one
slot, `errors.reporter`: where server errors go besides the log (an incident
webhook, a log service, …), chosen with `ERROR_REPORTER=<id>` and fed by `reportError`
(`@drobek/core`) from the central error points — a 5xx, a module route
throw, a failed module job or e-mail send, a start-up failure, an error
nothing caught. Built in: `auth`
(end-user sign-in by e-mailed code, plus the sign-in providers other
modules contribute to its `auth.provider` slot, and the `auth.signedIn`
observers told of every sign-in), `email` (notifications to the app's owners,
and the `email.transport` slot for e-mail providers other modules contribute,
chosen with `EMAIL_TRANSPORT=<id>`), `forms`, `data`
(collections with per-operation rules), `proxy` (external APIs with the
secret injected server-side), `files` (end-user uploads), `sync` (a data
collection filled from an external API on a schedule) and `oidc` (company
sign-in with any OpenID Connect provider, an `auth.provider`). The examples
`hello` (a dependency of `apps/server`) and the opt-in `acmecrm` (installed
into `DROBEK_MODULES_DIR`) are loaded exactly as third-party modules are. The contract is
[`MODULES.md`](./MODULES.md).

- **Core resolves the caller** before a module sees the request: the
  end-user session (`drobek_eu`, host-only on the app host, epoch per app) →
  `ctx.principal` = anonymous, an end user with a role, or an app admin. The
  dashboard session never exists on the apps origin. Mutating module calls
  need the app's own origin and `X-Drobek-SDK: 1` (`csrf_rejected`).
- **Sign-in providers** (OIDC, SAML, … as modules) never share a cookie
  between hosts: the app host starts the sign-in (`begin`: a state HMAC'd
  under `DROBEK_MASTER_KEY`, PKCE, a flow cookie), the IdP calls back the ONE
  redirect URI on the dashboard host (`/__drobek/auth/callback/<id>`, routed
  to the `endUsers` authority's `callback`), which issues a 60-second
  handoff code bound to the app host; `complete` on the app host redeems it
  and sets the host-only session. The dashboard session is never touched.
  A provider account is (provider, issuer, subject) in `mod_auth_identities`,
  bound to one local user; the provider's identity config is bound into the
  flow and the session.
- **Configuration** comes from the agent (`configure_module`, a JSON merge
  patch validated by the module's schema) or the dashboard form. A change the
  module's `confirmRequired` names — opening a rule to `public`, a new
  recipient, giving an app an upstream — is stored as **pending** and waits
  for the owner on the dashboard's Modules tab (the tool returns
  `confirm_url`; the owners get one e-mail per app per hour). Items marked
  `confirmRole: 'admin'` (every proxy change) can only be confirmed by a
  workspace admin. **Secrets never pass through MCP**: they are set
  write-only in the dashboard and stored AES-256-GCM envelope-encrypted under
  `DROBEK_MASTER_KEY`.
- **Limits** are env numbers with defaults; `LIMITS_PROVIDER_URL` (+ an HMAC
  secret) lets an operator with plans answer them per workspace
  (`GET /limits/<workspace_id>`, cached 60 s; an outage falls back to the env
  values). Module e-mail also passes the operator-wide mail guard (hourly
  budgets per class and per app, pause + ALERT line).
- **Live data**: the data module's store publishes every committed record
  write (whoever wrote it: the app, MCP, the dashboard, a sync import) to a
  Redis pub/sub channel per app + collection and a short Redis stream (the
  resume backlog); each process relays the channel to its open
  `GET /__drobek/v1/data/<collection>/events` streams (`text/event-stream`,
  `drobek.data.subscribe`), checking the collection's read rule and the
  caller again for every event. The graceful stop ends these streams first
  (`endModuleStreams`, next to the MCP listen streams), so the drain does
  not wait on them ([`MODULES.md`](./MODULES.md#the-built-in-data-module)).
- **Opt-in modules** (`availability: 'opt-in'`) are active only for the
  workspaces they are enabled for: by the limits provider's plan
  (`MODULE_ENABLED_<NAME>`: `1` on, `0` off — it wins), by the env value
  `MODULE_ENABLED_<NAME>=1` (every workspace), or by a super-admin's switch
  on the dashboard's Workspace → Modules page or their agent's
  `set_workspace_module` (`workspace_modules`, audited).
  Elsewhere their routes answer `404 module_not_enabled`, `configure_module`
  refuses, `get_app` shows `enabled: false` and the app's skills leave them
  out; the SDK stays one bundle per server.

## 7. TLS

Caddy runs next to drobek (`docker-compose.production.yaml`) and terminates
TLS; drobek speaks plain HTTP on the internal network and trusts only
Caddy's `X-Real-IP` (`TRUST_PROXY=x-real-ip`). The Caddyfile is **generated**
from the environment (`@drobek/core` `caddy.ts`, `task selfhost:init` /
`task caddy:config`) and contains no secrets. The dashboard host gets a
normal ACME certificate; the app hosts use exactly one of three paths:

- **(a) wildcard certificate files** the operator obtains and renews
  (`task tls:reload` after each renewal);
- **(b) ACME DNS-01** through a Caddy DNS module (a custom Caddy build), with
  optional `_acme-challenge` CNAME delegation;
- **(c) on-demand**, one certificate per app host, always gated by drobek's
  `ask` endpoint (`/api/internal/tls/ask`, internal address + `TLS_ASK_TOKEN`
  only): 200 for the production or preview host of a live app, for a
  version host whose version exists and compiled, and for a verified custom
  domain; 404 for everything else, so no `--v<N>` number the app does not
  have can order a certificate.

Verified custom domains get their certificates from an on-demand catch-all
behind the same `ask` (on by default in mode (c), `TLS_CUSTOM_DOMAINS`).
`tls internal` (Caddy's local CA) serves a test box and `task dev:tls`.
Caddy also compresses text responses (`encode zstd gzip`, `200` only, an
explicit type list without `text/event-stream`, so `/mcp` SSE is not
buffered); drobek itself never compresses. On the dashboard site Caddy refuses
a request body over `DASHBOARD_MAX_BODY_BYTES` (`request_body`, 413) except on
the paths drobek caps with their own limits (`/mcp`, the asset upload URLs, the
Data tab's CSV import); drobek applies the same cap itself in front of React
Router (`@drobek/core` `withBodyLimit`), counting a chunked body as it arrives.
Details: [`SELF-HOSTING.md` → TLS](./SELF-HOSTING.md#tls).

## 8. Background jobs

All in-process (`apps/server/server/jobs.ts`), started with the server.
They query through a Postgres pool of their own (`runAsJob` in `@drobek/db`)
without the requests' `DB_STATEMENT_TIMEOUT_MS`, so a long sweep never
takes a connection a request waits for and is not cut off like a request's
query:

| Job | Interval | What |
| --- | --- | --- |
| version retention | hourly, Redis lease | deletes the versions of each app past its workspace's `APP_VERSIONS_KEEP` (200) — never the published one, the one the preview serves, a kept one, a rollback set or the last hour's; skips a workspace whose limits provider does not answer (`@drobek/apps`) |
| blob GC | hourly, Redis lease | deletes blobs no version references, after 7 days |
| slug release | hourly, Redis lease | a soft-deleted app's slug is free again after 30 days |
| app purge | `APP_PURGE_INTERVAL_MS` (1 h), Redis lease | deletes an app deleted `APP_PURGE_AFTER_DAYS` (30) ago for good, one app per transaction: the `apps` row and through `ON DELETE CASCADE` its versions (their blobs go with the blob GC), module configs and secrets, domains, asset rows, gallery likes and opens, logs and statistics, and the module tables (records, form submissions, end users and identities, uploads, sync state); abuse reports and duplicates keep their rows without the reference; its id leaves `upstreams.allowed_app_ids`, its asset directory and end-user sessions go; audited `app.purge`. An app a foreign key without `ON DELETE` holds is logged and retried every run (`@drobek/apps`) |
| domain re-check | `DOMAINS_RECHECK_INTERVAL_MS` (1 h), Redis lease | re-verifies domains checked more than 24 h ago; unverifies + mails on a definitive failure |
| files sweep (only with the `files` module) | `FILES_SWEEP_INTERVAL_MS` (1 h), Redis lease | removes the uploads of apps deleted `FILES_SWEEP_RETENTION_MS` (24 h) ago, stale temp uploads and blobs no `mod_files` row references (`drobek-module-files`) |
| assets sweep | hourly, Redis lease | removes the asset files and rows of apps deleted 24 h ago, stale temp uploads and files neither the draft (`app_assets`) nor a kept published set (`app_version_assets`) references (`@drobek/apps`) |
| logs prune | `LOGS_PRUNE_INTERVAL_MS` (1 h), Redis lease | removes `get_logs` rows past their retention for every app: browser errors older than 30 days or past the newest 500 per app, compiles and daily request stats older than 30 days (`@drobek/insights`) |
| module jobs (only when an active module declares `jobs`) | each job's own interval (checked every 15 s), a Redis lease per run | the modules' scheduled work, for the server or for each app that configured the module; at most `MODULE_JOBS_CONCURRENCY` (4) runs per process, each cut off at `MODULE_JOBS_TIMEOUT_MS` (5 min); a failed run retries with backoff and an app's failure shows in its `get_logs` runtime; `MODULE_JOBS_ENABLED=0` = none on this process (`@drobek/modules`, [`MODULES.md`](./MODULES.md#scheduled-jobs-jobs)) |
| audit retention | at start, then daily | deletes audit rows older than `AUDIT_RETENTION_DAYS` (365) — the only deletion of audit rows anywhere |
| retention prune | at start, then daily, Redis lease | deletes OAuth access and refresh tokens 7 days after they expired (a rotated refresh token stays until then, so reuse detection still sees it) and authorization codes 37 days after (when the lineage a code minted has expired as well, so a replayed code revokes it as long as it exists) (`@drobek/oauth`); gallery open counts of days older than the 30-day `opens` window plus 7 days; abuse reports resolved more than `ABUSE_REPORTS_RETENTION_DAYS` (365) ago — open reports stay (`@drobek/apps`) |

Request counters for `get_logs('requests')` accumulate in Redis and are
flushed into Postgres on read (the whole window in one pipelined round trip)
and at most once a minute per app and day; reads never delete. A flush never
lowers a stored day: each count, and each path's 404 count, keeps the larger
of the stored and the flushed value, so counters that restart after a Redis
flush cannot shrink a day already in Postgres. The paths of
failing requests are counted per app and UTC day, path only (no query, at
most 100 distinct per class, the rest as `__other__`): a missing file's path
is stored with the daily stats, a platform 4xx's or a 5xx's stays in Redis
for the 30-day window.

## 9. Agents, the dashboard and abuse

- **MCP** (`/mcp`, Streamable HTTP): OAuth 2.1 with PKCE, Client ID Metadata
  Documents or Dynamic Client Registration, RFC 8707 audience, RFC 9207
  `iss`, rotating refresh tokens (each access token records the refresh token
  it came with; a rotated refresh token sent again within 60 s is a retry
  that gets a fresh pair, later it is reuse and revokes that lineage only —
  `packages/oauth/src/tokens.server.ts`); or a personal `drk_` API key. A grant is
  bound to the **user** (every workspace they belong to) with the scopes
  `read`, `write`, `publish`; the scope decides which tools exist, the role in
  the app's workspace decides each call. Sessions live in the process
  (`packages/oauth/src/resource/mcp.ts`), bound to the user, scope and grant
  that opened them; one is closed after `MCP_SESSION_IDLE_TTL_MS` without a
  request, when its user opens more than `MCP_SESSIONS_PER_USER` (the least
  recently used goes), or when its API key or OAuth connection is revoked —
  the client then gets 404 for its id and initializes a new session. The tools,
  the contract and the briefing are in [`AGENT.md`](./AGENT.md).
- **The dashboard** (core, AGPL): sign-in by e-mail code (Google optional),
  workspaces (Apps / Members / Activity / Upstreams tabs), apps with Overview
  / Files / Assets / Data / Modules / Forms / Users / Uploads / Logs /
  Domains / Settings tabs (Assets: list, upload with a progress bar, delete —
  the same checks and upload URL as `create_asset_upload`), version history and publish (the Overview tab lists the live, preview
  and kept versions on their own, pages the rest by `APP_VERSIONS_PAGE` with runs of failed builds collapsed, and offers
  Keep / Unkeep and a clean-up whose confirm panel shows what goes and why the rest stays), activity (the audit log, CSV),
  API keys and OAuth connections, the super-admin abuse queue. Every page
  shares one layout (`@drobek/tenancy/layout`: one width, a breadcrumb
  `Workspaces › <workspace> › <app> › <section>`, one set of form controls);
  every app page shows the app header and its tabs. The workspace app list
  shows each app as a small sandboxed iframe thumbnail. The footer names the
  release, the commit (the AGPL source link) and the repository's GitHub
  stars (fetched server-side, cached 1 h, `DASHBOARD_GITHUB_STARS=off`
  disables it). After an update to a new release line (`major.minor` of
  `DROBEK_VERSION`) a signed-in person sees a dismissible "drobek was updated
  · What's new" notice above every page; `/whats-new` (public) redirects to
  the GitHub release of the running version, the dismissal is a cookie per
  line, and `WHATS_NEW_BANNER=0` turns the notice off. All dashboard cookies
  are `__Host-` in production.
- **Abuse**: every app host points at the public report form; super-admins
  take an app down (unpublish + lock → 451 everywhere, every write refused
  with `app_locked_by_admin`) and restore it; a publish heuristic flags
  password-field + brand-name pages into the queue without blocking; the
  same queue lists the gallery entries, which a super-admin can hide.
