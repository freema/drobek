# drobek — Architecture (v1 baseline)

> 🌱 **Living doc.** Settled decisions marked plainly; **(open)** = still to specify. Canonical spec = the Linear project; this is the repo snapshot. Last sync: 2026-06-30.

drobek hosts small **client-side (static HTML/JS/CSS) "vibecoded"** micro-projects. Drop a folder → live URL. Headline = **MCP-native deploy** (the AI agent that built it deploys it). drobek also gives those static apps a **data API**, a **JS SDK** (data + their own end-user auth), and an **outbound proxy** — so they do real work without their own backend.

**Shape:** a **single-box Node app** — Postgres (source of truth) + Redis (queue/cache/sessions) + two small services (`web`, `mcp-server`), same family as [`puls-mcp`](https://github.com/freema/puls-mcp). Batteries-included, but one box.

---

## 1. Editions (open-core)
- **`drobek`** (public, AGPL-3.0) — the engine: auth, workspaces, deploy, serving, data API, JS SDK, proxy, logger interface. Self-hostable.
- **`drobek-web`** (private) — business edition: **imports the core `packages/*` and adds private modules** (no fork): billing/tiers, notifications, marketing, MCP feedback inbox, managed SMTP, click-to-add SSO, custom domains, Sentry.
- **Tiers:** **Free** (personal workspace + a few apps) · **Enterprise** (contact-only): teams, proxy, SSO, custom domains, higher limits. No public pricing yet.

## 2. Services, stack & repo
- **web** — Remix / RR7 SSR: dashboard, hosted apps, data API, end-user auth, proxy, drobek auth/OAuth endpoints.
- **mcp-server** — separate service (like puls): MCP tools; validates OAuth tokens issued by `web`'s AS.
- **Postgres** (source of truth) + **Redis** (required, §14). Config via `.env` (12-factor).
- **Monorepo (pnpm, mirrors puls):** `apps/web` + `apps/mcp-server` + `packages/{db, core, sdk}`. **ORM = Drizzle** (`drizzle-kit` + postgres.js) in `packages/db` (`db:generate/migrate/studio`; migrate step on deploy).
- **CI/CD:** GitHub Actions on release → images → **GHCR** → `docker pull` on VPS (`deploy.yml`), like puls/metrifyr.

## 3. Domain model (sketch)
```
users(id, email, google_sub, ...)                roles: super-admin | workspace-admin | editor | viewer
workspaces(id, kind: personal|team, slug)        memberships(user_id, workspace_id, role)
apps(id, workspace_id, slug, active_deploy_id, routing_mode, visibility=public, status: live|hibernated)
deploys(id, app_id, manifest jsonb, lint_report jsonb, created_at)     -- immutable
blobs(sha256 PK, content_type, bytes)            -- content-addressed, dedup
collections(app_id, name, json_schema jsonb, access_mode: public-read|public-write|locked|owner-only)
app_documents(app_id, collection, id, owner_end_user_id?, doc jsonb, ...)
workspace_end_users(workspace_id, id, email, provider, ...)  -- hosted apps' OWN users, workspace-scoped (SSO)
workspace_end_user_sessions(...)                 -- HttpOnly cookie on the per-workspace apps-origin
upstreams(...) / upstream_secrets(... envelope-encrypted, KEK from DROBEK_MASTER_KEY)
oauth_clients / oauth_authorization_codes / oauth_access_tokens         -- ported from puls-mcp
app_metrics(app_id, day, visits, ...)            -- lightweight PG counters, no PII
```

## 4. URLs & routing
Static (no-auth) app: **path-based** `(<host>)/<workspace>/app/<slug>`. **Auth app** (uses end-user auth): **per-workspace apps-origin** `<workspace>.apps.<host>/<slug>` (wildcard cert). Per-app **SPA-fallback toggle** (default **open**).

## 5. Serving origin & isolation
**Configurable.** Default = **hardened same-origin** (admin cookie path-scoped, data-API token-gated, strict CSP) for internal self-host. Opt-in = separate apps-origin for public SaaS. **Auth apps always get a per-workspace apps-origin** (SSO + token isolation). Apps **always public** (v1). Content-hash serving + caching (ETag, immutable).

## 6. Auth — drobek accounts
**Port the puls-mcp module:** email magic-code + Google OIDC + sessions + **OAuth 2.1 AS for MCP** (authorize/token/DCR/`.well-known`/PKCE). Workspaces **personal + team** (email-invite). **Fixed roles:** `super-admin` (via `SUPERADMIN_EMAIL`), `workspace-admin`, `editor`, `viewer`. Gate by **role + scope + workspace**.

## 7. Hosted-app end-user auth ("auth widgets")
- **Workspace-scoped end-users** (`workspace_end_users`) → **SSO across the workspace's apps**. Separate from drobek accounts.
- Methods: **email magic-code + Google + GitHub OAuth** (per-instance config). Signup **open + rate-limited**.
- Session = **HttpOnly cookie on the per-workspace apps-origin**; mutations protected by **SameSite + Origin check + CSRF token**.
- **Owner-only data:** server derives `owner = current end-user` from the session (client never sends it).
- Ships in **M1c** via the SDK.

## 8. Deploy pipeline (MCP-native, async)
**3 tools:** `deploy_init` (presigned `putUrl`s for missing files, content-hash dedup; auto-creates app from slug) → agent **PUTs local files out-of-band** → `deploy_commit` (BullMQ job) + `deploy_status` (live progress via Redis pub/sub → SSE). Job: **strict lint** (no chromium; hard errors **block**) → content-hash blobs → flip `active_deploy_id`. Immutable; **rollback** = repoint. Entry `index.html`. **No server-side build** — agent builds locally, deploys the static output.

## 9. Serving model
`active_deploy_id` → manifest path → blob by hash. ETag=sha256, immutable cache for hashed assets, revalidate entry HTML; Redis/in-memory cache. Fixed `path→content_type`, `nosniff`.

## 10. Data API (Variant 1)
**jsonb document collections.** **Required JSON Schema per collection** (via MCP `collection_define` **and** dashboard; writes validated — not yolo). **REST** + **JS SDK**. Query: list + filter + sort + limit. Access modes: public-read / public-write / locked / **owner-only**. Quotas + write rate-limits enforced regardless. v1 JSON only. MCP CRUD tools (`record_*`) land in **M1b**.

## 11. JS SDK
JS over the REST API: **data CRUD + query** and **end-user auth**. Delivered as a **versioned `<script>` from the drobek host** (`<host>/sdk@1.js`, no build); `@drobek/sdk` npm maybe later. In `packages/sdk`.

## 12. Proxy (Variant 2)
BFF outbound proxy: a `workspace-admin`/`super-admin` (configurable per workspace) registers an upstream (`base_url` pinned, **envelope-encrypted secrets**, KEK from `DROBEK_MASTER_KEY`); app calls `/<ws>/api/proxy/<name>/*`, drobek injects auth, scopes to workspace+app, owns CORS, rate-limits. **SSRF-guarded** (allowlist host, resolve DNS once, block private ranges, no redirects). Built **right after** Data API (M2).

## 13. Quotas & lifecycle
Conservative configurable quotas (≈ app 25 MB / 200 files / 5 MB per file / data 10 MB per app + write rate-limit). Lifecycle: inactive apps **hibernate → delete**, thresholds configurable.

## 14. Redis (required)
BullMQ **queue** · **cache** · **sessions** · **rate limiting** · **live-progress** pub/sub. Postgres stays source of truth.

## 15. Observability
**Logger interface in core** (pluggable, no vendor lock). **Sentry in drobek-web** (web + mcp-server). **Metrics** = lightweight Postgres counters per app/day (no PII/IP).

## 16. drobek-web modules
Tiers/billing (Free + Enterprise-contact; provider TBD) · Notifications email-first (managed **Resend/Postmark**; self-host = own SMTP) · Marketing (landing + blog/SEO + newsletter, routes in the drobek-web Remix app, à la metrifyr) · MCP feedback loop (rich deploy results + feedback tool → **admin inbox** + optional Linear issue).

## 17. Self-host
**docker-compose** (`web` + `mcp-server` + `postgres` + `redis`) + **`.env`** (`SUPERADMIN_EMAIL`, SMTP, Google/GitHub OAuth, `DROBEK_MASTER_KEY`, session secret, limits, lifecycle, serving-origin + apps-domain). `docker compose up` → running. `.env.example` + docs. Env-first, no wizard.

## 18. Milestones
- **M1 — MVP**, cut into:
  - **M1a** = auth (email-code + Google + MCP OAuth) + workspaces + 4 roles + deploy + serving + dashboard apps-list + self-host compose. *Acceptance: deploy from Claude Code → live URL + rollback + visible in dashboard + `docker compose up` works.*
  - **M1b** = Data API (jsonb + required schema) + MCP CRUD tools.
  - **M1c** = JS SDK + hosted-app end-user auth.
- **M2 — Data API (full runtime) + Proxy.**
- **M3 — Full dashboard UI + ops** (metrics, teams, quotas, lifecycle, observability, drobek-web modules).

## 19. Open questions (remaining)
Blob GC + binaries-on-disk threshold · backups (PG + blobs) · GDPR/PII export-delete (Enterprise) · brand/name. *Most former gaps now decided — see Linear PHY-74…80.*
