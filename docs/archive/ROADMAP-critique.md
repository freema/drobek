# drobek — Roadmap adversarial critique (raw)

## Critique 1

Verified the load-bearing claims against the actual reference files. Here is the adversarial review.

---

# Adversarial review — drobek roadmap, through the SOLO-DEV REALISM & SCOPE lens

**Verdict:** The FEASIBILITY draft is honest and largely correct, and it quietly contradicts the other three drafts. INFRA and SEQUENCE are written in "I have everything, copy puls verbatim, this is a few days" voice; FEASIBILITY says the same foundation is 6–10 weeks and the whole thing is 7–11 months. Both can't be true. The roadmap's real risk isn't capability — it's that **three of the four drafts plan as if the monolithic "all 45 done, no half-done, e2e on prod per part" interpretation is fine, while the fourth proves it isn't.** On top of that, several "copy verbatim / already solved" claims are factually wrong, and at least one piece of core infrastructure (object storage) is missing entirely from a deploy-engine product that is *built around* it.

## A. Internal contradictions (verified against the files — these are concrete, not stylistic)

1. **The walking skeleton fails its own first smoke test.** INFRA §2 defines `coreHealth()` → `{ok, core}` and the `/healthz` loaders return exactly that (`{ok:true, core:'0.0.0', edition:'saas'}`). E2E §3a ports puls' `healthz.spec.ts`, which asserts `b.db === 'up'` and `b.redis === 'up'`. I confirmed puls' real `healthz.tsx` calls `runHealthChecks()` returning `{ok, db, redis}` with a 503 when a dep is down (`apps/web/app/lib/health.ts`). The drobek skeleton's health endpoint **checks neither Postgres nor Redis and always returns 200.** So (a) the very first ported spec red-fails, and (b) the endpoint that is supposed to *prove the deployment-first pg/redis path works* proves nothing about pg/redis. The whole "deploy a skeleton to verify the wiring" premise is undermined by a health check that doesn't touch the wiring.

2. **`/api/version` spec asserts a field the ported route doesn't return.** E2E §3a asserts `v.sha` matches a git-sha regex. puls' real `api.version.tsx` returns `{name, version, buildTime}` — no `sha`. INFRA ships no version route at all. Two "port verbatim" specs, two guaranteed red on day one.

3. **Apex vs beta domain is unresolved and the drafts pick opposite answers.** INFRA §0 chooses apex `drobek.app` and sells the benefit "reuse existing cert, **no new certbot**." I verified `drobek-redirect.conf`: the cert SAN covers `drobek.app www.drobek.app mcp.drobek.app` — apex path is real. But E2E §2 and SEQUENCE both target `beta.drobek.app` / `mcp.beta.drobek.app`, which are **not** on that cert → that path **does** need a fresh certbot issuance, erasing the stated benefit. You cannot have both "no new cert" and "beta subdomain." Pick one before writing nginx.

4. **The prod seed backdoor lives on the production apex in the chosen model.** E2E §5 ships `/test/seed-session` (mints a logged-in session, gated only by `E2E_ENABLE_SEED` + a bearer). It says "in real prod it's off." But in INFRA's apex-reuse model, **beta *is* `drobek.app` — there is no separate prod.** So the headline "deploy to prod from day one" plus "seed endpoint on beta" = a standing session-minting auth-bypass on the public production domain that will later host untrusted user apps and real workspaces. The domain contradiction (item 3) directly creates a security hole.

5. **Linear tracks horizontal tickets; the plan ships vertical slices — so every slice leaves multiple tickets "half-done."** SEQUENCE maps 43 tickets onto ~26 units where each unit "advances PHY-53/70/71/76…" across 4–6 places. Under the owner's literal rule ("if a task is half-done it's shit, keep going until ALL Done"), a slice-based plan guarantees the Linear board shows many partially-advanced tickets at all times. SEQUENCE even admits M1a/M1b/M1c aren't Linear milestones and PHY-55 is misfiled under M2. **The board will look perpetually half-done — which is exactly the failure state the owner fears most.** FEASIBILITY resolves this by redefining "done" at slice level, but nobody reconciles Linear to match. This is the methodology landmine.

## B. Silent scope balloons (the stuff that isn't in the drafts but has to be built)

6. **Object storage is missing — and it's the spine of the product.** The headline deploy loop (INFRA §-implied, SEQUENCE U6, E2E §3c) is "`deploy_init` returns **presigned PUT URLs** → agent uploads **out-of-band** → drobek never sees disk → content-hash **blob store** → serve." Presigned PUT + out-of-band upload **requires S3-compatible object storage**. The infra inventory has shared-postgres, shared-redis, nginx — **no S3/R2/MinIO anywhere.** E2E §3c literally does `request.put(f.url, ...)` against an unspecified target. This is the single largest unlisted dependency: you must either stand up MinIO (another container + disk + backups + lifecycle/GC, and GC is punted to U17/PHY-80) or adopt R2/S3 (external creds + cost + egress + a new failure mode in the deploy path). Until this is decided, U6 — the actual product — cannot start, and "deployment-first" can't even scaffold its acceptance test. This belongs in Phase 0, not implied at U6.

7. **The two-repo schema-coexistence problem is never addressed — and it's the integration risk the foundation claims to de-risk.** Schema lives in core `packages/db`; migrations are generated there and applied by the private repo (INFRA §6). But drobek-web's whole reason to exist is private modules (`packages/billing`, tiers, notifications, feedback) **with their own tables.** Drizzle migrate runs one `out` folder against one DB with one `__drizzle_migrations` journal. How do private billing migrations coexist with core migrations against the same `drobek` DB? Two drizzle configs = two journals = unmanaged ordering and cross-dependency. The skeleton's "integration proof" (private re-exports `coreHealth()`) exercises **none** of this. The genuinely risky integration surface — private repo adding its own schema, overriding core routes, bumping the pinned submodule — is exactly what U0/U9 declare "proven" while testing a trivial re-export.

8. **"Copy puls' Dockerfile.prod verbatim, change only the package list" is false for the private repo.** I checked: puls is single-repo, no submodule, and has exactly one `pnpm-workspace.yaml`. drobek-web introduces **a git submodule AND a nested workspace** (core ships its own `pnpm-workspace.yaml`; drobek-web globs `core/packages/*`). pnpm resolves the workspace root by walking up — a nested `pnpm-workspace.yaml` inside `core/` plus two separate lockfiles (core's own vs drobek-web's) is a known footgun that puls never had to solve. The prod Dockerfile must additionally `COPY core/packages/*/package.json` into the deps stage in the right order, and the two lockfiles will drift. This is net-new, unproven, and the place a solo dev loses two days mid-flight.

9. **Wildcard TLS / DNS-01 has no DNS provider identified.** FEASIBILITY correctly flags `*.apps.drobek.app` (M1c) as genuinely new infra. The existing estate is 100% HTTP-01 webroot (confirmed by the `acme-challenge` location in `drobek-redirect.conf`). DNS-01 needs the drobek.app DNS zone's provider API token + a certbot dns plugin — **the provider is never named.** And serving untrusted user apps on `*.apps.drobek.app` under a wildcard cert adds subdomain-takeover and cookie-scoping concerns. INFRA/SEQUENCE bury this as a one-line "wildcard cert" at U11; FEASIBILITY says spike it early. The drafts disagree with each other; FEASIBILITY is right.

10. **Cert-renewal footgun on the nginx swap.** INFRA §8 says `rm drobek-redirect.conf` and replace with cloned `pulsmcp-*.conf`. The existing cert renews via the `acme-challenge` webroot location currently in the redirect conf. If the new site configs don't carry that exact `location /.well-known/acme-challenge/ { root /var/www/certbot; }`, renewal silently fails ~60 days later. `certbot renew --dry-run` once after the swap (which they do mention) catches it only if you remember the webroot must be preserved in the new files.

## C. Unrealistic claims / estimates

11. **Unit granularity hides 20x effort variance.** SEQUENCE presents U0 (scaffold) and U6 (entire deploy engine: presigned upload + content-hash dedup + BullMQ worker + strict lint + immutable versioning + SSE progress + rollback + audit) as **single equal checkboxes.** U6 alone is 2–3 weeks; U0 is a day. A 26-checkbox list reads as "26 even steps" and will wreck the solo dev's sense of pace and estimation. FEASIBILITY's 6–9 weeks for M1a is the honest number; the checkbox format actively hides it.

12. **27–41 dev-weeks under-prices the per-part prod ritual.** The methodology requires, *per ticket*: localhost e2e + prod-beta e2e + chrome-devtools acceptance (snapshot/console/network/screenshot) + Linear update. FEASIBILITY itself lists the flakiness sources (email delivery, OAuth redirect-URI local↔prod drift, DNS propagation, TLS cold starts) but the estimate doesn't multiply them across ~45 tickets. And "dev-weeks" ≠ calendar weeks for a solo dev "with life included" — communicate the calendar figure (closer to 9–14 months) or the owner will read 7–11 months as a commitment and feel behind by week 6.

13. **"I have everything I need" is the recurring tell.** All four drafts open with a confidence claim ("I have everything I need", "the exact working template", "verified against live Linear"). Three of them are then contradicted by the files (items 1–4, 6–8). The phrase is doing motivational work, not engineering work.

## D. What to cut / defer (scope realism)

- **Cut all of Phase 5 / M3 business modules (U18–U26) out of "the foundation" framing.** billing/tiers, marketing, GDPR/DSAR, notifications, Sentry, custom domains are drobek-web revenue features, not open-core, and not deployment-first. They can lag indefinitely without violating the directive. Keeping them in the same "must all be Done" bucket is the deadlock.
- **Defer the wildcard/per-workspace apps-origin (M1c/U11) decision item, but spike the cert issuance now** as a throwaway (issue `*.apps.drobek.app` once, serve one page) so the known-unknown is retired before anything depends on it.
- **Collapse the e2e gate tiers as FEASIBILITY says:** full suite local per part, thin `@smoke` (no DB, no seed) on prod per part, full `@beta` nightly. The drafts already half-say this but the DoD in E2E §6 still demands prod-beta green + chrome-devtools screenshot *per ticket*, which reintroduces the per-part flakiness tax. Pick the tiered version and delete the per-ticket prod-green requirement.

## Three highest-impact fixes

1. **Provision object storage before anything else, and put it in Phase 0.** The entire deploy product (presigned upload, content-hash blob store, immutable serving, rollback) is built on an S3-compatible store that exists nowhere in the infra. Decide MinIO-on-VPS vs R2/S3 now, stand it up, and make the walking-skeleton acceptance include one real presigned PUT round-trip. Without this, U6 — the actual point of drobek — has no ground to stand on, and "deployment-first" can't scaffold its own headline test.

2. **Make the walking skeleton actually prove the two risky things it claims to prove: dependency wiring and cross-repo schema.** Replace the toy `coreHealth()` with the real puls-style `runHealthChecks()` (pg + redis ping, 503 on down) so `/healthz` validates the deployment path and the first ported spec passes. And add one **private-repo-owned table + its migration** to the skeleton so U0/U9 prove the private repo can extend the schema alongside core — the integration risk that a `coreHealth()` re-export completely sidesteps. Resolve the one-DB / two-migration-journal question here, on day one, not at M3 when billing tables arrive.

3. **Reconcile the planning unit and lock one domain model — then redefine "done" explicitly.** Adopt FEASIBILITY's WIP=1 vertical-slice "done," but make Linear match it: either re-cut the board into slice-shaped tickets or accept (in writing) that horizontal tickets advance fractionally — otherwise the board reads perpetually half-done, which is the owner's stated nightmare. Simultaneously pick **apex `drobek.app` xor `beta.drobek.app`** (this single choice determines: new cert yes/no, where the `/test/seed-session` backdoor lives, and whether the apex is "pristine for launch"), and delete the seed endpoint from any internet-facing prod origin in favor of network-isolated seeding.

**Bottom line:** doable by one person if re-scoped to WIP=1 slices with M3 cut from the foundation — but not as four mutually inconsistent drafts. Before writing code, force the four drafts to agree on five values (domain, object store, health contract, the private-schema migration model, and the definition of "done" + its Linear mapping). Today they don't, and each disagreement is a multi-day stall waiting to happen.

Files verified: `/Users/tomasgrasl/projects/server/srv1069065-vps/nginx/sites-available/drobek-redirect.conf` (cert SANs, webroot renewal), `…/docs/RUNNING_APPS.md` (3041/3042 free, no object storage in inventory), `/Users/tomasgrasl/projects/nodejs/puls-mcp/apps/web/app/lib/health.ts` + `routes/{healthz,api.version}.tsx` (real health/version contracts), `…/pnpm-workspace.yaml` + `apps/*/package.json` (workspace:*, no submodule, single workspace), `…/apps/web/Dockerfile.prod` (build order, explicit per-package COPYs), `…/tests-e2e/global-setup.ts` (unconditional TRUNCATE), `…/.github/workflows/deploy.yml` (job graph, migrate via `--filter web`).

---

## Critique 2

Grounding confirmed. I read puls-mcp's actual `Dockerfile.prod`, `deploy.yml`, `docker-compose.deploy.yml`, the package layout, and both greenfield drobek repos. Here is the adversarial review through the two-repo integration & release-coupling lens.

---

# Adversarial review — TWO-REPO INTEGRATION & RELEASE COUPLING

**Bottom line up front:** the skeleton "works" on day 1 only because it carefully arranges to have *zero* real coupling — one `users` table in core, zero private tables, no second consumer of the schema, a trivial re-export as the "integration proof." Every load-bearing two-repo problem is deferred to the first moment the private SaaS actually diverges from core, which is M1a/M3, not M2. The drafts repeatedly assert "copy puls verbatim / identical ergonomics to puls," but **puls is single-repo, single-lockfile, single-migrations-folder.** Almost every place the roadmap says "mirror puls" is exactly where the second repo breaks the mirror. The infra draft and the feasibility draft also openly **contradict each other** on how much the two-repo tax costs.

## Holes, ranked by impact

### 1. Private schema and migrations have nowhere to live — the deepest hole, entirely unaddressed (INFRA §6)
Verified against puls: `drizzle.config.ts` lives at `apps/web/drizzle.config.ts`, migrations at `apps/web/drizzle/migrations`, and CI runs `pnpm --filter web db:migrate` (deploy.yml migrate job). `drizzle-kit migrate` applies **one migrations folder to one database, tracked by one `__drizzle_migrations` journal table.**

The roadmap puts schema + migrations in **core** (`core/packages/db/drizzle/migrations`), i.e. the **public AGPL repo**. But `drobek-web` exists precisely to add private tables: billing/tiers, feedback inbox, notifications, custom domains. Those tables have nowhere to go:
- Put them in core → you leak the private business model (billing schema, tiers) into the AGPL repo. Defeats the entire reason for two repos.
- Put them in a private `packages/billing` schema with a **second** migrations folder → you now run two `db:migrate` passes against the same `drobek` DB, and drizzle's default journal table collides unless you explicitly set distinct `migrations.table`/`schema` per config. The roadmap never mentions this and the skeleton never exercises it.
- The single-folder model **works in the skeleton only because there are zero private tables.** So the headline acceptance ("a drizzle migration ran against shared-postgres") proves nothing about the coupling it's meant to de-risk. The wall is hit the first time *any* private table is needed — which is M1a-adjacent, not far-future.

This is a "discover it mid-flight and it hurts" item the feasibility draft itself warned about, and the infra draft walked straight into it.

### 2. `--frozen-lockfile` + two lockfiles + submodule bumps — the infra draft contradicts itself (INFRA §1, §4, §5)
puls's Dockerfile deps stage, prod-deps stage, quality-gate, and migrate job **all** run `pnpm install --frozen-lockfile`. In `drobek-web`, `pnpm-lock.yaml` must stay in sync with `core/packages/*/package.json`, which live **inside the submodule**.

Consequence: any submodule bump that touches a core package's dependencies (add a dep, bump a version) **invalidates the private lockfile**, and every `--frozen-lockfile` install (build, typecheck, migrate) fails until you regenerate and commit the private lockfile. INFRA §1 claims "CI just runs `git submodule update --init`" and "zero registry infra… identical ergonomics to puls." That is false: the correct sequence is `submodule update → pnpm install (regenerate lock) → commit lock → release`. The feasibility draft contradicts the infra draft directly ("every `packages/*` change → bump core → … the submodule decision is load-bearing"). The infra draft is the optimistic one and it's the one that's wrong.

Also: **two lockfiles, one core.** Core's own `pnpm-lock.yaml` and drobek-web's lockfile independently resolve the same `core/packages/*` deps, so core can resolve to **different transitive trees** in self-host (public lock) vs SaaS (private lock) — different React Router patch, different `drizzle-orm`. "Reproducible (submodule pin = a SHA)" is only half true; the SHA pins source, not the resolved dependency graph.

### 3. The prod Dockerfile is NOT "copy verbatim, change only the package list" (INFRA §4)
puls's `apps/web/Dockerfile.prod` hardcodes **per-package** COPY lines for `packages/db`, `packages/platform-core`, etc. across four stages (deps, builder, prod-deps, runner) — each with `package.json`, `node_modules`, and `dist`. For drobek-web:
- workspace packages live at **`core/packages/*`** (submodule) **and** `packages/*` (private) — the Dockerfile needs **two** COPY trees, not a renamed one.
- `COPY core ./core` must precede install, the build context must contain the populated submodule (CI checkout must use `submodules: recursive` for the docker build context, not just for git ops), and `.dockerignore` (puls excludes `.git`, fine) must not exclude `core/`.
- pnpm needs **every** workspace member's `package.json` present before `--frozen-lockfile`; that means individually COPYing each `core/packages/*/package.json` in the deps and prod-deps stages.

This is real surgery across 4 stages × 2 package trees, not a one-line edit. Calling it "verbatim, changing only package list" guarantees a painful first build.

### 4. Public CI never tests integration — "both build to GHCR" is false confidence (INFRA §5, SEQUENCE U0/U1/U9)
The public `freema/drobek` workflow typechecks and builds images **from its own `apps/web`**. The private build **recompiles core from source** (submodule) inside drobek-web's Dockerfile. Therefore:
- The image `ghcr.io/freema/drobek-web` (public self-host ref) is **never the artifact that runs in prod.** Prod runs `drobek-saas-web`, built from core-as-source.
- **No job anywhere tests "private app importing core" until the private release runs.** A core change can be green in the public repo and still break the private build (lockfile drift, workspace resolution, peer mismatch). The acceptance "both repos build to GHCR → integration proven" (U9, INFRA §9 step 3) is misleading: only the **private** build exercises the integration, and it's the last thing to run.

### 5. GHCR package/repo name collision + visibility split (INFRA §0)
The public repo `freema/drobek` is told to push `ghcr.io/freema/drobek-web`. The **private repo is literally named `freema/drobek-web`.** GHCR links a package to the repo whose name matches; a package named `drobek-web` pushed from `freema/drobek` collides with the existing repo `freema/drobek-web` for repo-scoped permissions and the package's inherited visibility. Worse, the visibility classes are **opposite**: self-host images (`drobek-web`, `drobek-mcp`) must be **public** so `docker compose up` pulls without auth; SaaS images (`drobek-saas-*`) must be **private**. New GHCR packages don't default to public, so the self-host one-command bring-up (the M1a self-host acceptance) silently fails with an auth error until visibility is set by hand. None of this is called out.

### 6. "Rollback path exists" is overstated — image rollback ≠ schema rollback, and it's worse in two-repo (INFRA §5/§9, E2E §4)
puls's rollback is pure image retag (`previous → latest`), and migrations are forward-only (drizzle has no down-migrations). The roadmap inherits this but adds a twist: the rolled-back image was built from an **older submodule SHA** that may not even contain the migration the newer release applied. So after a `vY` deploy that ran migration `0006`, rolling the image back to `vX` runs old code against a `0006`-migrated schema, and the old image literally doesn't carry `0006`. The whole-skeleton acceptance "rollback path exists (`previous` tag)" and the `rollback.spec.ts` plan (immutability/rollback) conflate **deploy rollback** (works) with **release rollback** (does not, once a migration lands). For a deployment-first foundation this caveat must be explicit.

### 7. Migrate job is moved off puls's path and is now triple-coupled to the submodule (INFRA §6)
puls migrates via `pnpm --filter web db:migrate` with config in `apps/web`. The roadmap moves it to `pnpm --filter @drobek/db db:migrate` with config in core. So the private migrate job must (a) checkout submodules, (b) run a **full `--frozen-lockfile` install of the entire workspace** (so a lockfile drift breaks migrate too, not just build), and (c) point `out:` into the submodule path. Another "mirror puls" that isn't.

### 8. E2E draft never says which repo owns the suite (E2E throughout)
The post-deploy `@smoke` step runs inside the **deploying** repo, which is `drobek-web` (private). So `tests-e2e/` must live in drobek-web. But the public core's self-host story (INFRA §3: "self-hosters get the same one-command bring-up — that *is* the M1a self-host acceptance") then has **no e2e suite**, or a forked duplicate that drifts. The E2E draft says "port puls' suite" (singular) and is silent on the fork. Also the drobek-web `pnpm-workspace.yaml` (INFRA §1) globs `apps/*, packages/*, core/packages/*` but **omits `tests-e2e`**, which puls includes as a workspace member — the e2e package won't install as written.

### 9. "SHA = versioned" papers over the real version story (INFRA §1)
A submodule SHA is not semver, carries no changelog, and gives no compatibility signal between core and web. The promised "migration path to changesets-published `@drobek/*` at M2 without touching app code" is itself unscoped, net-new work (npm auth in two CIs, publish workflow, version bumps) — the very ceremony the draft rejected, just deferred to when the codebase is larger and harder to change.

## The 3 highest-impact fixes

1. **Decide the schema-ownership boundary now, and bake it into the skeleton with at least one private table.** Core owns core tables with an explicitly named migration journal (e.g. `migrations.table = "__drizzle_migrations_core"`); drobek-web owns a **second** schema + migrations folder with its own journal table; deploy runs **two** `db:migrate` passes against the one `drobek` DB. Prove it in U0 by shipping one trivial *private* table (not zero) — otherwise the migrate acceptance de-risks nothing and you hit the wall at the first billing/feedback table.

2. **Replace "`git submodule update --init` is enough" with one scripted bump command, and gate CI on lockfile sync.** `drobek:bump-core` should: move the submodule SHA, run `pnpm install` to regenerate the **private** lockfile, and fail loudly if `--frozen-lockfile` would drift. Add a CI check that the lockfile is in sync with the submodule. This converts the hidden bump tax into a single visible step and kills the infra-vs-feasibility contradiction.

3. **Fix image naming/visibility and make the private build the *only* integration gate.** Never let the public repo own the name `drobek-web` (publish self-host as `drobek-selfhost-web/-mcp` or similar; reserve `drobek-web` for nothing), set each GHCR package's visibility explicitly (self-host public, SaaS private), and **drop the "both repos build → integrated" acceptance.** Replace it with a private-repo integration smoke that actually imports and executes core (the `/private` route) inside the *prod* `drobek-saas-web` image — the only place the integration is real.

**Files cited:** `/Users/tomasgrasl/projects/nodejs/puls-mcp/apps/web/Dockerfile.prod` (per-package COPY across 4 stages), `/Users/tomasgrasl/projects/nodejs/puls-mcp/.github/workflows/deploy.yml` (migrate via `--filter web db:migrate`, `--frozen-lockfile` in quality-gate/migrate, image-tag rollback), `/Users/tomasgrasl/projects/nodejs/puls-mcp/apps/web/drizzle.config.ts` + `apps/web/drizzle/migrations` (migrations live in app, single journal), `/Users/tomasgrasl/projects/nodejs/puls-mcp/pnpm-workspace.yaml` (single lockfile, `tests-e2e` is a member), `/Users/tomasgrasl/projects/nodejs/puls-mcp/docker-compose.deploy.yml` (names/ports to swap). Target repos `/Users/tomasgrasl/projects/nodejs/drobek` and `/Users/tomasgrasl/projects/nodejs/drobek-web` are both still empty (docs/README only), so none of the above is yet validated in practice.

---

## Critique 3

I've verified the load-bearing artifacts (the kept `drobek.app` cert SAN, `RUNNING_APPS.md`, both pulsmcp nginx confs, the puls `deploy.yml`, and `PULS_DEPLOYMENT.md`). Here is the adversarial review.

---

# Adversarial review — drobek deployment-first roadmap (lens: deployment & testing blind spots)

The skeleton is buildable and the puls pipeline is a real, proven template. But the three drafts were written in isolation and **contradict each other on the single most important fact: what the prod-beta URL actually is.** That contradiction cascades into TLS, DNS, the smoke gate, and a shipped-to-prod login backdoor. Specifics below, grounded in the real files.

## 1. The prod-beta target is undefined — the three drafts disagree, and two of the three candidates have no cert/DNS

This is the foundational hole. "Deploy a beta from day 1" requires a beta URL, and the drafts name three different ones:

- **INFRA §0/§5** → deploy to the **apex** `drobek.app` + `mcp.drobek.app`, reuse the kept cert. External check: `curl https://drobek.app/healthz` + `https://mcp.drobek.app/health`.
- **SEQUENCE** → "Prod-beta target = reclaim the freed `drobek.app` slot… `mcp.drobek.app`." Agrees with INFRA (apex).
- **E2E** → hardcodes `BASE_URL_WEB=https://beta.drobek.app`, `BASE_URL_MCP=https://mcp.beta.drobek.app` in the config, the post-deploy smoke step, and the `TEST_ENV=beta` global-setup guard.

I read the kept cert's coverage. `drobek-redirect.conf` says: *"Cert kept (drobek.app cert covers all three SANs)"* — i.e. SAN = `drobek.app, www.drobek.app, mcp.drobek.app`. So:

- `beta.drobek.app` and `mcp.beta.drobek.app` (the E2E draft's targets) are **not in the cert SAN, have no nginx server block, and no DNS A record**. The entire E2E suite as written cannot reach prod.
- `mcp.beta.drobek.app` is a **second-level subdomain** — even a future wildcard `*.drobek.app` cert would not cover it (you'd need `*.beta.drobek.app`). The "one extra `certbot certonly` step" hand-wave is wrong for that host.

Until the drafts agree on one hostname **and** that hostname is in a real cert + DNS record, "verify the deployment works on prod-beta" is not executable. This must be resolved in U0, not discovered at U1.

## 2. Deploying the skeleton to the apex means the throwaway skeleton IS the public launch — and HSTS makes it hard to undo

If you follow INFRA/SEQUENCE (apex), the instant U1 lands, `drobek.app` stops redirecting and publicly serves `<h1>drobek core — it's alive</h1>`, indexable, on the canonical brand domain, while "nothing is ready." There is no staging isolation — apex == beta == prod is the *same single deployment*.

Worse, the decommission shipped **HSTS `max-age=63072000; includeSubDomains; preload`** (confirmed in both pulsmcp confs; the drobek redirect comment says drobek shipped a 2-year preload header too). Consequences the drafts ignore:

- Every 502/TLS hiccup during the constant redeploys of a day-1 skeleton becomes a **hard, un-clickthrough-able browser error** for anyone who ever visited drobek.app.
- `includeSubDomains` + preload means **every** future subdomain — including `<ws>.apps.drobek.app` at M1c — must be HTTPS-with-valid-cert from its very first hit. You can never bootstrap an app subdomain over plain HTTP. This forces the wildcard-DNS-01 work (which the feasibility draft correctly flags as net-new infra) to be a hard prerequisite, not an M1c detail.
- The "alternative: keep apex pristine, launch on beta.*" escape hatch is partly moot if `drobek.app` is on the HSTS **preload list** — the pin is global and already shipped.

## 3. The `/test/seed-session` backdoor ships into the only prod that exists

The E2E draft's prod-safe seeding ships a **login-bypass HTTP endpoint** `POST /test/seed-session` compiled into `apps/web`, gated only by `E2E_ENABLE_SEED=1` + a bearer token, that mints a session for any workspace. Its safety argument is *"on beta this flag is on; in real prod it's off."*

But INFRA/SEQUENCE define **one image deployed to one apex** — there is no separate "real prod." So in the only production that exists, the flag is **on**, and the box now has an auth-bypass endpoint reachable on the public canonical domain. Token leak, env misconfig, or a single `E2E_ENABLE_SEED` left set = anyone mints a session for any workspace. The E2E model assumes `beta ≠ prod`; the INFRA model says `beta == prod`. These cannot both be true, and the unresolved version is the dangerous one.

## 4. e2e-on-prod runs against a SHARED Postgres/Redis with a one-env-var-away TRUNCATE

drobek's DB lives in `shared-postgres` next to puls, metrifyr, physiohub, etc. (per `RUNNING_APPS.md`). The `@beta` tests *create records, enqueue BullMQ deploy jobs in shared-redis, deploy apps*. Blind spots:

- **TRUNCATE guard is one boolean from catastrophe.** The safety is "truncate only when `DATABASE_URL` set AND `TEST_ENV !== 'beta'`." If a developer runs `task e2e` with a prod `DATABASE_URL` still exported in the shell, or CI sets `DATABASE_URL` to the tunnel without `TEST_ENV`, `global-setup` **truncates the live `drobek` DB on the shared box.** The guard depends on an uncommitted convention, not on anything structural.
- **No GC until M2.** Blob GC / backups are U17 (M2). Every failed `@beta` test leaks apps/blobs/records/queue entries into prod for the entire M1a→M1c window. "Unique slug self-clean" doesn't run when a test fails mid-flight.
- **BullMQ namespace collision.** puls already runs BullMQ on shared-redis. A `drobek:` *key* prefix is not the same as a BullMQ *queue prefix*; e2e deploy jobs must be isolated or they can interfere with neighbours' queues.
- **The auto-rollback reverts the image, never the schema** (see #5) — so an e2e run that wedges prod data has no clean revert.

## 5. Migrations run against prod *before* the image swaps, and "rollback" only reverts the image

The puls `deploy.yml` ordering is `migrate` (needs: quality-gate) → `deploy` (needs: [migrate, build-web, build-mcp]). So `drizzle-kit migrate` mutates the **live shared DB while the old containers are still serving**, and only then are images swapped. drizzle-kit migrate is forward-only — there is **no down-migration**. The auto-rollback step (`previous → latest`, `compose up`) reverts the **image but not the schema**, then curls health and reports "Rollback OK." During M1a you will churn auth schema (users/sessions/workspaces/memberships/roles/deploys/blobs) on nearly every release, so a bad migration leaves old code against new schema with a green "rollback" — false confidence baked into the pipeline from day 1.

Also: `/healthz` checks DB *connectivity* (`db: 'up'`), not schema correctness — a missing `db:generate` ships an image whose queries 500 while healthz stays green and the smoke gate passes.

## 6. The day-1 smoke gate asserts endpoints the day-1 skeleton doesn't have

The E2E "first thing that ships" spec (`healthz.spec.ts`, `@smoke`) asserts:
```
expect(b.db).toBe('up'); expect(b.redis).toBe('up');   // healthz
expect(v.sha).toMatch(/^[0-9a-f]{7,40}$/);             // /api/version
```
But INFRA §2's skeleton `coreHealth()` returns `{ ok:true, core:'0.0.0' }` — **no `db`/`redis` fields** — and the skeleton ships **no `/api/version` route**. (puls' own `deploy.yml` even comments out the `/api/version` check because "the route isn't on default branch yet.") So the headline claim — *"the skeleton's DoD is a green @smoke run"* — is **red by construction**: the smoke spec and the skeleton disagree on the health contract. Pick one payload shape and make §2 and §3a match before claiming a green gate.

Related path bug: the MCP health endpoint is **`/health`** (puls deploy.yml + nginx). SEQUENCE U0/U1 curl `mcp.drobek.app/healthz` — wrong path; that check 404s.

## 7. "Copied straight from puls' deploy.yml" hides ~8 hardcoded values that break if literally copied

The puls `deploy.yml` hardcodes, in places the draft glosses as "copy verbatim":
- health-wait loop: `for c in puls-web puls-mcp`
- rollback curls: `http://localhost:3011/healthz`, `http://localhost:3012/health`
- external check: `pulsmcp.com`, `mcp.pulsmcp.com`
- env block image names

Each must become `drobek-web/drobek-mcp`, `3041/3042`, `drobek.app/mcp.drobek.app`, `drobek-saas-*`. "Copy verbatim, change only the package list" (said of the Dockerfile) and "all copied straight from puls" (said of deploy.yml) will silently ship a pipeline that waits on container names that don't exist and rolls back against ports nothing listens on. Minor individually, but on **deploy #1 of an unproven pipeline** they compound.

## 8. Submodule + `--frozen-lockfile` will break the first time core changes

INFRA §1/§4 pins core as a submodule SHA and §4 uses puls' `pnpm install --frozen-lockfile` in the prod Dockerfile. But the private repo's `pnpm-lock.yaml` encodes the resolved `core/packages/*`. Every core change → new submodule SHA → the private lockfile must be regenerated **in the same commit** that bumps the submodule pointer, or `--frozen-lockfile` fails in CI. The sequence documents no "bump submodule + `pnpm install` + commit lockfile" step. `actions/checkout` with `submodules: recursive` fetches the code but does nothing about lockfile drift. This is the "two-repo overhead" the feasibility draft names — and it bites on the first core edit, i.e. immediately.

## 9. Rollback safety is unverifiable on the one deploy where you most need it

The acceptance criterion is *"rollback path exists (`previous` tag)."* But on the **first** prod deploy there is no `:previous` image — `docker tag latest previous || true` no-ops, and the failure-path `if image previous exists` no-ops, so a failed first deploy leaves the broken `:latest` up and reports a confusing "rollback." You can only *prove* rollback on deploy #2+. The brand-new pipeline is least proven exactly when it has no safety net. The acceptance should require a deliberate deploy-#2 rollback drill.

## 10. Smaller but real missing steps

- **Dangling sites-enabled symlink.** §8 does `rm sites-available/drobek-redirect.conf` and symlinks the new confs, but never removes `sites-enabled/drobek-redirect.conf`. If the redirect is currently enabled (it must be, to serve today's 301), the dangling symlink makes `nginx -t` fail on reload. Add `rm /etc/nginx/sites-enabled/drobek-redirect.conf`.
- **ACME location must survive the swap.** Renewal works only because the port-80 block keeps `location /.well-known/acme-challenge/ { root /var/www/certbot; }`. Both new confs (web *and* mcp) must retain it or renewal silently dies ~60 days later. The `certbot renew --dry-run` in §8 will catch it only if run after the swap — make that explicit.
- **Secret/password drift.** §7 generates the DB password inline (`openssl rand -hex 24`) and it must land identically in **both** the GH secret `POSTGRES_PASSWORD` (used by `migrate`) and `/home/apps/drobek/.env.production` (used by the app). Two manual copies that must match; if they diverge, migrate works and the app 500s (or vice versa) with a confusing health state.
- **Dev compose pnpm/node_modules.** §3 bind-mounts `./apps/web`, `./packages`, `./core`, lockfile — but not `node_modules`, and references a dev `apps/web/Dockerfile` that §4 never defines. pnpm workspace symlinks live in `node_modules/.pnpm`; without an anonymous volume the bind mounts clobber the install. The healthcheck `retries:90 start_period:30s` then masks a broken boot for ~7 minutes.
- **Milestone mismatch carried into sequencing.** SEQUENCE itself flags that Linear has only M1/M2/M3 and that PHY-55 (Data API) sits under M2, not M1b — so the "mark the deploy tickets Done" step references a milestone structure that doesn't exist yet. Cosmetic, but the per-part "update Linear" gate will stall on it.

---

## The 3 highest-impact fixes

1. **Pick ONE prod-beta hostname, put it in a real cert + DNS, and reconcile all three drafts to it — before U1.** Recommended: deploy the skeleton to `beta.drobek.app` + `mcp-beta.drobek.app` (single-level, coverable by one HTTP-01 cert), keep the apex on its current redirect, and add `noindex`, so the throwaway skeleton is not the public launch and HSTS pin damage is contained. Then fix the E2E hostnames, the `/health` vs `/healthz` mismatch, and the §2/§3a health-payload contract so the day-1 `@smoke` gate is green *by construction*.

2. **Get e2e off shared prod data and kill the in-prod login backdoor.** Give drobek its **own** Postgres database/role isolation and a dedicated test namespace; make `global-setup` refuse to truncate unless an explicit `ALLOW_DESTRUCTIVE=1` *and* a hostname allowlist match (never on anything resolving to the shared box). Replace the compiled-in `/test/seed-session` backdoor with a build that is **physically excluded** from the prod/apex image (separate build target/flag verified in CI), so the auth bypass cannot exist on the public domain. Namespace BullMQ queues, and don't gate features on prod-beta e2e until blob/record GC (currently M2/U17) exists — otherwise every M1a→M1c run accretes garbage in prod with no cleanup.

3. **Make migrations and rollback honest.** Treat schema changes as forward-only-and-additive during the skeleton phase, write a deploy-#2 rollback drill into U1's acceptance (so rollback is *proven*, not assumed — it cannot work on deploy #1), and document the mandatory "bump submodule pointer + `pnpm install` + commit lockfile" step so `--frozen-lockfile` doesn't break CI on the first core change. Add the missing concrete ops steps: remove the `sites-enabled/drobek-redirect.conf` symlink, keep the ACME location in both new nginx confs, and sync the generated DB password into both the GH secret and `.env.production`.

**Verdict:** The pipeline pattern is sound because puls proves it. What will break first is not the Docker/GHCR/SSH mechanics — it's that "prod-beta from day 1" was specified three incompatible ways, layered on a **shared** database with a **HSTS-pinned apex** and an **auth backdoor** that the test plan assumes lives somewhere the infra plan doesn't provide. Fix the hostname/cert/contract trio, isolate the data, and make rollback provable, and the walking skeleton is genuinely achievable in the feasibility draft's 6–10 week window.

Evidence files: `/Users/tomasgrasl/projects/server/srv1069065-vps/nginx/sites-available/drobek-redirect.conf` (cert SAN = apex+www+mcp only; HSTS preload note), `…/nginx/sites-available/pulsmcp-{web,mcp}.conf` (ACME location, mcp `/health`, HSTS headers), `…/docs/RUNNING_APPS.md` (shared-postgres/redis, 3041/3042 free), `/Users/tomasgrasl/projects/nodejs/puls-mcp/.github/workflows/deploy.yml` (migrate-before-deploy ordering, hardcoded `puls-web`/`3011`/`pulsmcp.com`, image-only rollback, `/api/version` check commented out), `…/docs/PULS_DEPLOYMENT.md` (single-SAN cert pattern, REDIS_URL auth trap, no wildcard infra).
