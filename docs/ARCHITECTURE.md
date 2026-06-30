# drobek — Architecture (v1 baseline)

> 🌱 **Living doc.** Settled decisions marked plainly; **(open)** = still to specify. Canonical spec = the Linear project; this is the repo snapshot. Last sync: 2026-06-30.

drobek hosts small **client-side (static HTML/JS/CSS) "vibecoded"** micro-projects. Drop a folder → live URL. Headline = **MCP-native deploy** (the AI agent that built it deploys it). drobek also gives those static apps a **data API**, a **JS SDK** (data + their own end-user auth), and an **outbound proxy** — so they do real work without their own backend.

**Shape:** a **single-box Node app** — Postgres (source of truth) + Redis (queue/cache/sessions) + two small services (`web`, `mcp-server`), same family as [`puls-mcp`](https://github.com/freema/puls-mcp). Not "microservice light" anymore — batteries-included, but one box.

---

## 1. Editions (open-core)

- **`drobek`** (public, AGPL-3.0) — the engine: auth, workspaces, deploy, serving, data API, JS SDK, proxy, logger interface. Self-hostable, standalone.
- **`drobek-web`** (private) — business edition. **Imports the core as a package/submodule and adds private modules** (no fork): billing/tiers, notifications, marketing, MCP feedback inbox, managed SMTP, click-to-add SSO, custom domains, Sentry, demo.
- **Tiers:** **Free** (personal workspace + a few apps) · **Enterprise** (contact-only): teams, proxy, SSO, custom domains, higher limits. No public pricing yet.

## 2. Services & stack

- **web** — Remix / RR7 SSR: dashboard, hosted apps, data API, end-user auth, proxy, drobek auth/OAuth endpoints.
- **mcp-server** — separate service (like puls): MCP tools; validates OAuth tokens issued by `web`'s AS.
- **Postgres** — source of truth. **Redis** — required (§14). Config via `.env` (12-factor).

## 3. Domain model (sketch)

```
users(id, email, google_sub, ...)                roles: super-admin | workspace-admin | editor | viewer
workspaces(id, kind: personal|team, slug)        memberships(user_id, workspace_id, role)
apps(id, workspace_id, slug, active_deploy_id, routing_mode, visibility=public, status: live|hibernated)
deploys(id, app_id, manifest jsonb, lint_report jsonb, created_at)     -- immutable
blobs(sha256 PK, content_type, bytes)            -- content-addressed, dedup
collections(app_id, name, json_schema jsonb, access_mode: public-read|public-write|locked|owner-only)
app_documents(app_id, collection, id, owner_end_user_id?, doc jsonb, ...)
app_end_users(app_id, id, email, provider, ...) -- hosted app's OWN users (separate from `users`)
app_end_user_sessions(...)                       -- (open) tokens/sessions for end-users
upstreams(workspace_id, name, base_url, allowed_methods, allowed_path_prefixes, auth_type, allowed_app_ids[])
upstream_secrets(upstream_id, ciphertext, iv, auth_tag, wrapped_dek)
oauth_clients / oauth_authorization_codes / oauth_access_tokens         -- ported from puls-mcp
```

## 4. URLs & routing
Hosted app: **path-based** `(<host>)/<workspace>/app/<slug>` — no subdomains in the shareable URL. App internal routing: per-app **SPA-fallback toggle**. Default **(open)**.

## 5. Serving origin & isolation
**Configurable.** Default = **hardened same-origin** (admin/session cookie path-scoped, data-API token-gated, strict CSP). Opt-in = **separate apps-origin** for public SaaS. Apps **always public** (v1). Content-hash serving + caching (ETag, immutable).

## 6. Auth — drobek accounts
**Port the puls-mcp module:** email magic-code + Google OIDC + sessions + **OAuth 2.1 AS for MCP** (authorize/token/DCR/`.well-known`/PKCE). Workspaces **personal + team** (email-invite). **Fixed roles:** `super-admin` (via `SUPERADMIN_EMAIL`), `workspace-admin`, `editor`, `viewer`. Gate by **role + scope + workspace**.

## 7. Hosted-app end-user auth (the "auth widgets")
A hosted app can authenticate **its OWN end-users** via the SDK — separate from drobek accounts.
- Methods: **email magic-code + Google + GitHub OAuth** (providers configured per instance).
- **Owner-based data:** records can belong to an end-user; collections support an **owner-only** mode (a user sees/edits only their own records).
- End-users live per app (`app_end_users`); their sessions/tokens are **(open, security-critical)**.
- Ships in **M1** via the SDK.

## 8. Deploy pipeline (MCP-native, async)
**3 tools:** `deploy_init` (presigned `putUrl`s for missing files, content-hash dedup; auto-creates app from slug) → agent **PUTs local files out-of-band** → `deploy_commit` (BullMQ job) + `deploy_status` (live progress via Redis pub/sub → SSE). Job: **strict lint** (htmlhint/eslint/stylelint, no chromium; hard errors **block**) → store content-hash blobs → flip `active_deploy_id`. Immutable versions; **rollback** = repoint. Entry `index.html`. **No server-side build** — the agent builds locally and deploys the static output.

## 9. Serving model
`/<ws>/app/<slug>/*` → `active_deploy_id` → manifest path → blob by hash. ETag=sha256, immutable cache for hashed assets, revalidate for entry HTML; Redis/in-memory cache. Fixed `path→content_type`, `nosniff`.

## 10. Data API (Variant 1)
**jsonb document collections.** **Required JSON Schema per collection** (defined via MCP `collection_define` **and** dashboard settings; writes validated — deliberately not yolo). **REST** (`/<ws>/app/<slug>/data/<collection>[/<id>]`) **+ JS SDK**. Query: list + filter + sort + limit. Access modes: public-read / public-write / locked / **owner-only**. drobek enforces **quotas + write rate-limits** regardless. v1 JSON only. MCP CRUD tools (`record_*`) land in **M1**.

## 11. JS SDK
JS over the REST API: **data CRUD + query** and **end-user auth** (login/identity for the hosted app). Owner-based data binding. Delivery/versioning **(open)**.

## 12. Proxy (Variant 2)
BFF outbound proxy: super-admin / workspace-admin registers an upstream (`base_url` pinned, **envelope-encrypted secrets**); app calls `/<ws>/api/proxy/<name>/*`, drobek injects auth server-side, scopes to workspace+app, owns CORS, rate-limits. **SSRF-guarded** (allowlist host, resolve DNS once, block private ranges, no redirects). Who-can-configure = per-workspace. Built **right after** Data API.

## 13. Quotas & lifecycle
Conservative configurable quotas (≈ app 25 MB / 200 files / 5 MB per file / data 10 MB per app + write rate-limit). Lifecycle: inactive apps **hibernate → delete**, thresholds configurable.

## 14. Redis (required)
BullMQ **queue** (deploy jobs) · **cache** (blobs/manifests) · **sessions** · **rate limiting** · **live-progress** pub/sub. Postgres stays source of truth.

## 15. Observability
**Logger interface in core** (pluggable console/JSON, no vendor lock). **Sentry in drobek-web** (web + mcp-server) — not bundled in core.

## 16. drobek-web modules
**Tiers/billing** (Free + Enterprise-contact; billing provider TBD) · **Notifications** email-first (managed **Resend/Postmark**; self-host = own SMTP via `.env`) · **Marketing** (landing + blog/SEO + newsletter, built as routes in the drobek-web Remix app, à la metrifyr) · **MCP feedback loop** (rich deploy results to agent + feedback tool → **admin inbox** + optional Linear issue).

## 17. Self-host
**docker-compose** (`web` + `mcp-server` + `postgres` + `redis`) + **`.env`** (`SUPERADMIN_EMAIL`, SMTP, Google/GitHub OAuth, limits, lifecycle, serving-origin mode). `docker compose up` → running. `.env.example` + docs.

## 18. Milestones
- **M1 — MVP** (large, grew): auth + workspaces/roles, deploy, serving, data API (schema + CRUD via MCP/REST/SDK), JS SDK incl. **end-user auth**. *Consider an internal **M1a** = auth + deploy + serving (single user) first to de-risk.*
- **M2 — Data API (full runtime) + Proxy.**
- **M3 — Full dashboard UI + ops** (metrics, teams, quotas, lifecycle, observability, drobek-web modules).

## 19. Open questions / gaps
End-user session/token design (security-critical) · same-origin × end-user cookies isolation · secrets/KEK management · DB migration tooling · CI/CD + release + how drobek-web consumes core · SDK delivery/versioning · abuse/spam controls for public-write + end-user signup · blob GC + binaries-on-disk · metrics storage · backups · GDPR/PII (Enterprise) · build expectation · brand/name. *(See gap analysis / Linear.)*
