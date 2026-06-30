# drobek — Spec Review (multi-agent audit)

> 6-agent audit (consistency, technical, security, completeness, scope + synthesis), 2026-06-30.

# drobek Spec — Final Review (Lead Reviewer Synthesis)

Five auditors (consistency, technical, security, completeness, scope) converged hard. The signal is unambiguous: the *concept* is sound and M0+M1a is buildable, but the **two load-bearing pieces of the headline feature — blob storage and the origin/security model — are each specified multiple incompatible ways, and one of the ratified decisions (D1) is itself a security defect.** This is a NO-GO until a short, well-defined fix list lands.

---

## 1. Go / No-Go Verdict

**NO-GO for Phase 0 as written.** Do not start M0 until the four blockers below are fixed. Three are pure doc reconciliation (cheap, hours). One (the apex same-origin decision) is a genuine design reopening and is the only thing that should actually slow you down.

The good news: none of this invalidates the architecture. M0 (walking skeleton) + M1a (auth/OAuth-AS/deploy/serve) remains realistic for a solo dev — ~70% is provable against `puls-mcp`. You are reconciling a spec, not redesigning a product.

**MUST-fix before `git init` on Phase 0:**

| # | Blocker | Type | Effort |
|---|---------|------|--------|
| B1 | Collapse blob storage to ONE substrate (local-disk per D2) and wire a persistent volume into the deploy compose | doc + infra | hours |
| B2 | Resolve the apex same-origin admin-takeover defect — move ALL user content off any cookie-authed origin (this reopens D1) | **design** | 1–2 days to decide |
| B3 | Rewrite the entire ROADMAP §3/§5/§6 body from `beta.drobek.app`+fresh-cert to apex+reuse-cert+noindex | doc | hours |
| B4 | Specify the signed-upload contract: deploy-scoped token, **server-side sha256 verification**, size cap, TTL, idempotent re-PUT | doc | hours |

Everything else (HIGH/MEDIUM below) can be fixed during M0/M1a or scheduled, **except** the schema-shaped items (blob refcount, `kek_id`, tombstones) which are far cheaper to add to the M1a migration now than to retrofit.

---

## 2. Top CRITICAL Findings (deduped, ranked)

### CRIT-1 — Blob storage is specified three mutually-exclusive ways, and the deploy compose has no volume → every release wipes all hosted apps
*Flagged by all 5 auditors — the single most-cited finding.*

The product's spine is simultaneously:
- **Postgres `bytea`** — `TECHNICAL_DESIGN §1`: `blobs(sha256 pk, content_type, bytes bytea)`; `ANALYSIS §6` "PG for now"
- **MinIO/S3 object store** — `ROADMAP §3 P0-B` (MinIO container, `drobek-blobs` bucket, presigned-PUT); `ARCHITECTURE §8/§9` (out-of-band PUT to object store)
- **Local-disk content-hash files** — `ROADMAP Ratified D2` (the actual decision: pluggable store, default local disk, drobek signed-upload endpoint, NO MinIO)

Compounding (technical auditor): the puls `docker-compose.deploy.yml` drobek clones is **100% stateless — zero named volumes**; containers are recreated wholesale on each GHCR pull. Under D2, blobs on container-local disk are destroyed on every deploy.

**Fix:** Ratify D2 as the single source of truth and propagate everywhere:
- `TECHNICAL_DESIGN §1`: drop `bytes bytea`; `blobs` row stores `sha256 pk, content_type, size, path` (bytes on disk via the blob-store interface). Remove §7's "PG↔disk threshold" open question (moot under D2).
- `ROADMAP`: delete the MinIO container + `drobek-blobs` bucket from P0-B; rewrite R1/§7 to "local-disk store + drobek signed-upload endpoint."
- `ARCHITECTURE §3/§8/§19` + `ANALYSIS §6`: stop saying "PG for now"; `putUrl` points at the drobek endpoint, not an object store.
- **Infra:** add a named volume / host bind-mount (e.g. `/home/apps/drobek/blobs`) to the deploy compose, mounted into every container that writes-on-commit, the worker, and serving. Document in the deployment doc.

### CRIT-2 — Apex serves untrusted app JS on the same origin as the admin dashboard → full admin account takeover (the ratified D1 is itself the defect)
*Security auditor's #1; reinforced by technical H1 and completeness #8. This is NOT mere doc drift — D1 must be reopened.*

`Ratified D1` serves apps on apex `drobek.app/<ws>/app/<slug>`, same origin as the dashboard, with stated mitigations "path-scoped admin cookie" + "strict CSP." **Neither is a security boundary against first-party untrusted JS.** A cookie with `Path=/dashboard` is still sent on any same-origin `fetch('/dashboard/api/...', {credentials:'include'})`; HttpOnly blocks `document.cookie` reads but not credentialed same-origin requests; SameSite never triggers (same site); the attacker authors the CSP. An app deployed to `drobek.app/attacker/app/x` can drive every admin/data/MCP endpoint as the victim and scrape the anti-CSRF token off any dashboard page.

**Fix:** Make a **separate, cookie-isolated origin the floor for ALL user-served content** (auth and non-auth apps), not just auth apps. The dashboard apex must never serve user content. Options: a distinct registrable sandbox domain (e.g. `drobekusercontent.app`), or move the dashboard to its own subdomain and bind admin auth to that host (not path). Reopen D1 with this constraint. This must be resolved before *any* public exposure, including the `noindex` beta.

### CRIT-3 — ROADMAP body contradicts its own ratified D1: entire Phase 0 builds `beta.drobek.app` + a fresh cert
*Flagged by consistency (C3), completeness (#2), scope (C2).*

`Ratified D1` = apex `drobek.app`/`mcp.drobek.app`, **reuse the existing kept cert**, replace the apex→tomasgrasl redirect, `noindex`. But the whole body — `§1 D1 table`, `§3 P0-A…P0-F`, `§5 U5`, `§6 R1/R5`, the Skeleton DoD, "Relevant paths" — instructs a **fresh HTTP-01 cert** for `beta.drobek.app`/`mcp-beta.drobek.app`, new conf filenames, and curls the wrong health URLs. `USER_FLOWS.md` already uses apex, proving the body is the stale side. A solo dev executing Phase 0 verbatim builds the wrong hostnames and issues an unneeded cert — the exact multi-day stall the doc claims to prevent.

**Fix:** Rewrite §3/§5/§6/DoD to apex hostnames, reuse the existing SAN cert, keep `noindex`, delete the fresh-cert step. **Note the live trap (completeness #1):** `nginx/sites-available/drobek-redirect.conf` currently serves `return 301 https://www.tomasgrasl.cz/` on :80 **and** :443. A 301 is cached indefinitely — every client that has hit `drobek.app` holds a permanent redirect and will never reach the new app. Before cutover, serve a `no-store` de-poisoning window, or accept apex is burned for cached clients. (This is independent leverage for CRIT-2: a never-redirected separate sandbox origin sidesteps both.)

### CRIT-4 — Signed upload does not verify body == claimed sha256 → cross-tenant blob poisoning
*Technical C2 + Security C2.*

`deploy_init` trusts the client manifest's `sha256`; the worker only checks blob *presence*, not integrity (`TECHNICAL_DESIGN §5` "validate manifest complete"). `blobs.sha256` is a **global PK with no workspace scoping** and blobs are deduped globally — so storing arbitrary bytes under any hash poisons every app that dedups to it. Neither S3 presigned-PUT nor a naive local endpoint catches this.

**Fix:** The upload sink MUST stream-hash the received body, compare to the path-embedded sha256, and reject on mismatch before the bytes become committable. Keep the upload sink in-app (aligns with D2 — S3 can't do this for you). State it in `ARCHITECTURE §8` and `TECHNICAL_DESIGN §5`.

### CRIT-5 — Content-addressed blobs are globally deduped with no refcount → app/deploy delete corrupts or orphans cross-tenant content
*Completeness #3 + Security C3-adjacent + technical M4.*

Blobs dedup across workspaces by sha256 but there is no refcount/ownership table. App-delete or GC will either orphan blobs (disk-fill on the single 48 GB box) or delete a blob another tenant's deploy still references → cross-tenant 404/serving corruption.

**Fix:** Add `blob_refs(sha256, deploy_id)` (or a refcount column) to the **M1a schema now**, even if GC ships at M2. Retrofitting refcounts after blobs are shared is painful. Also scope the `deploy_init` "missing files" response to blobs the requesting workspace already references (technical M3 — otherwise it's a cross-tenant existence oracle).

### CRIT-6 — AGPL §13 self-compliance may legally compel the private SaaS edition open — voiding the entire moat
*Completeness #4 — the highest-leverage non-technical finding.*

`drobek-web` (private SaaS) imports `@drobek/*` AGPL-3.0 packages and runs as a network service. AGPL §13's network-interaction copyleft can extend source-disclosure to the *combined work* — i.e. the private billing/SSO modules that POSITIONING §5 calls "the moat." POSITIONING treats AGPL only as buyer-aversion and never asks this prior question.

**Fix:** Resolve before writing any private-module code: sole-copyright + dual-license (license the core to yourself under non-AGPL terms), a CLA, or a verified arms-length module/API boundary that avoids "based on" combination. Unwinding this after billing/SSO exist is far costlier. The two-repo seam itself is sound — do not cut it; just make the license structure clean.

---

## 3. Doc Drift to Repair (concrete edits vs ratified decisions)

Ground truth = `ROADMAP` "✅ Ratified decisions (2026-06-30)". Where a doc disagrees, the doc is wrong.

| ID | File / Section | Says (wrong) | Should say (ratified) |
|----|----------------|--------------|------------------------|
| D-blob | `TECHNICAL_DESIGN §1`, `§7`; `ARCHITECTURE §3/§8/§19`; `ANALYSIS §6`; `ROADMAP §1-D2/§3-P0-B/§6-R1/§7` | `bytea` in PG / MinIO / "PG for now" | Local-disk content-hash store, drobek signed-upload endpoint, no MinIO, no `bytea` (CRIT-1) |
| D-host | `ROADMAP §3 P0-A…F`, `§5 U5`, `§6 R1`, DoD, "Relevant paths" | `beta.drobek.app`/`mcp-beta`, fresh HTTP-01 cert | apex `drobek.app`/`mcp.drobek.app`, reuse kept cert, `noindex` (CRIT-3) |
| D-vis | `ARCHITECTURE §3` (`visibility=public` hardcoded), `§5` ("Apps always public v1") | always public | three-mode `public\|team\|password` (matches `TECHNICAL_DESIGN §1/§6`, `ROADMAP U7`, `USER_FLOWS §D`). Reconcile `ANALYSIS §6`'s "visibility deferral" with U7 shipping team/password in M1a |
| D-m0 | `ARCHITECTURE §18`, `ANALYSIS §2–3` (only M1a/b/c/M2/M3) | no M0 | Add M0 walking-skeleton milestone (per Ratified D5) |
| D-sa | `TECHNICAL_DESIGN §1` `memberships.role` enum includes `super-admin` | per-workspace super-admin row | super-admin is global, env-bootstrapped via `SUPERADMIN_EMAIL` (matches `ARCHITECTURE §6`, `USER_FLOWS §E`). Drop from enum; model as a global flag |
| D-dns | `ROADMAP §6 R5`, `§5 U11`; `ANALYSIS §4` ("no provider named") | unnamed DNS provider | Hostinger (`*.dns-parking.com`, DNS-01 via Hostinger API). Downgrade R5 to "wire Hostinger API token" |
| D-linear | `ROADMAP §5 U10` vs `§1 D5` (PHY-55 M2 vs M1b; M1a/b/c not real Linear milestones) | self-contradictory board | Re-cut Linear to M0/M1a/M1b/M1c, move PHY-55 to M1b, *before* relying on the per-slice "Linear updated" gate |
| D-cos | `ARCHITECTURE §10/§12` "Variant 1/2" labels; deploy token `ready` vs `live` (`U6` vs `TECHNICAL_DESIGN §2`); SPA fallback `open`/`on`/`spa\|exact` | stale terminology | Drop "Variant"; pick one terminal token; normalize to `spa\|exact` enum |

---

## 4. High / Medium Findings by Theme

### Theme A — Origin / cookie / multi-tenant isolation (beyond CRIT-2)
- **Sibling-subdomain cookie tossing (Security C3):** open signup auto-creates `attacker.apps.drobek.app`; absent a PSL entry, it can set `Domain=.apps.drobek.app` → end-user session fixation/theft on `victim.apps.…`. **Fix:** host-only `__Host-`-prefixed cookies, add `apps.drobek.app` to the Public Suffix List, bind sessions server-side to the exact workspace host.
- **CSP/CORS vs SDK contradiction (Completeness #8, technical H1):** auth apps live on `<ws>.apps.…` but the data REST is on the path-origin → cross-origin, dragging in CORS+credentials+CSRF that "strict CSP" breaks. **Fix:** serve the data API same-origin under `<ws>.apps.…`; ship a CSP template the SDK+data API are guaranteed to satisfy.
- **Static-app CSRF delivery unspecified (technical M5):** double-submit token has no delivery mechanism for a server-render-less static blob. **Fix:** specify a `/__drobek/auth/csrf` endpoint or non-HttpOnly cookie; pick opaque server-side sessions and close `TECHNICAL_DESIGN §7` before M1c.

### Theme B — Tenant data isolation
- **No Postgres RLS → IDOR on by-id record ops (Security H1):** only app-level `WHERE app_id=`; one missing predicate leaks/mutates another tenant's doc. **Fix:** RLS keyed off a per-request `app_id`/`workspace_id` GUC as defense-in-depth; opaque ids; one centralized scoped query builder.
- **jsonb `where`/`sort` injection + no indexes (Security M3, technical M2):** arbitrary field comparison risks injection; `(app_id, collection)` is the only index → seq-scan + filesort. **Fix:** allowlist sortable fields against the collection JSON Schema, parameterize all jsonb paths, cap `limit`, add GIN(`doc` jsonb_path_ops) + composite `(app_id, collection, created_at desc)`.

### Theme C — OAuth AS rework underestimated (technical H3, security H4)
puls' token model is **incompatible**: (a) puls binds tokens to one `shopId` at consent — drobek needs user-scoped tokens with per-call workspace/role authZ; (b) puls advertises only `authorization_code` — drobek's `refresh_token` grant is net-new; (c) puls' `validateBearer` does no audience check and has no `audience` column — drobek's "aud-bound" claim is unimplemented. Open DCR also needs exact-string redirect_uri match + consent UI naming workspace+scopes. **Fix:** re-spec U5 as *build, not port*: user-bound tokens, refresh+rotation, RFC 8707 `audience`/`resource` column validated in mcp-server middleware, exact redirect matching, per-tool-call membership re-check.

### Theme D — Worker / queue (net-new, not in puls)
- **No worker service in the compose (technical H4):** puls has no BullMQ dependency and the compose is `web + mcp-server + pg + redis`. CPU-heavy untrusted-app linting can't run under puls' 768M/0.8-CPU `web` limits. **Fix:** name a 4th `drobek-worker` container sharing blob volume + DB + redis; add to compose + DoD.
- **ioredis config traps (technical M1):** puls' `getRedis()` hardcodes `maxRetriesPerRequest:2` — BullMQ requires `null`; ioredis `keyPrefix` is unsupported by BullMQ (needs its own `prefix`). The `drobek:` namespace silently won't apply. **Fix:** dedicated BullMQ connection(s) with `maxRetriesPerRequest:null, enableReadyCheck:false`; set BullMQ `prefix`.
- **No failure semantics (Completeness #14):** no retry/backoff/dead-letter/timeout; a wedged job leaves a deploy stuck in `linting` forever. **Fix:** define retry/backoff, max-attempts→`failed`, job timeout, dead-letter + requeue.

### Theme E — Migration / two-journal model (technical H2, completeness #11)
Cross-schema FKs are hand-waved: web tables FK to core `workspaces`/`users`, but `drizzle-kit generate` on the web journal will try to emit DDL for core tables it sees. No `tablesFilter`/`schemaFilter` is set. No cross-pass atomicity: core-OK + web-FAIL = half-migrated prod. **Fix:** set `tablesFilter` to the private-table list in the web `drizzle.config.ts`; P0-C must prove a private table that **actually FKs to `workspaces`** (current plan adds a trivial FK-less table — it doesn't exercise the risk); define pass ordering (core→web), partial-failure repair, and a rule that core migrations stay additive while any web table FKs into them.

### Theme F — Quota / disk / DoS (Security H2, completeness #10/#13)
- Quota is checked against *declared* manifest bytes, not the actual body → out-of-band PUT can overrun and fill the shared 48 GB box. **Fix:** bind max-content-length into each signed PUT, enforce at the sink with a hard byte cap, re-check quota against stored bytes, add a global disk ceiling.
- Disk-full is the most probable outage and is unmonitored (Ops scored ✅ but covers only app errors). No log rotation despite CLAUDE.md mandating it. **Fix:** add disk-usage + queue-depth alerting and Docker JSON log rotation **in Phase 0**.
- Orphaned uploads (presigns that never `deploy_commit`) + concurrent `deploy_commit` races on `active_deploy_id`. **Fix:** upload TTL + orphan sweep, per-app advisory lock for deploy serialization.

### Theme G — Secrets / crypto (Security M2, completeness #6)
`DROBEK_MASTER_KEY` envelope encryption was chosen to enable KEK rotation, but there is **no `kek_id`/`key_version` column** on `upstream_secrets` and no rewrap procedure — so rotation is impossible and you can't tell which secrets are under which KEK. **Fix:** add `kek_id` to the schema **now** (M1a), write the rewrap procedure; same gap (less acute) for session-secret and OAuth-signing rotation.

### Theme H — Auth hardening (Security M4, completeness #5)
6-digit magic codes for both admin and end-user auth depend entirely on lockout. End-user email is the operator's domain sending login codes for third-party apps → deliverability/DMARC/abuse undesigned; open signup on a public apps-origin is a mail-bomb/SMTP-cost amplifier. **Fix:** hard per-code attempt cap (5→invalidate), per-email AND per-IP throttle, single-use codes; per-workspace sender identity + SPF/DKIM/DMARC alignment + bounce/suppression handling; per-recipient signup rate limits before M1c.

### Theme I — Proxy SSRF (Security M1)
"Resolve DNS once" risks rebinding TOCTOU and misses ranges. **Fix:** resolve once and **connect to the pinned IP**; block private/loopback/link-local + `169.254.169.254`, `0.0.0.0`, CGNAT `100.64/10`, IPv6 ULA/link-local/`::1`/IPv4-mapped; deny redirects; validate every request.

### Theme J — Scope discipline (scope H1/H2/H3, M5)
- **M1c does not belong in "the foundation" (D5).** It smuggles a second full auth system (`workspace_end_users` + email/Google/GitHub/CSRF/SSO) **and** wildcard `*.apps.drobek.app` DNS-01 TLS into the must-finish-first bucket — the all-at-once deadlock the roadmap elsewhere warns against, contradicting WIP=1. **Fix:** redefine foundation = **M0 + M1a only**; M1b/M1c become post-dogfood increments gated on a real design-partner need. Cut wildcard/apps-origin from the foundation; ship end-user auth later when a paying partner needs cross-app SSO.
- **Build defers the moat (POSITIONING incoherence).** POSITIONING says governance (roles, audit log, team-only visibility, proxy, SSO) is the moat and "don't market the deploy" — yet `audit_log` exists in the schema with **no M1 unit writing to it**, visibility-beyond-public is thin in M1a, and full audit is M3. **Fix:** pull `audit_log` writes + `team-only` visibility into M1a (both cheap, both define the "sanctioned internal fleet" pitch).
- **Brand/name flagged unresolved while Phase 0 bakes `drobek` into apex cert + GHCR package names + AGPL repo names.** **Fix:** declare `drobek` final and close the open item, or rename before P0.

### Theme K — Lifecycle / legal gaps (completeness #7/#9/#12/#15/#16)
- **Non-happy serving paths entirely unspecified:** 404, hibernated, quota-exceeded, suspended, password-gate page, and critically how a `team-only` static app authenticates an anonymous visitor (the server gate must redirect — a static blob can't). **Fix:** define gate responses (status + branded pages) + the team-login redirect handshake.
- **Lint ruleset undefined** though run on every deploy (the headline DX). **Fix:** enumerate blocking rules vs warnings as a versioned contract agents key off.
- **Immutability vs GDPR erasure / DMCA takedown is structurally undesigned** — immutable deploys + append-only audit + dedup blobs are the opposite of erasure; no tombstone columns exist. **Fix:** add soft-delete/tombstone semantics to the schema now; decide how erasure reconciles with shared content-addressed blobs.
- **Platform is silently a data processor** for hosted apps' end-users (collects PII it didn't author for). **Fix:** document the controller/processor split and the self-host operator's inherited obligations.
- **SDK breaking-change path is impossible by construction** — immutable apps pin `/sdk@1.js`, so `sdk@2` can never reach deployed apps. **Fix:** declare sdk@1 forever-frozen / additive-only and document the contract.

---

## 5. What's Genuinely Solid (do NOT re-litigate)

- **The concept is coherent**, not four things bolted together — PocketBase proves one box can be collections + auth + SDK + admin + static-serve.
- **M0 + M1a is realistically scoped for a solo dev.** The roadmap's own 6–10wk skeleton / 9–14mo-for-all-of-M1 honesty is un-padded and credible. ~70% of the auth/OAuth-AS/deploy/serve spine is provable against `puls-mcp`.
- **Queue = BullMQ is consistent everywhere**; no stray `pg-boss` reference exists. (The *integration* needs work per Theme D, but the choice is settled.)
- **Apps-origin is per-workspace** (`<ws>.apps.<host>/<slug>`) consistently across all docs — no per-app drift.
- **M1b/M1c content split** (M1b = data API + `record_*`; M1c = SDK + end-user auth + wildcard) agrees across all docs. (The dispute is *sequencing* — Theme J — not content.)
- **The two-repo AGPL open-core seam is load-bearing and correct** — keep it; only the *license structure* (CRIT-6) and the *private business modules' timing* (scope M5) need attention, not the split itself.
- **`USER_FLOWS.md` is the most internally-consistent doc** (apex URLs, `ready` token, visibility gating) — when the ROADMAP body and USER_FLOWS disagree, USER_FLOWS is reliably the correct side.

---

### Bottom line
Fix B1–B4 first (one storage substrate + volume, the origin-isolation design decision, the apex hostname rewrite, the upload-endpoint contract). Add the three schema-shaped items (blob refcount, `kek_id`, tombstones) to the M1a migration while you're in there — they are nearly free now and expensive later. Then M0 is a go. The spec is ~85% sound; the missing 15% is concentrated in exactly the two places that carry the whole product (storage spine + origin security), which is why it reads as NO-GO despite strong bones.

Docs referenced: `/Users/tomasgrasl/projects/nodejs/drobek/docs/{ROADMAP,ARCHITECTURE,TECHNICAL_DESIGN,USER_FLOWS,ANALYSIS,POSITIONING}.md`; live redirect `/Users/tomasgrasl/projects/server/srv1069065-vps/nginx/sites-available/drobek-redirect.conf`.
