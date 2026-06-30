# drobek — Raw auditor findings

## Auditor 1

I've read all six docs plus the Ratified-decisions block. Here is the cross-document consistency audit.

---

# drobek docs — cross-document consistency audit (2026-06-30)

Ground truth = ROADMAP "✅ Ratified decisions (2026-06-30, owner)" (D1–D5 + DNS). Where a doc disagrees with a ratified decision, the ratified decision is correct.

## CRITICAL

**C1 — Blobs live in Postgres (BYTEA / content-row) across three docs, but Ratified D2 says local-disk files.**
- Conflict: `TECHNICAL_DESIGN.md §1` → `blobs(sha256 pk, content_type, bytes bytea)` (blob bytes stored *in* Postgres); `ANALYSIS.md §6` → "blob storage = PG for now (binaries later)"; `ARCHITECTURE.md §3` → `blobs(sha256 PK, content_type, bytes) -- content-addressed` (+ §8/§19 imply PG rows + an on-disk *threshold*). vs `ROADMAP Ratified D2` → "pluggable blob-store interface, **default = local disk** (content-hash files)".
- Correct: D2 (local disk default). Fix: TECHNICAL_DESIGN `blobs` row must drop `bytea` and store path/size/metadata (bytes on disk via the blob-store interface); ARCHITECTURE §3 + §19 and ANALYSIS §6 must stop saying "PG for now". TECHNICAL_DESIGN §7's open question "blob storage threshold PG↔disk" is moot under D2 — remove it.

**C2 — ROADMAP body still prescribes MinIO/S3 object storage, directly contradicting its own Ratified D2 ("NO MinIO").**
- Conflict: `ROADMAP §1 table D2` ("Stand up **MinIO**…"), `§3 P0-B` ("**MinIO container** as shared service", bucket `drobek-blobs`, presigned-PUT), `§6 R1` ("*Fix: MinIO/R2 in Phase 0*"), `§7 #2` ("MinIO-on-VPS vs R2/S3") vs `ROADMAP Ratified D2` (no MinIO, local disk, drobek signed upload endpoint, not S3).
- Correct: Ratified D2. Fix: rewrite P0-B/R1/§1-D2/§7 to "local-disk blob store + drobek signed-upload endpoint"; delete the MinIO container and `drobek-blobs` bucket. This is the headline product mechanism, so the stale MinIO wording is high-blast-radius.

**C3 — ROADMAP's entire Phase 0 runbook targets `beta.drobek.app` + a fresh cert, contradicting Ratified D1 (apex + reused cert).**
- Conflict: `ROADMAP §1 table D1` ("`beta.drobek.app` + `mcp-beta.drobek.app`… **one fresh HTTP-01 cert**"), and all of `§3` (P0-E issues a "**fresh HTTP-01 cert** for `beta.drobek.app`+`mcp-beta.drobek.app`", P0-F curls `https://beta.drobek.app/healthz`, the Skeleton DoD, §7 #1) vs `ROADMAP Ratified D1` ("APEX `drobek.app` (+`mcp.drobek.app`); **reuse the existing kept cert**… replace the apex→tomasgrasl redirect; `noindex` during beta").
- Correct: Ratified D1 (apex, reuse cert, no fresh cert). Fix: rewrite P0-E/P0-F/DoD/§7 to apex hostnames, reuse the existing SAN cert, and keep `noindex` instead of cutting a new beta cert. `USER_FLOWS.md` (uses `mcp.drobek.app` / `drobek.app/<me>/app/…`) is already correct and proves the body is the stale side.

## HIGH

**H1 — ARCHITECTURE says apps are "always public (v1)"; every other doc (and the schema) has public/team/password.**
- Conflict: `ARCHITECTURE.md §3` (`apps(… visibility=public …)` hardcoded) + `§5` ("Apps **always public** (v1)") vs `TECHNICAL_DESIGN.md §1` (`visibility 'public'|'team'|'password', password_hash null`) + `§6` ("visibility gate (public|team-login|password)"), `ROADMAP U7` ("visibility gate (public/team-only/password)… team-only gates anon"), `USER_FLOWS.md §D` ("team-only/password → gated").
- Correct: three-mode visibility (the revised decision; TECHNICAL_DESIGN carries the `password_hash` column). Fix: update ARCHITECTURE §3 and §5 to public/team/password; ANALYSIS §6's "visibility modes beyond public" deferral should be reconciled with U7 shipping team/password in M1a.

## MEDIUM

**M1 — M0 (walking-skeleton) milestone is absent from ARCHITECTURE and ANALYSIS, though Ratified D5 makes it foundational.**
- Conflict: `ARCHITECTURE.md §18` and `ANALYSIS.md §2–3` enumerate only M1a/M1b/M1c/M2/M3 vs `ROADMAP Ratified D5` ("**foundation = M0 + all of M1**"; "Linear re-cut into M0/M1a/M1b/M1c") + ROADMAP Phase 0.
- Correct: M0 exists. Fix: add M0 (Phase-0 walking skeleton: both repos→prod, health/version, two-journal migrate) to ARCHITECTURE §18 and ANALYSIS.

**M2 — Wildcard-TLS DNS provider: Ratified says Hostinger; ROADMAP body + ANALYSIS say "no provider named".**
- Conflict: `ROADMAP Ratified "DNS for the future wildcard = Hostinger"` vs `ROADMAP §6 R5` ("Wildcard TLS DNS-01 **has no provider named**") + `§5 U11` ("no DNS provider named yet — see R5") + `ANALYSIS.md §4` ("DNS-01 wildcard once" — unnamed).
- Correct: Hostinger (`*.dns-parking.com`, DNS-01 via Hostinger API). Fix: name Hostinger in R5/U11/ANALYSIS; downgrade R5 from "unknown provider" to "wire Hostinger API token".

**M3 — `super-admin` is modeled as a per-workspace membership role, but is defined elsewhere as a global self-host operator.**
- Conflict: `TECHNICAL_DESIGN.md §1` → `memberships(… role 'super-admin'|'workspace-admin'|'editor'|'viewer' …)` (super-admin as a row scoped to a workspace) vs `ARCHITECTURE.md §6` ("`super-admin` via `SUPERADMIN_EMAIL`") + `USER_FLOWS.md §E` ("logs in with `SUPERADMIN_EMAIL` → becomes super-admin, **sees everything**").
- Correct: super-admin is global (env-bootstrapped), not a workspace membership. Fix: drop `super-admin` from the `memberships.role` enum (keep workspace-admin/editor/viewer) and represent it as a global flag.

**M4 — Linear milestone mapping is self-contradictory (PHY-55 M2 vs M1b; M1a/b/c not real milestones).**
- Conflict: `ROADMAP §1 D5` ("PHY-55 is misfiled under M2"; "M1a/M1b/M1c are **not** Linear milestones") vs `ROADMAP §5 U10` which "closes PHY-55 (reconcile its M2→M1b milestone)". Docs assume an M0/M1a/b/c board that Linear doesn't yet have.
- Fix: re-cut Linear to M0/M1a/M1b/M1c and move PHY-55 to M1b, or document fractional-advance — before relying on the per-slice "Linear updated" gate.

## LOW (cosmetic / terminology drift — fix opportunistically)

- **L1** `ARCHITECTURE.md §10 "Data API (Variant 1)"` / `§12 "Proxy (Variant 2)"` — stale "Variant" labels from an earlier options doc; no other doc uses them. Drop.
- **L2** Terminal deploy status: `TECHNICAL_DESIGN §2` + `USER_FLOWS` use `ready`; `ROADMAP U6` says "streams `live`". Pick one token.
- **L3** SPA fallback naming drifts: ARCHITECTURE "default **open**" / ANALYSIS "pick **on**" / TECHNICAL_DESIGN `routing_mode 'spa'|'exact'`. Normalize to the `spa`/`exact` enum.

## Items checked that are CONSISTENT (no finding)
- **Queue = BullMQ** everywhere (ARCHITECTURE §8/§14, TECHNICAL_DESIGN §5, USER_FLOWS, ANALYSIS, ROADMAP U6). No `pg-boss` reference exists in any doc — consistent.
- **Apps-origin is per-workspace** (`<ws>.apps.<host>/<slug>`) in ARCHITECTURE §4/§5/§7, TECHNICAL_DESIGN §6, USER_FLOWS §C, ROADMAP U11 — no per-app drift.
- **M1b/M1c content split** (M1b = data API + `record_*`; M1c = SDK + end-user auth + wildcard) agrees across ARCHITECTURE §18, ANALYSIS §3, ROADMAP §5.

---

## Single most important finding (for this lens)
**The blob/object-storage layer is contradictory in two compounding ways (C1 + C2): three product docs store blobs as Postgres `bytea`/content-rows and the ROADMAP body still stands up MinIO/S3 — while Ratified D2 mandates a pluggable blob-store defaulting to local-disk files with a drobek signed-upload endpoint.** This is the product's spine (it dictates the `blobs` schema, the `deploy_init`→PUT→content-hash→serving pipeline, the infra footprint, and GC/backup design). Until ARCHITECTURE §3/§8/§19, TECHNICAL_DESIGN §1/§7, ANALYSIS §6, and ROADMAP §1-D2/§3-P0-B/§6-R1/§7 are all rewritten to D2 (local-disk store, no MinIO, no `bytea`), Phase 0 will scaffold the wrong storage backend and the headline deploy flow is specified against infra the owner has explicitly rejected.

Relevant files (absolute): `/Users/tomasgrasl/projects/nodejs/drobek/docs/ARCHITECTURE.md`, `/Users/tomasgrasl/projects/nodejs/drobek/docs/TECHNICAL_DESIGN.md`, `/Users/tomasgrasl/projects/nodejs/drobek/docs/ANALYSIS.md`, `/Users/tomasgrasl/projects/nodejs/drobek/docs/ROADMAP.md`, `/Users/tomasgrasl/projects/nodejs/drobek/docs/USER_FLOWS.md`, `/Users/tomasgrasl/projects/nodejs/drobek/docs/POSITIONING.md`.

---

## Auditor 2

I have enough grounding. Findings below.

---

# drobek — Technical-Soundness Audit (will it build & run?)

Grounded against the puls-mcp reference impl (read its OAuth, redis, health, deploy compose, schema). Severity-ranked. Each: issue · where · concrete fix.

## CRITICAL

**C1 — Blob storage location is contradicted across three ratified/design docs, and the deploy compose has no persistent volume → every release wipes all hosted apps.**
Where: `ROADMAP.md §Ratified D2` (pluggable store, *default local disk*) vs `TECHNICAL_DESIGN.md §1` (`blobs(sha256 pk, … bytes bytea)` — bytes in Postgres) vs `TECHNICAL_DESIGN.md §5` (`upsert blobs(sha256)`) vs `ANALYSIS.md §6` ("blob storage = PG for now") vs `ROADMAP.md P0-B` (stand up MinIO). Four different answers for the product's spine. puls' `docker-compose.deploy.yml` (which drobek clones) is **100% stateless** — zero named volumes, all state in shared pg/redis; containers are replaced wholesale on each GHCR release. If D2 (local disk) wins, blobs live on container-local disk and **every `docker pull` + recreate deletes them**.
Fix: Pick one and propagate. If local-disk (D2): add a named volume / host bind-mount (`/home/apps/drobek/blobs`) to the deploy compose, mounted into *every* container that writes-on-commit, the worker, and serving; document it in `DROBEK_DEPLOYMENT.md`. If bytea (TECHNICAL_DESIGN): delete D2/MinIO and accept Postgres bloat + `bytea` streaming. They are mutually exclusive — the schema's `bytes bytea` column must be deleted under D2 (replace with `path`/`size`/`content_type`).

**C2 — Signed-upload does not verify body == claimed sha256, so content-addressing and dedup are forgeable.**
Where: `ARCHITECTURE.md §8`, `TECHNICAL_DESIGN.md §2` (`deploy_init … manifest:[{path,sha256,bytes}] → uploads:[{putUrl}]`) and `§5` worker ("validate manifest complete (all blobs present)"). Neither S3 presigned-PUT nor a drobek local-disk signed endpoint validates that the uploaded bytes hash to the key. The worker only checks *presence*, not *integrity*. An agent (or anyone holding a presigned URL) can store arbitrary bytes under any sha256 → since `blobs.sha256` is a **global PK with no workspace scoping**, a poisoned blob is served to any app that dedups to that hash.
Fix: The upload-receipt endpoint must stream-hash the body, compare to the path-embedded sha256, and reject on mismatch before the bytes become a committable blob. State this in §8/§5. (S3 cannot do this for you — keep the upload sink in-app, which also aligns with D2.)

## HIGH

**H1 — "Hardened same-origin" default is not a security boundary for untrusted JS.**
Where: `ARCHITECTURE.md §5` ("Default = hardened same-origin (admin cookie path-scoped, … strict CSP)"), `ANALYSIS.md` R6. CSP, `nosniff`, and cookie `Path` do **not** stop same-origin script from calling cookie-authed admin endpoints: a hosted app's JS can `fetch('/<ws>/dashboard/…', {credentials:'include'})` and the browser attaches any cookie whose `Path` matches the *requested* URL — path-scoping restricts nothing here. Hosting untrusted vibecoded JS on the same origin as a cookie session is an XHR/CSRF exfil channel by construction.
Fix: Make a **separate origin the floor** whenever a cookie-authed surface shares the host. Either serve all apps off `*.apps.drobek.app` (not just auth apps), or make the data API strictly bearer-token (no cookies) AND ensure no cookie-authed route is reachable same-origin. Don't ship same-origin-with-admin-cookie as the self-host default.

**H2 — Two-journal Drizzle split is hand-waved for cross-schema foreign keys.**
Where: `ROADMAP.md D4` / `§3 P0-C` ("two drizzle journals `_core`/`_web`, two passes, one DB"). Private tables (billing/tiers/feedback) will FK to **core** tables (`workspaces`, `users`). To express that FK in the `_web` schema, drobek-web must import the core `pgTable` objects — at which point `drizzle-kit generate` for the web journal will try to **emit CREATE/ALTER for those core tables** (it manages every table it sees), colliding with the `_core` journal. Drizzle has no first-class "external, unmanaged table."
Fix: Set `tablesFilter` (or `schemaFilter`) in the web `drizzle.config.ts` to the private table list so generate ignores core tables, and prove it in P0-C with a private table that actually **FKs to `workspaces`** (the current P0-C plan only adds "one trivial PRIVATE table" with no FK — it doesn't exercise the real risk).

**H3 — "Port the puls OAuth AS" understates the rework; puls' token model is incompatible with drobek's.**
Where: `ARCHITECTURE.md §6`, `TECHNICAL_DESIGN.md §4` ("access_token (aud-bound)", schema `oauth_access_tokens(… audience …)`), `ROADMAP.md U5` ("token issue/**refresh** scoped to workspace+role"). Verified in puls: (a) the access token is bound to **one `shopId`** at consent (`oauth.token.tsx` copies `authCode.shopId`) — drobek users have *many* workspaces and authorize per-call, so the token must be **user-scoped** with per-call membership authZ, a different consent/issuance flow; (b) puls metadata advertises **only `authorization_code`** — no `refresh_token` grant exists, so drobek's refresh is net-new; (c) puls' `validateBearer` does **no audience check** — there is no `audience` column and no `aud` validation, so drobek's "aud-bound" claim is unimplemented.
Fix: Re-spec U5 as: drop shop-binding → user-bound tokens + per-request workspace/role check; add the `refresh_token` grant + rotation; add an `audience`/`resource` (RFC 8707) column AND validate it in the mcp-server middleware against the protected-resource `resource`. Budget this as build, not port.

**H4 — BullMQ is net-new (puls uses no queue) and the worker process is unspecified.**
Where: `ARCHITECTURE.md §8/§14`, `TECHNICAL_DESIGN.md §5`. Confirmed: puls has **no bullmq dependency** anywhere; the "same family as puls" framing doesn't cover the queue. The compose is `web + mcp-server + postgres + redis` — there is **no worker service**, yet `deploy_commit` enqueues a job that something must consume (strict lint of untrusted HTML/JS + blob store + activation). If embedded in `web`, the SSR process runs CPU-heavy untrusted-app linting under puls' `768M/0.8 CPU` container limits.
Fix: Name the worker explicitly — either a 4th container (`drobek-worker`) sharing the blob volume + DB + redis, or a documented in-`web` worker with raised resource limits. Add it to the deploy compose and the DoD.

## MEDIUM

**M1 — BullMQ + shared ioredis has two concrete traps the docs don't address.**
Where: `ROADMAP.md §14`, P0-E ("key prefix `drobek:`"). puls' `getRedis()` hardcodes `maxRetriesPerRequest: 2`; BullMQ **Workers/QueueEvents require `maxRetriesPerRequest: null`** on their connection, so the puls redis factory cannot be reused for the queue. Also ioredis `keyPrefix` is **unsupported by BullMQ** — the planned `drobek:` prefix will silently not namespace queue keys; BullMQ needs its own `prefix` option (e.g. `{drobek}`).
Fix: Dedicated BullMQ connection(s) with `maxRetriesPerRequest:null, enableReadyCheck:false`; set BullMQ `prefix`, not ioredis `keyPrefix`. (Note: R4's "BullMQ queue collision with puls" is mis-stated — puls has no queues; the real risk is config, not collision.)

**M2 — jsonb Data API has no supporting indexes for its own query contract.**
Where: `TECHNICAL_DESIGN.md §1` (`app_documents … index(app_id, collection)`) and `§3` (`?where=field:val&sort=-created_at&limit=50`). The only index is btree `(app_id, collection)`; arbitrary `where` on `doc` fields and `sort=-created_at` are unindexed → in-collection seq scan + filesort on every query.
Fix: Add a GIN index on `doc` (jsonb_path_ops) and put `created_at` in a composite index `(app_id, collection, created_at desc)`; or constrain query to schema-declared, expression-indexed fields. Document the supported filter/sort surface.

**M3 — `deploy_init` "missing files only" is a cross-tenant existence oracle.**
Where: `ARCHITECTURE.md §8`, `TECHNICAL_DESIGN.md §2`. `blobs.sha256` is global/un-scoped; returning "which hashes are missing" tells any agent whether a given content hash exists *anywhere on the platform*.
Fix: Scope the dedup/"missing" check to blobs already referenced by the requesting workspace's deploys; only globally-dedup at storage write time, never in the API response.

**M4 — `deploys.manifest jsonb` duplicates `deploy_files` rows (two sources of truth).**
Where: `ARCHITECTURE.md §3` (manifest jsonb) + `TECHNICAL_DESIGN.md §1` (`deploy_files … "manifest expanded"`). Both store path→sha256; they can drift, and serving (`§6`) reads `deploy_files` while rollback/audit may read `manifest`.
Fix: Keep `deploy_files` as canonical (it's the one serving joins on) and drop `manifest jsonb`, or make manifest a derived view — don't persist both as independent writes.

**M5 — End-user CSRF on purely static apps + session token format unresolved.**
Where: `ARCHITECTURE.md §7`, `TECHNICAL_DESIGN.md §3` ("CSRF token (double-submit)") and `§7` ("Token format … opaque vs JWT — open"). Apps are static blobs with no server render, so the double-submit token needs an explicit delivery (readable non-HttpOnly cookie or `/__drobek/auth/csrf` endpoint) that the SDK reads — unspecified. The session-format decision gates the SDK auth surface (M1c) but is still open.
Fix: Specify CSRF token delivery for static origins; pick opaque server-side sessions (you already have `workspace_end_user_sessions`) and close §7 before M1c starts.

---

**Single most important finding for this lens:** **C1** — the blob-storage substrate is simultaneously specified as Postgres `bytea`, local disk, and MinIO across the ratified decisions and the design doc, and the puls compose drobek clones is stateless with no volume. Until one substrate is chosen and a persistent volume (or DB column) is wired into the actual deploy compose, the headline pipeline (`deploy_init → upload → blob → serve → rollback`) cannot be built without either silently destroying every hosted app on the next release or building against a storage layer that doesn't exist. Everything in M1a's critical path sits on this.

---

## Auditor 3

I have enough to threat-model. Findings below; all references are to the drobek docs I read.

---

# drobek — Security audit (untrusted-app / multi-tenant lens)

## CRITICAL

**C1 — Non-auth apps are served on the apex, same origin as the admin dashboard → full admin-account takeover.**
Where: `ARCHITECTURE.md §4–§5` (path-based `(<host>)/<ws>/app/<slug>`, default "hardened same-origin"), `ROADMAP.md` D1 (apex `drobek.app`), `TECHNICAL_DESIGN.md §6`.
Attack: an attacker deploys a vibecoded app to `drobek.app/attacker/app/x`. Its JS runs on the **same origin** as the dashboard. The "path-scoped admin cookie" is not an isolation boundary — a cookie with `Path=/dashboard` is still sent on any same-origin `fetch('/dashboard/api/...', {credentials:'include'})` the untrusted app makes; HttpOnly stops `document.cookie` reads but not credentialed same-origin requests, SameSite never triggers (same site), and the Origin check passes (same origin). The app reads the response (no CORS barrier), scrapes the anti-CSRF token from any dashboard page, then drives every admin/data/MCP-management endpoint as the victim. "Strict CSP" doesn't help: the attacker authors the HTML/CSP, and the app legitimately needs `connect-src 'self'` to reach its own data API, which also permits calling admin routes. **Cookie path-scoping + CSP cannot sandbox first-party untrusted JS — only a different origin can.** This directly contradicts the ratified D1 (apex).
Fix: serve **every** app (auth and non-auth) off a dedicated origin that shares no cookie scope with the dashboard — ideally a separate registrable sandbox domain (e.g. `drobekusercontent.app`), per-app/per-workspace host, not under `drobek.app`. Re-open D1; the dashboard apex must never serve user content. If apex must host apps short-term, the dashboard must move to its own subdomain AND admin auth must be bound to that host (not path).

**C2 — Content-addressed blob store is global and (as specified) not hash-verified on upload → cross-tenant blob poisoning.**
Where: `ARCHITECTURE.md §8–§9`, `TECHNICAL_DESIGN.md §1` (`blobs(sha256 pk …)` — no workspace scoping), `§5` deploy job ("validate manifest complete (all blobs present)" — no recompute-and-verify step), `ROADMAP.md` D2 (local-disk content-hash files), signed-upload endpoint.
Attack: `deploy_init` trusts the client's manifest `sha256`/`bytes`; the agent PUTs bytes out-of-band. If the worker stores the uploaded bytes keyed by the *declared* hash without recomputing `sha256(body)` and rejecting mismatch, an attacker registers malicious bytes under a hash that other deploys/tenants reference (blobs are deduped globally, PK = sha256, no tenant column). Serving resolves "blob by hash," so the poisoned bytes are served for any app pointing at that hash. Same path also enables hash-confusion/dedup games.
Fix: the upload sink MUST recompute SHA-256 of the received body and reject if it ≠ the capability's bound hash, before the blob is committed; bind each signed PUT to exactly one sha. Consider namespacing/refcounting blobs so a tenant can never resolve another tenant's content-hash it didn't legitimately upload.

**C3 — Shared parent `*.apps.<host>` with open signup → sibling-subdomain cookie injection / end-user session fixation across workspaces.**
Where: `ARCHITECTURE.md §4,§7` (per-workspace apps-origin `<ws>.apps.drobek.app`, HttpOnly cookie there, signup "open + rate-limited"), `ROADMAP.md` U11 (HSTS includeSubDomains/preload already shipped).
Attack: signup auto-creates a workspace, so any attacker controls `attacker.apps.drobek.app` and serves arbitrary JS there. There is no public-suffix-list entry for `apps.drobek.app`, so the attacker's page can set a cookie with `Domain=.apps.drobek.app`, which the browser then sends to `victim.apps.drobek.app` — classic cookie-tossing → end-user **session fixation** (and, if the end-user session cookie is domain-scoped rather than host-only, cross-workspace session theft). Wildcard apps also invites subdomain-takeover under an HSTS-preloaded parent.
Fix: host-only end-user cookies (never `Domain=.apps...`), prefix with `__Host-`; add `apps.drobek.app` (or the whole sandbox domain) to the Public Suffix List to cut sibling cookie writes; bind each session server-side to its exact workspace host and reject if the request host doesn't match the session's workspace.

## HIGH

**H1 — Tenant isolation is application-level `WHERE app_id=` only; no Postgres RLS → IDOR on by-id record ops.**
Where: `TECHNICAL_DESIGN.md §1` (`app_documents`, only `index(app_id,collection)`), `§2` `record_read/update/delete({...locator, collection, id})`, `§3` REST `/<id>`. Prompt notes "WHERE workspace+slug + RLS" but RLS appears nowhere in the schema.
Attack: any by-id handler that queries `WHERE id = $1` (forgetting to AND `app_id`/`collection`) leaks or mutates another tenant's document; ids are guessable/enumerable. One missing predicate = cross-tenant read/write, with no second layer to catch it.
Fix: add Postgres **RLS** keyed off a per-request `app_id`/`workspace_id` GUC as defense-in-depth; make ids opaque/unguessable; centralize all data access through one scoped query builder that always injects `app_id`.

**H2 — Signed-upload quota is checked against *declared* manifest bytes, not actual body → quota bypass + disk-fill DoS.**
Where: `ARCHITECTURE.md §8,§13`, `ROADMAP.md` U6 ("presigned PUT … + quota reject"), D2 (local disk).
Attack: `deploy_init` validates quota against manifest-declared `bytes`, but the out-of-band PUT can send a far larger body. With D2 local-disk storage, this fills the single box's disk (shared with Postgres/Redis/other tenants) — a cheap multi-tenant DoS, and silently overruns per-file/per-app quotas.
Fix: bind a max-content-length into each signed PUT capability, enforce it at the sink (stream with a hard byte cap, abort+discard on overflow), and re-check quota against actually-stored bytes before commit. Add a global disk-usage ceiling separate from per-app quota.

**H3 — `public-write` collections + open signup → unauthenticated stored content that, rendered by an app, becomes stored XSS (and, via C1, apex admin compromise) + spam/quota abuse.**
Where: `ARCHITECTURE.md §7,§10`, `TECHNICAL_DESIGN.md §1` `access_mode 'public-write'`.
Attack: anyone on the internet POSTs documents; apps that render those docs execute attacker-controlled markup/script in the app origin. Combined with C1 that origin is the apex hosting the admin session. Independently, public-write is an open spam/storage sink (rate-limited, but designed to accept anonymous writes).
Fix: this is partly a documentation/SDK-hardening duty (the data API stores opaque JSON; XSS is in app render) — but ship a safe-by-default SDK render path, strong CSP on a *separate* app origin (C1), and per-collection write quotas + abuse throttling tied to the open-signup story (`ANALYSIS.md` PHY-90 must not be deferred past first public exposure).

**H4 — OAuth 2.1 AS with open DCR: redirect-URI and consent/scope binding are the weak points.**
Where: `ARCHITECTURE.md §6`, `TECHNICAL_DESIGN.md §2,§4` (DCR, PKCE, aud-bound tokens, scopes `deploy:write`/`data:write`).
Attack: open Dynamic Client Registration + any redirect_uri lets a malicious MCP client be registered; if redirect matching isn't exact (no wildcards/substring) an auth code can be intercepted, and if the consent screen doesn't bind the granted scope to a specific workspace, a token can act across the user's workspaces (confused deputy).
Fix: exact-string redirect_uri match, mandatory PKCE S256 (already), short-lived single-use codes, consent UI that names the workspace + scopes, and token authorization checks that re-verify workspace membership/role on every tool call (not just at issuance).

## MEDIUM

**M1 — Proxy SSRF guard is under-specified; "resolve DNS once" risks DNS-rebinding TOCTOU and misses several private ranges.**
Where: `ARCHITECTURE.md §12`, `TECHNICAL_DESIGN.md §1` upstreams, `USER_FLOWS.md F`.
Fix: resolve once **and connect to the pinned IP** (don't re-resolve the hostname for the actual socket); block IPv4 private/loopback/link-local **and** `169.254.169.254`, `0.0.0.0`, CGNAT `100.64/10`, IPv6 ULA/link-local/`::1`/IPv4-mapped; deny redirects (stated); validate on every request, not just at registration.

**M2 — `DROBEK_MASTER_KEY` is an env-var KEK on the same box as the app; full blast radius, no rotation design.**
Where: `ARCHITECTURE.md §12,§17`, `TECHNICAL_DESIGN.md §1` `upstream_secrets`.
Fix: document key-rotation (re-wrap DEKs), restrict `.env.production` perms (roadmap already says chmod 600), keep the key out of any code path reachable by SSRF/log dumps, and note the self-host threat model (process/env compromise = all upstream secrets). Optional KMS adapter for SaaS.

**M3 — jsonb `where`/`sort` query API risks injection / sort-by-arbitrary-column.**
Where: `TECHNICAL_DESIGN.md §3` (`?where=field:val&sort=-created_at`), `ARCHITECTURE.md §10`.
Fix: parameterize all jsonb path/value comparisons, allowlist sortable fields against the collection's JSON Schema, cap `limit`, and validate operators — never string-concatenate field names into SQL/jsonb paths.

**M4 — 6-digit email magic-codes: brute-force depends entirely on per-identifier attempt lockout, used for both admin and end-user auth.**
Where: `ARCHITECTURE.md §6,§7`, `ROADMAP.md` U2 (6-digit, 10-min TTL, Redis rate-limit).
Fix: hard per-code attempt cap (e.g. 5 then invalidate), per-email AND per-IP throttle, single-use codes; consider 8 digits. Ensure the end-user auth path (open signup) reuses the same lockout, not just the admin path.

**M5 — Manifest `path` becomes a serving key and (with D2 local disk) potentially a filesystem path → traversal / overwrite.**
Where: `TECHNICAL_DESIGN.md §1` `deploy_files(path,…)`, `§6` serving, `ROADMAP.md` D2.
Fix: normalize/validate every manifest `path` (reject `..`, absolute, NUL, backslashes), store blobs strictly by content-hash filename (never by user path), and resolve serving only through the DB manifest, never by concatenating `path` onto a disk root.

---

## Single most important finding

**C1.** The ratified D1 decision — serve untrusted vibecoded JS on the **apex `drobek.app`, the same origin as the admin dashboard** — is a direct account-takeover vector, and the stated mitigations ("path-scoped admin cookie," "strict CSP") are not security boundaries against same-origin first-party JS. No amount of cookie path-scoping or CSP isolates an attacker who controls the HTML/JS served from your own origin. This must be resolved before any public exposure (even the `noindex` beta): move all user-served content onto a separate, cookie-isolated sandbox origin and keep the dashboard's session strictly off any host that serves apps.

---

## Auditor 4

Read all six docs plus verified the live nginx redirect/cert state on the VPS. Findings below — I excluded items the existing ANALYSIS already flags as red/deferred (threat-model PHY-76, abuse PHY-90, blob-GC/backups PHY-80, GDPR-ticket-existence, brand, wildcard-DNS-provider, forward-only-migration R2, rate-limit-bucket open-Q) except where I found a distinct deeper cut.

---

# drobek docs audit — completeness / remaining gaps

## CRITICAL

**1. Apex cutover is a 301 *permanent-redirect cache* trap, not just an HSTS one.**
Where: ROADMAP "Ratified decisions → D1". The doc reasons only about HSTS ("churn shows plain 502s, not cert errors"). But the live `nginx/sites-available/drobek-redirect.conf` serves `return 301 https://www.tomasgrasl.cz/` on **both :80 and :443**. A 301 is cached by browsers/proxies aggressively and often indefinitely. Every browser/agent/crawler that has hit `drobek.app` since 2026-06-30 holds a cached permanent redirect and will **never reach the new apex app** until that cache is manually cleared — they can't even see the 502s D1 reasons about.
Fix: before any apex visitor exists for the new app, the cutover must first serve a `301`→`200` *de-poisoning* step: deploy the apex app and serve a short-`max-age` `Cache-Control: no-store` on the redirect for a window, or accept that pre-cutover visitors are lost and **launch M1a on a never-redirected host** (this is exactly what the body's `beta.drobek.app` recommendation gives you — see #2). At minimum, change the decommission redirect to `302` retroactively is too late; document the apex as burned for cached clients.

**2. ROADMAP is internally contradictory: ratified D1 = APEX, but the entire build body = `beta.drobek.app`.**
Where: ROADMAP §1 (D1 row), §3 (P0-A…P0-F), §6 (R1/R5), and the closing "Relevant paths" all instruct a fresh HTTP-01 cert for `beta.drobek.app`/`mcp-beta.drobek.app`, new conf filenames, `external check beta.drobek.app`, etc. The top-of-file "Ratified decisions" block **overrode** that to apex+reuse-cert+noindex but the body was never reconciled. A solo dev executing Phase 0 literally builds the wrong hostnames, issues an unnecessary cert, and curls the wrong health URLs — the precise multi-day stall the doc claims to prevent.
Fix: rewrite §3/§6 to apex (`drobek.app`/`mcp.drobek.app`, reuse existing cert SAN, no fresh HTTP-01, keep `noindex`), or explicitly mark the body as superseded. Right now the ground-truth doc disagrees with itself.

**3. Content-addressed blob dedup has no refcount → app/deploy delete is a correctness bug, not just a GC chore.**
Where: ARCH §8/§13, TECH-DESIGN §1 (`blobs(sha256 pk)`, `deploy_files`), lifecycle "hibernate → delete". Blobs are deduped **across apps and workspaces** by sha256, but there is no refcount/ownership table. When app-delete or GC lands, it will either orphan blobs (disk fill on the D2 local disk) or delete a blob still referenced by another tenant's deploy → cross-tenant `404`/serving corruption. ANALYSIS marks GC "deferred" but never flags the *shared-blob delete correctness* problem.
Fix: add a refcount (or `blob_refs(sha256, deploy_id)`) now, in the M1a schema, even if GC itself ships at M2. Retrofitting refcounts after blobs are shared is painful.

**4. AGPL §13 self-compliance: drobek-web importing AGPL core as a network service may force drobek-web open — voiding the open-core moat.**
Where: ARCH §1, POSITIONING §5 (treats AGPL only as a *buyer-aversion* issue). `drobek-web` (private SaaS) imports `@drobek/*` AGPL-3.0 packages and runs as a network service. AGPL-3.0 §13's network-interaction copyleft can extend the source-disclosure obligation to the *combined work* offered over the network — i.e. the private billing/SSO/SaaS modules. The whole positioning thesis ("private edition is the moat") rests on this being legally clean, and it is nowhere examined.
Fix: get this answered before building private modules — sole-copyright + dual-licensing (you license the core to yourself under non-AGPL terms), a CLA, or a verified arms-length API/module boundary that avoids "based on" combination. This is the single highest-leverage legal gap.

## HIGH

**5. End-user-auth email = the operator's domain sending login codes for *third-party* hosted apps — deliverability/identity/abuse undesigned.**
Where: ARCH §7, TECH-DESIGN §3 (`/__drobek/auth/email/start`), ANALYSIS risk register (only flags generic "SMTP deliverability"). End-users of a hosted app receive "your login code" from the drobek operator's domain on behalf of an app the operator didn't write. Unspecified: From/Reply-To/per-workspace sender identity, DMARC/SPF/DKIM alignment for that From, bounce + complaint + suppression handling, and that "open + rate-limited" signup on a public apps-origin is a **mail-bomb and SMTP-cost amplification vector**. This is a distinct, sharper problem than drobek-account magic-codes.
Fix: spec a per-workspace sender identity + alignment story, suppression/bounce ingestion, and per-recipient (not just per-IP) signup rate limits before M1c.

**6. `DROBEK_MASTER_KEY` (KEK) rotation is undefined and the schema can't support it.**
Where: ARCH §12, TECH-DESIGN §1 (`upstream_secrets(ciphertext, iv, auth_tag, wrapped_dek)`). Envelope encryption was chosen specifically to enable KEK rotation (rewrap DEKs, no data re-encrypt) — yet there is no rotation procedure and **no `kek_id`/`key_version` column**, so you can't tell which secrets are under which KEK during a rotation. Master-key loss = all upstream secrets unrecoverable; leak = no rotation path.
Fix: add `kek_id` to `upstream_secrets` now and write the rewrap procedure; same gap exists (less acutely) for session-secret and OAuth-token-signing rotation.

**7. Every non-happy serving path is unspecified — no 404/gated/hibernated/quota/suspended UX.**
Where: ARCH §4/§5, TECH-DESIGN §6 (only the happy "visibility gate → stream blob" path). Undefined: app-not-found page, what HTTP status + page a `status='hibernated'` app returns, quota-exceeded, abuse-suspended, the password-gate page itself, and critically **how a `team-only` static app on the path-origin authenticates an anonymous visitor** — a static app can't redirect to a drobek-account login by itself; the server gate must, and that flow/branding is nowhere.
Fix: define the gate's responses (status codes + branded pages) and the team-login redirect handshake; this is a hosting product's most-hit surface after the happy path.

**8. "Strict CSP" contradicts the SDK + cross-origin data API; vibecoded apps will break on CSP/CORS.**
Where: ARCH §5/§9/§11, TECH-DESIGN §3/§6. Apps get "strict CSP," yet must `<script src=.../sdk@1.js>` and XHR the data API. Worse: **auth apps live on `<ws>.apps.drobek.app` but the data REST is `/<ws>/app/<slug>/data/...` on the path-origin** → that's cross-origin, dragging in CORS + `credentials` + the CSRF/SameSite cookie scheme, none of which is reconciled with the cookie being scoped to the apps-origin. A vibecoded app following the obvious pattern will hit CSP `connect-src`/`script-src` and CORS failures.
Fix: pin where the data API is served *relative to the apps-origin* (same-origin under `<ws>.apps...` is far simpler), and ship a CSP template that the SDK + data API are guaranteed to satisfy.

**9. The lint gate — the headline deploy DX — has no defined ruleset.**
Where: ARCH §8, ROADMAP U6 ("strict lint no-chromium; hard errors **block**"). "Strict lint" with blocking hard errors is run on *every* deploy, but the hard-error set is never enumerated. Too strict kills the "vibe → live" promise; too loose ships stored-XSS into a multi-tenant host. This is undefined product behavior on the most-trafficked surface.
Fix: enumerate the blocking rules (e.g. server-side-only deps, build artifacts, missing `index.html`, dangerous inline patterns) vs warnings, as a versioned contract — agents key their fixes off it.

**10. Disk-full is the most probable outage and is unmonitored; observability "✅" only covers app errors.**
Where: ARCH §15 (logger + Sentry + PG counters), ANALYSIS scorecard marks Ops ✅. On a 48 GB box: D2 local-disk blobs (incl. orphaned uploads, #13) + unbounded Docker JSON logs (CLAUDE.md *mandates* logrotate; the drobek docs omit it) + PG + Redis, with **no disk-usage alert, no log retention, GC deferred to M2**. Sentry catches exceptions, not a silently filling disk that takes down all tenants at once.
Fix: add disk-usage + queue-depth alerting and Docker log rotation in Phase 0 — before blobs accumulate, not at M3 (U19).

**11. Two-journal migration model has no cross-pass atomicity or ordering rule.**
Where: ROADMAP D4 / P0-C ("two `db:migrate` passes, one DB"); R2 only covers forward-only/release≠schema. There's no transaction spanning the core pass and the web pass: core-OK + web-FAIL leaves a half-migrated prod DB. And private web tables that FK-reference core tables couple the bump-core *ordering* (core must migrate first, and core can't drop a column a web FK needs).
Fix: define pass ordering (core→web), abort/repair behavior on partial failure, and a rule that core migrations are additive while any web table FKs into them.

## MEDIUM

**12. Immutability vs right-to-erasure / takedown is structurally undesigned.**
Where: TECH-DESIGN §1 (`deploys` immutable, `audit_log` append-only, content-addressed blobs), ANALYSIS (DSAR = deferred ticket). Immutable+append-only+dedup is the *opposite* of GDPR erasure and DMCA per-content takedown. No tombstone/soft-delete columns exist anywhere. "A ticket exists" is not a design.
Fix: add soft-delete/tombstone semantics to the schema now (cheap later it is not), and decide how erasure reconciles with content-addressed shared blobs.

**13. Orphaned uploads + concurrent-deploy races in the headline pipeline.**
Where: ARCH §8, ROADMAP U6. Presigned PUTs that never reach `deploy_commit` leave orphan blobs (disk fill, ties to #3/#10); two `deploy_commit`s on one app race on `active_deploy_id`; presign auth, expiry, and resumability for the D2 signed-upload endpoint are unspecified.
Fix: spec upload TTL + orphan sweep, per-app deploy serialization (advisory lock), and presign signing/expiry.

**14. Queue/worker failure semantics undefined (only the collision is noted).**
Where: ARCH §14, ROADMAP U6 (namespaced prefix = the only BullMQ spec). No stuck-job/retry/dead-letter/timeout policy, yet `deploy_status` and the live-progress UX depend entirely on the worker behaving. A wedged job leaves a deploy stuck in `linting`/`storing` forever with no operator recourse.
Fix: define retry/backoff, a max-attempts→`failed` transition, job timeout, and a dead-letter + requeue path.

**15. The platform is silently a data *processor* for hosted apps' end-users.**
Where: ARCH §7, TECH-DESIGN §1 (`workspace_end_users(email, ...)`). The platform collects end-user PII (emails, sessions) on behalf of apps it didn't author → controller/processor split, DPA, per-app privacy policy, and cookie-consent for the apps-origin cookie are all unaddressed, and the self-host operator inherits this liability unknowingly.
Fix: at minimum document the processor relationship and the self-host operator's resulting obligations; design per-app data ownership/export.

**16. SDK breaking-change path is impossible by construction.**
Where: ARCH §11, TECH-DESIGN §3 (`/sdk@1.js` immutable, hardcoded `<script>` URL in deployed apps). Deployed apps are *immutable* and pin the SDK URL, so an `sdk@2` breaking change can never reach already-deployed apps — you can't rebuild a vibecoded static blob.
Fix: decide the compat policy now (sdk@1 is forever-frozen; only additive changes; or a redeploy-to-upgrade story) and document it as an SDK contract.

---

## Single most important finding (this lens)

**#4 — AGPL-3.0 §13 self-compliance.** Everything else is an operational or DX gap you can patch mid-flight; this one can retroactively invalidate the entire open-core business model the project is built around. POSITIONING treats AGPL purely as a *customer* aversion ("enterprises dislike it") and never asks the prior question: does `drobek-web`, a private network service that imports AGPL core, itself fall under §13's network-copyleft? If the answer is yes and the boundary isn't engineered/licensed correctly, the "private SaaS edition" — the stated moat — is legally compelled to be open. Resolve the licensing structure (sole-copyright + dual-license/CLA or a proven module boundary) **before** writing a line of private-module code, because unwinding it after billing/SSO/SaaS modules exist is far costlier.

Relevant absolute paths: `/Users/tomasgrasl/projects/nodejs/drobek/docs/ROADMAP.md` (D1 block vs §3 body contradiction), `/Users/tomasgrasl/projects/server/srv1069065-vps/nginx/sites-available/drobek-redirect.conf` (confirmed live `301`), `/Users/tomasgrasl/projects/nodejs/drobek/docs/TECHNICAL_DESIGN.md` §1 (schema gaps: blob refcount, `kek_id`, tombstones), `/Users/tomasgrasl/projects/nodejs/drobek/docs/ARCHITECTURE.md` §5/§7/§11 (CSP/SDK/email/origin gaps).

---

## Auditor 5

# drobek — Scope / Realism / Coherence Audit

## Blunt scope verdict

**M0 + M1a is genuinely buildable by a solo dev** — the auth/OAuth-AS/deploy/serving spine is ~70% proven in `puls-mcp`, and the roadmap's own 6–10wk skeleton / 9–14mo-for-all-of-M1 honesty is realistic and refreshingly un-padded. The product is **coherent as a concept** (PocketBase proves one box can be collections+auth+SDK+admin+static-serve), not four random things bolted together.

But two things undermine "buildable as scoped": (1) the **spine of the headline feature — blob storage + the upload endpoint — is specified three mutually-incompatible ways across the four docs**, so U6 literally cannot start without a reconciliation that hasn't happened; and (2) the **"foundation = M0 + ALL of M1" framing silently smuggles a second product (M1c: a whole separate end-user auth system + wildcard DNS-01 TLS with no DNS provider chosen + JS SDK) into the must-finish-first bucket**, which is what turns a shippable M1a into a 9–14 month deadlock.

- **Single biggest thing to CUT:** M1c (per-workspace apps-origin + wildcard TLS + end-user auth + SDK) out of "the foundation." It is public-SaaS multi-tenant machinery the stated wedge (company-internal self-host, which serves path-based same-origin) does not need.
- **Single biggest thing to NAIL:** one storage model + one signed-upload-endpoint contract. It's the only truly novel, non-portable piece and it's currently un-buildable due to contradiction.

---

## CRITICAL

**C1 — Blob storage (the product's spine) is specified three incompatible ways.**
Where: ROADMAP ratified **D2** (line 8, "local disk, NO MinIO, signed upload endpoint") vs ROADMAP **P0-B** (line 89, "MinIO container… bucket `drobek-blobs`… presigned-PUT") vs ARCHITECTURE **§8/§9** ("presigned `putUrl`s… PUT out-of-band to object store") vs TECHNICAL_DESIGN **§1** (`blobs(sha256 pk, content_type, bytes bytea)` — bytes **in Postgres**) + **§7** (open Q "PG↔disk threshold") vs ANALYSIS **§6** ("blob storage = PG for now"). So the deploy→store→serve spine is simultaneously local-disk, S3/MinIO, and Postgres-bytea. The MCP `deploy_init`→`putUrl`→out-of-band PUT sequence assumes S3-style storage, which matches *neither* the ratified disk decision *nor* PG-bytea.
Fix: Ratify ONE (D2 already says local-disk). Then propagate: delete MinIO from P0-B; drop `bytes bytea` from the `blobs` table (store hash+metadata in PG, bytes on disk); rewrite `deploy_init`/sequences so `putUrl` points at the drobek signed-upload endpoint, not an object store; close TECH §7's "PG↔disk threshold" open question.

**C2 — Phase 0 build instructions contradict the ratified hostname decision they implement.**
Where: ROADMAP ratified **D1** (line 7, apex `drobek.app` + `mcp.drobek.app`, **reuse the kept cert**, `noindex`) vs the entire body — **§1 D1 table** (line 48), **§3 Phase 0** (lines 81, 101–102), **§5 U5** (line 136), all of which say `beta.drobek.app` + `mcp-beta.drobek.app` and **"issue a fresh HTTP-01 cert."** USER_FLOWS already uses apex (`drobek.app/<me>/app/dashboard`, `mcp.drobek.app`). A builder following Phase 0 verbatim will issue an unneeded cert and stand up beta subdomains the owner explicitly overruled.
Fix: Rewrite §3/§5 to apex + kept-cert + `noindex`; delete the "fresh HTTP-01 cert" step and the `mcp-beta` naming caveat; align the skeleton DoD curls to `drobek.app`/`mcp.drobek.app`.

---

## HIGH

**H1 — "Foundation = M0 + all of M1" (D5) is the silently-huge item; it contradicts WIP=1 / deployment-first.**
Where: ROADMAP **D5** (line 11) + §5 Phase 3 **U11** (line 146). M1c bundles a *second* full auth system (`workspace_end_users`, separate from drobek accounts, email+Google+GitHub+CSRF+SSO) **and** net-new wildcard `*.apps.drobek.app` DNS-01 TLS — for which **R5** (line 164) admits no DNS provider is even named. Declaring all of that "the foundation that must finish before M2" is exactly the all-at-once deadlock the roadmap elsewhere warns against.
Fix: Redefine foundation = **M0 + M1a only**. M1b and especially M1c become post-dogfood increments gated on a real design-partner need (matches ANALYSIS §5 "treat M1a as a public milestone, then decide").

**H2 — The build prioritizes the table-stakes and defers the moat (POSITIONING incoherence).**
Where: POSITIONING **§2/§5** explicitly: moat = self-host + bundle + **governance**; "MCP deploy is table stakes"; "**Don't market the deploy**"; "pull governance (roles, audit log, proxy, team-only visibility, SSO) **up** in priority." But the build defers the governance: `audit_log` exists in TECH §1 yet **no M1 unit writes to it**; proxy = M2; visibility beyond `public` = thin in M1a (ARCH §5 "Apps always public v1"); full dashboard/audit = M3 (U18/U19). Meanwhile the deploy "wow" and public-SaaS apps-origin are front-loaded — i.e., the thing positioning says is *not* the story is the priority, and the differentiators are pushed out.
Fix: Pull `audit_log` writes + `team-only` visibility into M1a (both cheap, both define the "sanctioned internal fleet" pitch). Keep proxy in M2 but tag it a differentiator, not a chore.

**H3 — Wildcard apps-origin is over-engineering relative to the stated wedge.**
Where: ARCHITECTURE **§5** says default serving for the internal self-host case is **hardened same-origin, path-based** (no wildcard needed); the per-workspace apps-origin + wildcard cert exists only for **public-SaaS multi-tenant isolation**. POSITIONING §5.6 says "don't over-invest in public-SaaS growth early; the wedge is company-internal." Yet ROADMAP builds wildcard DNS-01 TLS as part of the foundation (U11, R5).
Fix: Cut wildcard/apps-origin from the foundation; ship end-user auth later on same-origin (or a per-customer custom domain) when a paying design partner actually needs cross-app SSO.

**H4 — The signed upload endpoint — the one novel, non-portable piece — has no contract.**
Where: ROADMAP ratified D2 (line 8) introduces "a drobek **signed upload endpoint** (agent PUTs out-of-band to drobek, not S3)" but specifies nothing; TECH **§2** `deploy_init` returns `uploads:[{putUrl}]` with no definition of how that drobek-hosted PUT is authenticated, size-capped, hash-verified, or expired. This sits on the M1a critical path (U6) and cannot be lifted from puls (puls has no blob-upload sink).
Fix: Before U6, write the contract in TECHNICAL_DESIGN: PUT auth (deploy-scoped token), server-side sha256 verification, per-file + quota size reject, TTL, idempotent re-PUT.

---

## MEDIUM

**M1 — Lint contract undefined though on the critical path.** ARCH §8 / ROADMAP U6 (line 137) say "strict lint, no chromium/puppeteer, hard errors block" — but name no linter, ruleset, or the block-vs-warn list. Novel, not portable. Fix: enumerate the rules and the hard-error set before U6.

**M2 — Brand/name flagged 🔴 unresolved while Phase 0 bakes it everywhere.** ARCH §19 + ANALYSIS scorecard list brand/name as open, yet D1 commits `drobek.app` apex + a real cert, and §2 commits GHCR package names (`drobek-selfhost-*`, `drobek-saas-*`) + AGPL repo names. A rename = broad rework. Fix: declare `drobek` final and close the open item, or rename before P0.

**M3 — Milestone vocabulary is inconsistent across docs (the "perpetually half-done" board).** ARCH §18 lists only M1/M2/M3 — **no M0**, and M1a/b/c aren't Linear milestones (D5, line 52); PHY-55 is misfiled M2 vs M1b. D5 flags this but ARCH §18 and Linear are not yet reconciled. Fix: re-cut Linear to slice-shaped tickets or document fractional-advance, and add M0/M1a/b/c to ARCH §18.

**M4 — `blobs.bytes bytea` would bloat the one shared Postgres on a 3.8 GB-RAM / 48 GB-disk box.** TECH §1. Beyond contradicting D2, PG-resident blobs balloon `pg_dump` backups and shared-instance memory. Fix: same as C1 — bytes on disk, PG holds only manifest/hash rows.

**M5 — Two heavy skeletons before a single feature front-loads the SaaS tax the positioning calls secondary.** ROADMAP §3 requires both repos + submodule + pnpm workspace + two drizzle journals + 4 GHCR images w/ visibility rules + lockfile-sync CI + private integration smoke + deploy-#2 rollback drill (the §0 table prices the two-repo/SaaS tax at 4–6 dev-weeks). The AGPL open-core split is genuinely load-bearing (don't cut the two repos), but the **private SaaS modules** could be deferred — M0 could ship the public core to prod first, adding the private shell when billing actually exists. Fix: keep the two-repo seam, defer drobek-web's *business modules* out of M0.

---

## Single most important finding (this lens)

**C1 — the blob-store + upload-endpoint spine is specified three incompatible ways (local disk vs MinIO/S3 vs Postgres bytea) across the four docs.** Everything downstream — `deploy_init`'s presigned `putUrl`, the out-of-band PUT, content-hash dedup, immutable serving, rollback, the entire "wow" flow — rests on this one unresolved choice. Until D2 is collapsed into a single storage model with a single, written upload-endpoint contract, the headline M1a feature (U6) is not "scoped," it's three drafts that contradict each other, and no amount of solo-dev capability lets you start it. Reconcile this **before** Phase 0, not during it.

Relevant docs (all `/Users/tomasgrasl/projects/nodejs/drobek/docs/`): `ROADMAP.md` (D1 line 7 vs §3 lines 81/101–102; D2 line 8 vs P0-B line 89; D5 line 11), `ARCHITECTURE.md` (§5, §8, §9, §18, §19), `TECHNICAL_DESIGN.md` (§1 blobs/audit_log, §2 deploy_init, §7), `POSITIONING.md` (§2, §5), `ANALYSIS.md` (§1 scorecard, §6), `USER_FLOWS.md` (flow A apex URLs).
