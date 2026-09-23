# drobek — Deployment-First Roadmap

> Produced by an 8-agent workflow (4 drafters → 3 adversarial critics → synthesis), 2026-06-30. Critique folded in; raw critiques in ROADMAP-critique.md.

## ✅ Ratified decisions (2026-06-30, owner)

- **D1 hostname → APEX `drobek.app`** (+ `mcp.drobek.app`). **Reuse the existing kept cert** (SAN already = drobek.app + www + mcp.drobek.app → no new cert) by replacing the apex→tomasgrasl redirect with the real app; **`noindex` during beta**. Accepts drobek.app is publicly the WIP. *(Owner overrode the beta-subdomain rec — acceptable: cert is valid, so churn shows plain 502s, not cert errors.)*
- **D2 object storage → NO MinIO.** Blobs via a **pluggable blob-store interface, default = local disk** (content-hash files) + a drobek **signed upload endpoint** (agent PUTs out-of-band to drobek, not S3). Keeps the box light. S3/R2 adapter optional later for scale/large binaries. *(Reconciles R1/D2 — the roadmap over-specified object storage; local disk suffices for small static apps.)*
- **D3 health → adopted:** `{ok,db,redis}` + 503-on-down + `/api/version{sha}`; MCP `/health`.
- **D4 migrations → adopted:** two drizzle journals (`_core`/`_web`), two passes, one DB.
- **D5 done/cadence → WIP=1 vertical slices** (no "all-at-once"); **foundation = M0 + all of M1**; M2/M3 may lag. Skeleton→prod 6–10 wk; M1 ~9–14 mo solo (accepted). Linear re-cut into M0/M1a/M1b/M1c.
- **DNS for the future wildcard = Hostinger** (`*.dns-parking.com`) → DNS-01 via Hostinger API.

---

# drobek — Deployment-First Roadmap (Final)

## 0. Feasibility verdict (honest)

**Can a solo dev build this? Yes — but not the way it's currently framed.** You have already shipped ~70% of the hardest pattern: puls-mcp is React-Router-v7 SSR + an MCP server + shared-postgres/redis + GHCR + SSH-pull deploy + auto-rollback — which is exactly drobek's M1a spine. The capability is proven on the box right now.

**What is NOT achievable is the literal framing** "all ~45 tickets Done at once, no half-done, every part e2e on local+prod, solo." That reading is a deadlock: if everything must be perfect simultaneously, nothing ships, and you stall around ticket ~15. The owner's "no half-done" rule is *gold per vertical slice* and *poison applied to all 45 at once*.

**Realistic shape:** drobek is effectively four products (deploy agent + data API + SDK + dashboard) plus a private SaaS shell. Honest effort:

| Slice | Est. (focused dev-weeks) |
|---|---|
| Phase 0 walking skeleton (both repos to prod, real wiring) | **6–10 weeks** (not days) |
| M1a (auth + OAuth2.1 AS + deploy pipeline + serving + dashboard) | 6–9 |
| M1b (data API + record_* CRUD) | 3–4 |
| M1c (SDK + end-user auth + wildcard TLS) | 4–6 |
| M2 (runtime data API + proxy) | 4–6 |
| M3 (dashboard + business modules) | 6–10 |
| Two-repo/e2e/security tax | 4–6 |

**≈ 27–41 dev-weeks ≈ 9–14 calendar months** solo (life, ops, context-switching included). Communicate the *calendar* figure or week-6 will feel like failure.

**The resolution that keeps every owner principle:** redefine "done" at the **vertical slice**, enforce **WIP=1** (exactly one slice in flight), cut M3 business modules out of "the foundation," and tier the e2e gate. Same rules, a plan that finishes.

---

## 1. Five values that MUST be locked before Phase 0 (the drafts disagree; pick now)

The four drafts contradict each other on five load-bearing facts. Each disagreement is a multi-day mid-flight stall. **Decide these in writing before a line of code.**

| # | Decision | Recommended answer | Why |
|---|---|---|---|
| **D1** | **Prod-beta hostname** | ✅ RATIFIED: **apex `drobek.app` + `mcp.drobek.app`**, **reuse the existing kept cert** (SAN already = apex+www+mcp → no new cert), replace the apex→tomasgrasl redirect, `noindex` during beta | Owner accepts apex is publicly the WIP. ⚠️ Apex same-origin = admin-takeover with untrusted authors → accepted **single-user M0/M1a only**; move dashboard to `app.drobek.app` before multi-tenant (PHY-98). ⚠️ The existing `drobek-redirect.conf` 301 is cached indefinitely → de-poison (`no-store`) before cutover. |
| **D2** | **Blob storage** | ✅ RATIFIED: **NO MinIO.** `BlobStore` interface, default **local disk** (content-hash files) + drobek **signed-upload endpoint** (agent PUTs out-of-band to drobek; server **stream-hashes + verifies sha**). **Persistent volume** `drobek_blobs` in the deploy compose. `S3BlobStore` adapter optional later. | Local disk needs zero extra infra (the box already uses local volumes, e.g. `pixelden_uploads_data`); object storage was over-engineering for small static files. ⚠️ puls compose is stateless → without the volume every deploy wipes apps. GC/refcount = PHY-101/PHY-80. |
| **D3** | **Health contract** | `/healthz` returns `{ok, db, redis}` via a real `runHealthChecks()` (pg + redis ping, **503 on down**); ship `/api/version` returning `{sha}` | The drafts' toy `coreHealth()` returns `{ok, core}` and always 200 — so (a) the first ported puls spec red-fails by construction, and (b) the endpoint meant to *prove the pg/redis wiring* touches neither. MCP health path is `/health`, **not** `/healthz` (SEQUENCE curls the wrong path). |
| **D4** | **Private-schema migration model** | Core owns core tables with journal `__drizzle_migrations_core`; drobek-web owns a **second** migrations folder + journal `__drizzle_migrations_web`; deploy runs **two** `db:migrate` passes against the one `drobek` DB | Schema lives in the **public AGPL** core, but drobek-web's reason to exist is *private* tables (billing/tiers/feedback/notifications). They can't go in core (leaks business model) and can't share one drizzle journal (collision). This is the integration risk the foundation claims to de-risk — yet the skeleton's `coreHealth()` re-export exercises none of it. |
| **D5** | **Definition of "done" + Linear mapping** | WIP=1 vertical slices. Either re-cut Linear into slice-shaped tickets, or accept **in writing** that horizontal tickets advance fractionally | The plan ships vertical slices; Linear tracks horizontal tickets (each slice "advances PHY-53/70/71/76…"). Unreconciled, the board reads *perpetually half-done* — the owner's stated nightmare. Also: M1a/M1b/M1c are **not** Linear milestones (only M1/M2/M3 exist) and PHY-55 is misfiled under M2. Reconcile before relying on the per-part "update Linear" gate. |

---

## 2. Two-repo integration model (locked)

**git submodule + pnpm `workspace:*`** — chosen over changesets/private-npm (too much ceremony for a solo day-1 skeleton; puls itself uses `workspace:*`) and over single-repo (impossible — two repos required: public AGPL core + private SaaS).

```
freema/drobek (public)          freema/drobek-web (private, runs on VPS)
├─ apps/{web,mcp-server}        ├─ core/  ← submodule → freema/drobek (pinned SHA)
├─ packages/{db,core,sdk}       ├─ apps/{web,mcp-server}  (import @drobek/*)
├─ tests-e2e/                   ├─ packages/{billing,...} (PRIVATE tables, own migrations)
└─ pnpm-workspace.yaml          ├─ tests-e2e/   ← workspace member (don't omit)
                                └─ pnpm-workspace.yaml: ['apps/*','packages/*','core/packages/*','tests-e2e']
```

**Fixes folded in from the integration critique (these break the "copy puls verbatim" claims):**

- **Submodule bump is NOT just `git submodule update --init`.** Ship a scripted `drobek:bump-core` command: move submodule SHA → `pnpm install` to regenerate the **private** lockfile → fail loudly if `--frozen-lockfile` would drift → commit lock in the same commit. Add a CI check gating lockfile-vs-submodule sync. Without this, the first core edit breaks every `--frozen-lockfile` install (build, typecheck, migrate) in CI.
- **Prod Dockerfile is real surgery, not a one-line edit.** It must `COPY core ./core` before install, individually `COPY core/packages/*/package.json` AND `packages/*/package.json` across all 4 stages (deps/builder/prod-deps/runner), and the build context must contain the populated submodule (`actions/checkout` with `submodules: recursive` for the *build*, not just git). Don't `.dockerignore` `core/`.
- **GHCR naming/visibility.** The public repo must NOT push a package named `drobek-web` (collides with the private repo of that exact name). Publish self-host images as `drobek-selfhost-{web,mcp}` (**public** visibility, so `docker compose up` pulls without auth) and SaaS images as `drobek-saas-{web,mcp}` (**private**). New GHCR packages are private by default — set visibility explicitly or self-host bring-up silently 401s.
- **The private build is the ONLY real integration gate.** Public CI builds `apps/web` from its own source; prod runs `drobek-saas-web` built from core-as-source. "Both repos build → integrated" is false confidence. Acceptance = a private-repo integration smoke that imports + executes core (the `/private` route) inside the **prod** `drobek-saas-web` image.
- **"SHA = versioned" caveat:** two lockfiles (core's own + web's) can resolve the same `core/packages/*` to different transitive trees. Migration to changesets-published `@drobek/*` is deferred net-new work — accept that, don't pretend it's free.

---

## 3. Phase 0 — Walking skeleton (deploy BOTH repos to prod-beta before any feature)

**Goal:** one thread runs end-to-end — local docker dev → both repos build & integrate → GHCR → live on VPS over TLS → drizzle migrate (core **and** private) → `@smoke` green on local AND `drobek.app`. Mirror the proven puls pipeline; apply the five locked decisions.

### P0-A · Core repo scaffold
pnpm workspace mirroring puls: `apps/web` (RR7), `apps/mcp-server`, `packages/{db,core,sdk}`; Drizzle + drizzle-kit + postgres.js in `packages/db` with journal `__drizzle_migrations_core`; **real** `/healthz` (`{ok,db,redis}`, 503 on down) + `/api/version` (`{sha}`); dev + prod Dockerfiles; dev `docker-compose.yml` (web+mcp+pg+redis, **anonymous volume on `/repo/node_modules`** so bind mounts don't clobber pnpm symlinks — define the dev `apps/web/Dockerfile` the drafts reference but never wrote); `.env.example`; `docs/ARCHITECTURE.md` encoding the five decisions.
- **e2e (local):** `docker compose up` → web `200 /healthz` with `db:up,redis:up`, mcp `200 /health`, `/api/version` returns a sha, migrate clean, console clean in chrome-devtools.
- **Tickets:** PHY-60, PHY-77, PHY-70, PHY-73, PHY-61; ratifies PHY-52/56/74.

### P0-B · Blob store wired (D2 — local disk, no MinIO)
`BlobStore` interface with a `LocalDiskBlobStore` default → **persistent volume** `drobek_blobs` (`/data/blobs/<ab>/<sha256>`) mounted into web+worker+mcp. Drobek **signed-upload endpoint** (`PUT /__upload/<hmac-token>`) that **stream-hashes the body + verifies the sha**. Backups/GC = M2 (PHY-80/101).
- **e2e (local+prod):** one signed PUT + GET round-trip; a tampered body (sha mismatch) is **rejected**. This is the ground U6 stands on.

### P0-C · Private repo scaffold + integration proof (the real one)
Submodule core, workspace globs `core/packages/*`, `apps/web` importing `@drobek/core` (`/healthz` re-exports core health + `edition:'saas'`; `/private` renders the core version), **one trivial PRIVATE table + its own migration** (journal `__drizzle_migrations_web`) — so U0 proves the private repo can extend the schema alongside core, not just re-export a function. `drobek:bump-core` script. `.env.example`.
- **e2e (local):** `docker compose up` → `/private` renders core code; **both** migration journals applied to one DB; private table queryable. Integration proven where it's actually risky.
- **Tickets:** PHY-77, ratifies PHY-74 integration requirement.

### P0-D · CI → GHCR (both repos)
Public: quality-gate → build `drobek-selfhost-{web,mcp}` (public visibility). Private: `submodules: recursive` everywhere, lockfile-sync check, build `drobek-saas-{web,mcp}` (private visibility) → migrate (core+web) → deploy. Secrets in both: `VPS_SSH_KEY`, `VPS_USER=root`, `VPS_HOST=72.61.178.125`, `VPS_APP_DIR=/home/apps/drobek`, `POSTGRES_PASSWORD`. `StrictHostKeyChecking=no` (no ssh-keyscan — trips fail2ban, per puls).

### P0-E · VPS bootstrap + nginx + TLS to beta
One-time (confirm-to-run, touches shared-postgres + nginx): `mkdir /home/apps/drobek`; create `drobek` DB+user on shared-postgres; write `/home/apps/drobek/.env.production` (chmod 600, never in git) — **`DATABASE_URL` host = `shared-postgres`**, **`REDIS_URL=redis://default:<pw>@shared-redis:6379`** (the two classic puls traps), key prefix `drobek:`. Generate DB password once and put it identically in BOTH the GH secret AND `.env.production` (drift = migrate-OK-but-app-500s). **Reuse the existing kept `drobek.app` cert** (SAN already = apex+www+mcp → no new cert); serve a **`no-store` de-poison window** for the cached `drobek-redirect.conf` 301 before swapping in the app; `noindex` during beta. Clone `pulsmcp-{web,mcp}.conf` (upstream `127.0.0.1:3041/3042`; web: `/assets/` immutable, `/api/` no-store, `location = /healthz`; mcp: `proxy_buffering off`, `read_timeout 3600s`, MCP CORS, `location = /health`). **Both** new confs must keep `location /.well-known/acme-challenge/ { root /var/www/certbot; }` or renewal silently dies in ~60 days. `rm` BOTH `sites-available/drobek-redirect.conf` AND `sites-enabled/drobek-redirect.conf` (dangling symlink fails `nginx -t`). `nginx -t && systemctl reload nginx && certbot renew --dry-run`.
- `docker-compose.deploy.yml`: clone puls', swap to `drobek-saas-*` images, containers `drobek-web` (`127.0.0.1:3041:3000`) / `drobek-mcp` (`127.0.0.1:3042:3001`), attach external nets `postgres_network`/`redis_network`/`nginx_proxy_network`. **Fix every hardcoded puls value** when cloning `deploy.yml`: health-wait `for c in drobek-web drobek-mcp`, rollback curls `3041/healthz` + `3042/health`, external check `drobek.app`/`mcp.drobek.app`.

### P0-F · First release + skeleton acceptance
`gh release create v0.0.1 --target main` on **drobek-web** → migrate (core+web) → deploy → `curl https://drobek.app/healthz` = `{ok:true,db:up,redis:up,edition:saas}` over TLS, `https://mcp.drobek.app/health` OK, `/private` renders core version. Verify in chrome-devtools (clean console, screenshot). Update `docs/RUNNING_APPS.md` (reclaim 3041/3042, drobek rows), `CHANGELOG.md`, clone `PULS_DEPLOYMENT.md` → `DROBEK_DEPLOYMENT.md`.

**Skeleton DoD (all true):** both repos build to GHCR with correct visibility; `docker compose up` runs both locally; the **prod** `drobek-saas-web` image executes core code (`/private`); `drobek.app` + `mcp.drobek.app` serve live over TLS; **two** drizzle journals applied to `drobek`; `@smoke` green on local AND beta; **deploy-#2 rollback drill passed** (see Risk R3 — rollback is unprovable on deploy #1). Only then start M1a.

---

## 4. e2e testing strategy (tiered — fixes the per-part flakiness tax)

**Two tools, zero overlap.** chrome-devtools MCP = discovery/acceptance while building ("I saw it work once"). Playwright = the committed CI regression gate ("it keeps working"). **Rule that kills half-done work:** every chrome-devtools verification is crystallized into a Playwright spec in the *same commit* as the feature.

**One suite, two targets, env-parameterized** (`BASE_URL_WEB`, `BASE_URL_MCP`, `TEST_ENV`). Port puls' `tests-e2e/` (swap `puls_session`→`drobek_session`, ports, health paths, truncate list). Owned by **drobek-web** (the deploying repo); public core ships the same suite via the submodule, not a fork.

**Tag tests by where they're safe:**
- `@smoke` — read-only, no seed/writes. Safe **anywhere incl. prod**. Health, version, OAuth discovery reachability, public serving. **This is the only tier gating each deploy** (<60s, no DB).
- `@beta` — real flows via guarded seed + **unique self-cleaning app slugs**. Beta + local. **Nightly/manual**, not per-deploy.
- `@local` — destructive (TRUNCATE + direct seed). Localhost only.

**Tiered gate (deletes the per-ticket prod-green requirement that reintroduces flakiness):** full suite **local per part**; thin **`@smoke` on beta per part**; full **`@beta` nightly**. You still verify on prod every part, without the email-delivery / OAuth-redirect-drift / DNS / TLS-cold-start tax multiplying across 45 tickets.

**Seeding (prod-safe twist):** local = `global-setup` direct-DB seed, TRUNCATE **only when `DATABASE_URL` set AND an explicit `ALLOW_DESTRUCTIVE=1` AND hostname-allowlist match that never resolves to the shared box** (puls truncates unconditionally — the one change drobek MUST make, or a stray `DATABASE_URL` in a shell nukes the shared `drobek` DB). Beta = a seed mechanism that is **physically excluded from the prod image** (separate build target, verified absent in CI) — NOT a compiled-in `/test/seed-session` endpoint. The draft's `E2E_ENABLE_SEED` flag would leave a standing session-minting auth-bypass on a public domain; reject it.

**Post-deploy in `deploy.yml`:** retag `latest→previous`, `vX→latest` → `compose up` → wait `healthy` → external curl → **`@smoke` Playwright step** → rollback `previous→latest` on failure.

---

## 5. Ordered build units (post-skeleton). Per unit: ship complete → `@local`+`@beta` green local → `@smoke` green beta → chrome-devtools acceptance → Linear updated → next. WIP=1.

### Phase 1 — M1a
- **U2 · Email magic-code auth + Redis sessions** (port puls): 6-digit SHA-256 code, 10-min TTL, Redis rate-limit, SMTP, HttpOnly `drobek_session`, `users` table, `SUPERADMIN_EMAIL` bootstrap. *e2e:* request→email(mailpit/SMTP)→code→session→`/me`; 6th attempt rate-limited. → PHY-53, PHY-70; partial PHY-76.
- **U3 · Google OIDC login** — account-link by email. *e2e:* consent→authed, same user on email match. → PHY-53.
- **U4 · Workspaces (personal+team) + 4 roles + invites** — super-admin/workspace-admin/editor/viewer, role middleware. *e2e:* personal ws on signup; invite→accept→editor; viewer mutation 403. → closes PHY-54; PHY-53.
- **U5 · MCP OAuth 2.1 Authorization Server** — endpoint + AS (browser consent, discovery metadata, token issue/refresh scoped to workspace+role). *e2e:* add `mcp.drobek.app` in Claude Code → OAuth → consent → `whoami`/tool list; discovery `authorize` not 404. → PHY-71, PHY-53.
- **U6 · Deploy pipeline v1** (the headline) — `deploy_init` (presigned PUT for **missing hashes only** + quota reject) → out-of-band PUT → `deploy_commit` (BullMQ enqueue, **namespaced queue prefix** to avoid puls collision on shared-redis) → worker (**strict lint no-chromium/puppeteer**, content-hash blob store, immutable version, `index.html` required, activate) → `deploy_status` (Redis pub/sub → SSE). Rollback + audit. *e2e:* deploy static app → status streams `live` → rollback restores prior; chromium app **rejected**; oversized **rejected**; dedup omits unchanged file's putUrl. → closes PHY-57; PHY-71/70/63/68/85.
- **U7 · Path serving (hardened same-origin)** — resolve `/<ws>/app/<slug>` → active blob; immutable cache + manifest in Redis; strict CSP; path-scoped admin cookie; visibility gate (public/team-only/password) BEFORE serving. *e2e:* loads with CSP + immutable caching; team-only gates anon; admin cookie absent on app path. → closes PHY-58; PHY-52/82/76.
- **U8 · Minimal dashboard** — apps list, deploy history, rollback button, members view. *e2e:* login→list→history→rollback reflected; viewer can't rollback. → PHY-62 (slice); PHY-74.
- **U9 · M1a acceptance + self-host + integration gate** — PHY-74 validated on clean `docker compose up` AND beta; drobek-web deploy pins core tag. *e2e:* "deploy static app from Claude Code → serves → rollback" green on fresh local compose AND beta. → **closes PHY-74**; confirms PHY-73/60/77.

### Phase 2 — M1b
- **U10 · Data API v1** — jsonb collections + **required schema** + per-collection access (public-read/public-write/locked) + Redis write rate-limit + storage quota (all modes) + MCP `record_create/read/update/delete/list`. *e2e:* collection+schema via MCP → schema-honoring writes; locked rejects anon; quota caps. → closes PHY-55 (reconcile its M2→M1b milestone), PHY-56; PHY-63/71.

### Phase 3 — M1c (spike wildcard TLS EARLY as throwaway)
- **U11 · Per-workspace apps-origin + end-user auth + JS SDK** — `<ws>.apps.drobek.app` **wildcard cert via DNS-01** (net-new: no DNS provider named yet — see R5; HSTS preload means these subdomains must be valid-HTTPS from first hit), `workspace_end_users` SSO, HttpOnly cookie + CSRF, end-user login (email/Google/GitHub), owner-only collection mode, versioned SDK at `<host>/sdk@1.js`. *e2e:* app loads SDK → end-user signs in → owner records isolated → CSRF enforced → SSO across two apps; cross-ws isolated. → closes PHY-72/75/78; PHY-56/52/76 → M1 complete.

### Phase 4 — M2 (parallelizable backlog)
U12 Proxy v1 (SSRF/KEK, PHY-59/76) · U13 Forms (PHY-81) · U14 Webhooks (PHY-84) · U15 Preview→promote (PHY-83) · U16 Drop-in UI widgets (PHY-91) · U17 Lifecycle + **blob GC/backups** + abuse (PHY-64/79/80).

### Phase 5 — M3 (CUT from the foundation; revenue features, can lag without violating deployment-first)
U18 Full dashboard (PHY-62) · U19 Logger+Sentry+audit (PHY-69/85) · U20 Feedback loop (PHY-68) · U21 App insights (PHY-92) · U22 Notifications+cron (PHY-66/88/89) · U23 Billing/tiers/metering (PHY-65/94) · U24 Marketing/onboarding (PHY-67/93) · U25 GDPR/DSAR+consent (PHY-86/87) · U26 Threat-model/takedown (PHY-76 close, PHY-90).

**Critical path:** P0 → U2→U3→U4→U5→U6→U7→U8→U9 (M1a) → U10 → U11 (M1 complete). U12+ parallel after M1.

---

## 6. Risk list (the few that bite first)

- **R1 · Blob store** (D2) — ✅ resolved: local-disk `BlobStore` + persistent volume + signed-upload sha verification (PHY-96/100/101). No object-storage service.
- **R2 · Migrate runs against shared prod before image swap, forward-only; "rollback" reverts image not schema.** During M1a you churn auth schema every release. A bad migration leaves old code on new schema with a **green "rollback OK"** — false confidence. `/healthz` checks connectivity not schema correctness. *Fix: additive-only migrations in skeleton phase; treat release-rollback ≠ deploy-rollback explicitly.*
- **R3 · Rollback unprovable on deploy #1** (`:previous` doesn't exist; `docker tag … || true` no-ops). *Fix: scripted deploy-#2 rollback drill in P0 acceptance.*
- **R4 · e2e on SHARED postgres/redis** — TRUNCATE one env-var from catastrophe; no GC until M2 (every failed `@beta` run leaks apps/blobs/queue into prod); BullMQ queue collision with puls. *Fix: hostname-allowlisted destructive guard, namespaced queues, no feature gated on `@beta`-prod until GC exists.*
- **R5 · Wildcard TLS DNS-01** — estate is 100% HTTP-01 webroot; gates M1c. DNS = **Hostinger** (`*.dns-parking.com`). *Fix: DNS-01 via Hostinger API; spike `*.apps.drobek.app` before M1c (PHY-97).*
- **R6 · Hosting untrusted vibecoded apps is the security sleeper** — hardened same-origin serving, cross-origin cookie/CSRF, OAuth2.1 AS correctness, M2 SSRF proxy, subdomain-takeover on the wildcard. Easiest place to quietly ship something exploitable. *Fix: security pass per serving/auth/proxy slice, not deferred to U26.*
- **R7 · Two-repo lockfile drift** breaks `--frozen-lockfile` on the first core edit. *Fix: `drobek:bump-core` + CI sync check (§2).*
- **R8 · Calendar vs dev-weeks** — 27–41 dev-weeks ≈ 9–14 months solo. Set the calendar expectation now.

## 7. Decisions still blocking Phase 0

1. **D1 hostname** — ✅ apex `drobek.app` + `mcp.drobek.app`, reuse kept cert, `noindex` (apex same-origin = single-user only, PHY-98).
2. **D2 blob store** — ✅ local disk + signed-upload (sha-verified), no MinIO; persistent volume in compose (PHY-96/100).
3. **D3 health contract** — ratify `{ok,db,redis}` + 503 + `/api/version{sha}`, MCP `/health`.
4. **D4 migration ownership** — two journals (`_core`/`_web`), two `db:migrate` passes, one DB; prove with one private table in P0-C.
5. **D5 "done" + Linear** — WIP=1 slice-done; re-cut Linear to slices OR document fractional-advance; split M1a/b/c from M1, move PHY-55 to M1b.
6. **DNS provider for the future wildcard** (R5) — name it now even though M1c is later.

Until D1–D5 are answered in `docs/ARCHITECTURE.md`, Phase 0 cannot start without a guaranteed multi-day stall on each.

---

**Bottom line:** Capable — yes. "Everything done at once" — no, and attempting it *is* the risk. Convert "all 45 done before bigger changes" into "WIP=1 vertical slices, each fully done + prod-smoked, skeleton-to-beta in the first 6–10 weeks." Same principles; a plan that finishes. Force the four drafts to agree on the five values above before writing code — today they don't, and each disagreement is a stall waiting to happen.

Relevant paths: `/Users/tomasgrasl/projects/nodejs/puls-mcp/` (clone template: compose, `apps/web/Dockerfile.prod`, `.github/workflows/deploy.yml`, `tests-e2e/`, `apps/web/app/lib/health.ts`); `/Users/tomasgrasl/projects/server/srv1069065-vps/nginx/sites-available/pulsmcp-{web,mcp}.conf`, `…/sites-available/drobek-redirect.conf` (remove + unlink on cutover; cert SAN = apex+www+mcp only), `…/docs/PULS_DEPLOYMENT.md`, `…/docs/RUNNING_APPS.md`; target repos `/Users/tomasgrasl/projects/nodejs/drobek/` (public core) and `/Users/tomasgrasl/projects/nodejs/drobek-web/` (private, both currently docs/README-only).
