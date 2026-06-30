# drobek — Architecture (v1 baseline)

> 🌱 **Living doc, early.** Settled decisions are marked plainly; **(proposed)** / **(open)** mark things still being specified. The canonical, always-current spec is the Linear project; this file is the repo-side snapshot.

drobek hosts small **client-side (static HTML/JS/CSS) "vibecoded"** micro-projects. Drop a folder → live URL. Headline channel = **MCP-native deploy**: the AI agent that built the app deploys it via an MCP tool. drobek also gives those static apps a **built-in data API** and an **outbound proxy** so they can do real work without their own backend.

Design north star: **light**. drobek should run as a thin Node + **Postgres** app (Redis optional). Services are small and functional — same philosophy and structure as [`puls-mcp`](https://github.com/freema/puls-mcp).

---

## 1. Editions (open-core)

| | `drobek` (public, AGPL-3.0) | `drobek-web` (private, SaaS) |
|---|---|---|
| What | The engine: auth, workspaces, deploy, serving, data API, proxy. Self-hostable, runs standalone. | The managed business version on top of the core. |
| Adds | — | **Tiers/billing** (Free + Enterprise-on-contact for now), **notifications**, **marketing module** (à la metrifyr), **MCP feedback loop**, managed SMTP, click-to-add SSO, custom domains, branded demo. |

The split itself is still being drawn — see `docs/research` and the Linear `[Decision] OSS core vs private drobek-web split` ticket.

## 2. Services & stack

Thin services, mirroring puls (`apps/web` + `apps/mcp-server` + `packages/*`):

- **web** — Remix / React Router v7 SSR. Serves the dashboard, the hosted apps (`/<ws>/app/<slug>`), the data API, the proxy, and the auth/OAuth endpoints.
- **mcp-server** — the MCP endpoint (deploy/status/data tools). **(proposed)** a separate service like puls; could also be a route group in web — TBD.
- **Postgres** — the one required datastore (apps, deploys, blobs, documents, users, workspaces, upstreams).
- **pg-boss** — async job queue **on Postgres** (deploy processing). No Redis required for the queue.
- **Redis (optional, proposed)** — see §11.

## 3. Domain model (sketch)

```
users(id, email, google_sub, ...)              roles = fixed enum: super-admin | editor | ...
workspaces(id, kind: personal|team, slug, ...)
memberships(user_id, workspace_id, role)
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

- Dashboard + API: drobek host (e.g. `drobek.app/...`, `app.firma.cz/...`).
- Hosted app: **path-based** `(<host>)/<workspace>/app/<slug>` — **no subdomains in the shareable URL**.
- App internal routing: **per-app toggle** (SPA fallback to `index.html` vs exact-file/404). Default **(open)**.

## 5. Serving origin & isolation

Untrusted app JS on the drobek origin could hijack the logged-in session (confused-deputy). Decision: **configurable serving origin**.
- **Default = hardened same-origin** (0 extra domains): admin/session cookie **path-scoped** (not sent to app paths), data-API requires an **explicit token** (never the ambient cookie), strict **CSP** on app responses. Good enough for internal/company self-host.
- **Opt-in = separate apps-origin** (1 subdomain, no iframe) for public SaaS / untrusted multi-tenant.

Serving: resolve `active_deploy_id` → manifest path → blob by hash. `ETag = sha256`, immutable cache for hashed assets, revalidate for entry HTML. In-memory LRU keyed by hash.

## 6. Auth

**Port the puls-mcp auth module** (same Remix stack): email magic-code (6-digit, hashed, 10-min TTL, rate-limited) + Google OIDC SSO + HttpOnly rolling sessions + a **full OAuth 2.1 Authorization Server for MCP** (authorize / token / DCR register / `.well-known` discovery / PKCE). One identity backs both web login and MCP OAuth.

Add: **workspaces** (personal + team, email-invite + link), **fixed roles** (`super-admin` via `SUPERADMIN_EMAIL` env on self-host; `editor` deploys own apps + sets its data, cannot configure cross-tenant proxy). Gate `deploy:write` / `data:write` by **role + scope + workspace**, server-side.

## 7. Deploy pipeline (MCP-native, async)

1. `deploy_init({workspace, slug, manifest:[{path, sha256, bytes}]})` → diff vs stored blobs → return presigned `putUrl`s for **missing files only** (content-hash dedup). Auto-creates the app if slug is new (slug from name).
2. Client **PUTs raw bytes out-of-band** to presigned URLs (not through MCP context — base64-through-MCP burns tokens).
3. `deploy_commit({deployId})` → enqueue **pg-boss** job.
4. Job: **lint** (htmlhint/eslint/stylelint, **no headless chromium**) → **hard errors block** → store blobs as content-hash rows → flip `apps.active_deploy_id` in one txn.
5. `deploy_status({deployId})` MCP tool polls job state.

Deploys are immutable; **rollback** = repoint the pointer. Entry point = `index.html`.

## 8. Data API (Variant 1)

Built-in store so a static app persists data without its own backend. **jsonb document collections**, **auto-created on first write**; the editor sets each collection's **access mode** (`public-read` / `public-write` / `locked`) in the dashboard. Isolation = centralized `WHERE workspace+slug` helper + Postgres RLS backstop. drobek enforces **quotas + write rate limits regardless** of mode. v1 = JSON only (file uploads later).

## 9. Proxy (Variant 2)

BFF-style outbound proxy so a static app reaches a backend **without holding secrets**, and unprivileged users are forced through drobek's controlled gateway. A super-admin registers an upstream (`base_url` pinned) with **envelope-encrypted secrets**; the app calls `/<ws>/api/proxy/<name>/*`, drobek injects auth server-side, scopes to workspace+app, owns CORS, rate-limits. **SSRF guard is critical** (allowlist host, resolve DNS once, block private ranges, no redirects). Built **right after** the Data API.

## 10. Quotas & lifecycle

- **Conservative default quotas**, configurable (≈ app 25 MB / 200 files / 5 MB per file / data 10 MB per app + write rate limit).
- **Lifecycle:** inactive apps **hibernate → delete**; thresholds configurable by the self-host operator.

## 11. Redis — proposed uses (optional, keep drobek light)

drobek must run on Postgres alone. Redis is an **optional enhancement**, strongest cases:
- **Live deploy progress** — pub/sub from the pg-boss worker → SSE to the dashboard (no Postgres polling).
- **Rate limiting** — login codes, deploy, data-API writes (puls already uses Redis for this; Postgres fallback when absent).
- **Shared cache** across web instances (hot app/manifest/blob lookups) when scaled horizontally.

**(open)** — confirm scope; default self-host should work without Redis.

## 12. Observability — proposed

- **Sentry** for errors (web + mcp-server). **(proposed)**
- A thin **logger interface** in the core (pluggable sink) so self-hosters get console/JSON logs and the SaaS can wire structured logging/Sentry. **(proposed)**

## 13. MVP order

1. **Auth** (port puls-mcp) → 2. **MCP deploy** → 3. **serving** = first provable vertical.
Then **Data API** → **Proxy** → full **dashboard UI** alongside.

## 14. Open questions

Exact quota numbers · SPA-fallback default · metrics storage · MCP server as separate service vs route group · Redis scope · drobek-web tiers/notifications/marketing/feedback details · OSS↔web split line · brand/name.
