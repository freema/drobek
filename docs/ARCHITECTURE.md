# drobek — Architecture (v1 baseline)

> 🌱 **Living doc.** Settled decisions are marked plainly; **(open)** marks things still being specified. The always-current spec is the Linear project; this file is the repo-side snapshot. Last sync: 2026-06-30.

drobek hosts small **client-side (static HTML/JS/CSS) "vibecoded"** micro-projects. Drop a folder → live URL. Headline channel = **MCP-native deploy**: the AI agent that built the app deploys it via an MCP tool. drobek also gives those static apps a **built-in data API** and an **outbound proxy** so they can do real work without their own backend.

Design north star: **light** — a thin **Postgres + Redis** Node app, small functional services, same philosophy/structure as [`puls-mcp`](https://github.com/freema/puls-mcp).

---

## 1. Editions (open-core)

| | `drobek` (public, AGPL-3.0) | `drobek-web` (private, SaaS) |
|---|---|---|
| What | The engine: auth, workspaces, deploy, serving, data API, proxy, logger interface. Self-hostable, runs standalone. | The business edition on top of the core. |
| Adds | — | **Tiers/billing**, **notifications**, **marketing module**, **MCP feedback extras**, managed SMTP, click-to-add SSO, **custom domains**, **Sentry**, branded demo. |

**Code relationship:** core is consumed as a **versioned package / git submodule**; drobek-web is a private app that **imports the core and adds private modules** (billing, marketing, SSO, notifications). Clean open-core — no fork.

**Tiers (for now):** **Free** = personal workspace + a few apps. **Enterprise (contact-only)** = teams, proxy, SSO, custom domains, higher limits. No public pricing yet.

## 2. Services & stack

Thin services, mirroring puls (`apps/web` + `apps/mcp-server` + `packages/*`):

- **web** — Remix / React Router v7 SSR: dashboard, hosted apps (`/<ws>/app/<slug>`), data API, proxy, auth/OAuth endpoints.
- **mcp-server** — **separate service** (confirmed, like puls): the MCP endpoint (deploy / status / data / feedback tools).
- **Postgres** — **source of truth** (apps, deploys, blobs, documents, users, workspaces, upstreams, oauth grants).
- **Redis** — **required** (see §11): BullMQ queue, cache, sessions, rate limiting, live-progress pub/sub.

## 3. Domain model (sketch)

```
users(id, email, google_sub, ...)              roles = fixed enum: super-admin | editor | ...
workspaces(id, kind: personal|team, slug, ...)
memberships(user_id, workspace_id, role)       team join = email invite + link
apps(id, workspace_id, slug, active_deploy_id, routing_mode, visibility=public, status: live|hibernated)
deploys(id, app_id, manifest jsonb, lint_report jsonb, created_at)   -- immutable
blobs(sha256 PK, content_type, bytes)            -- content-addressed, dedup across deploys
app_documents(workspace_id, slug, collection, id, doc jsonb, ...)    -- Data API (Var.1)
collections(app_id, name, access_mode: public-read|public-write|locked)
upstreams(workspace_id, name, base_url, allowed_methods, allowed_path_prefixes, auth_type, allowed_app_ids[])
upstream_secrets(upstream_id, ciphertext, iv, auth_tag, wrapped_dek)  -- envelope-encrypted
oauth_clients / oauth_authorization_codes / oauth_access_tokens       -- ported from puls-mcp
```

## 4. URLs & routing

- Dashboard + API: drobek host. Hosted app: **path-based** `(<host>)/<workspace>/app/<slug>` — no subdomains in the shareable URL.
- App internal routing: **per-app toggle** (SPA fallback to `index.html` vs exact-file/404). Default **(open)**.

## 5. Serving origin & isolation

Untrusted app JS on the drobek origin could hijack the logged-in session. Decision: **configurable serving origin**.
- **Default = hardened same-origin** (0 extra domains): admin/session cookie **path-scoped**, data-API requires an **explicit token** (never the ambient cookie), strict **CSP**. Good enough for internal/company self-host.
- **Opt-in = separate apps-origin** (1 subdomain, no iframe) for public SaaS / untrusted multi-tenant.

Apps are **always public** (anyone with the URL) in v1. Serving: `active_deploy_id` → manifest path → blob by hash; `ETag = sha256`, immutable cache for hashed assets, revalidate for entry HTML; Redis/in-memory cache.

## 6. Auth

**Port the puls-mcp auth module** (same stack): email magic-code + Google OIDC SSO + sessions + a **full OAuth 2.1 Authorization Server for MCP** (authorize / token / DCR / `.well-known` / PKCE). One identity backs web login + MCP OAuth.

Add: **workspaces** (personal + team, **email-invite + link**), **fixed roles** (`super-admin` via `SUPERADMIN_EMAIL`; `editor` deploys own apps + sets its data, cannot configure cross-tenant proxy). Gate `deploy:write` / `data:write` by **role + scope + workspace**.

## 7. Deploy pipeline (MCP-native, async)

1. `deploy_init({workspace, slug, manifest:[{path, sha256, bytes}]})` → diff vs stored blobs → return presigned `putUrl`s for **missing files only** (content-hash dedup). Auto-creates the app if slug is new (slug from name).
2. Client **PUTs raw bytes out-of-band** to presigned URLs (not through MCP context).
3. `deploy_commit({deployId})` → enqueue a **BullMQ** job (Redis).
4. Job: **lint** (htmlhint/eslint/stylelint, **no chromium**) → **hard errors block** → store blobs as content-hash rows → flip `apps.active_deploy_id` in one txn.
5. `deploy_status({deployId})` MCP tool; **live progress via Redis pub/sub → SSE** to the dashboard.

Deploys immutable; **rollback** = repoint the pointer. Entry = `index.html`.

## 8. Data API (Variant 1)

**jsonb document collections**, **auto-created on first write**; the editor sets each collection's **access mode** (`public-read` / `public-write` / `locked`) in the dashboard. Isolation = centralized `WHERE workspace+slug` helper + Postgres RLS backstop. drobek enforces **quotas + write rate limits regardless** of mode. v1 = JSON only (file uploads later).

## 9. Proxy (Variant 2)

BFF outbound proxy so a static app reaches a backend **without holding secrets**. A super-admin registers an upstream (`base_url` pinned) with **envelope-encrypted secrets**; the app calls `/<ws>/api/proxy/<name>/*`, drobek injects auth server-side, scopes to workspace+app, owns CORS, rate-limits. **SSRF guard critical** (allowlist host, resolve DNS once, block private ranges, no redirects). Built **right after** the Data API.

## 10. Quotas & lifecycle

- **Conservative default quotas**, configurable (≈ app 25 MB / 200 files / 5 MB per file / data 10 MB per app + write rate limit).
- **Lifecycle:** inactive apps **hibernate → delete**; thresholds configurable by the self-host operator.

## 11. Redis (required)

drobek runs **Postgres + Redis** (the VPS already has a shared-redis; old drobek + puls use this pattern). Redis is used **fully**:
- **Queue** — BullMQ (deploy jobs)
- **Cache** — served blob/manifest cache, shareable across web instances
- **Sessions** — session store
- **Rate limiting** — login codes, deploy, data-API writes
- **Live deploy progress** — pub/sub → SSE

Postgres stays the source of truth; Redis holds ephemeral / queue / cache / session state.

## 12. Observability

- **Logger interface in the core** — pluggable (console/JSON sink), no vendor lock; self-host gets logs out of the box.
- **Sentry only in drobek-web** (errors/traces for web + mcp-server) — not bundled in the OSS core.

## 13. drobek-web (business) modules

- **Tiers/billing** — Free + Enterprise-on-contact; monetize workspaces.
- **Notifications** — email first (deploy done/failed, invites, quota/expiry warnings, billing); in-app later.
- **Marketing module** — landing + blog/SEO + newsletter/waitlist (à la metrifyr).
- **MCP feedback loop** — rich actionable deploy results back to the agent (lint, URL, errors) + a feedback-submission tool.

## 14. MVP order (milestones)

- **M1 — MVP:** Auth (port puls-mcp) → MCP deploy → serving. First provable vertical.
- **M2 — Data API + Proxy.**
- **M3 — Full dashboard UI + ops** (metrics, teams, quotas, lifecycle, observability, drobek-web modules).

## 15. Open questions

Exact quota numbers · SPA-fallback default · metrics storage · billing provider · marketing details · brand/name · the future "components / auth widgets for hosted apps" idea.
