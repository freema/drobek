# drobek — User flows

> Concrete step-by-step journeys for each actor. Pairs with `ARCHITECTURE.md`. Draft 2026-06-30.

Actors: **editor** (the person who vibecodes + deploys, via a drobek account) · **end-user** (a visitor/user of a *hosted* app) · **super-admin** (self-host operator) · **agent** (Claude Code, acting for an editor over MCP).

---

## A. Editor — first deploy (the "wow")

1. Editor vibecodes a small static app locally in Claude Code (e.g. `dashboard/` with `index.html`).
2. Editor adds the **drobek MCP server** in Claude Code (one URL, e.g. `https://mcp.drobek.app`).
3. First tool call → MCP returns **401** → Claude Code opens the **OAuth** flow in the browser → editor logs into drobek (**email magic-code** or **Google**) → consents to scopes (`deploy:write`, `data:write`) → token stored.
4. Editor: *"deploy this to drobek."* Agent calls **`deploy_init`** with a file manifest (paths + sha256). drobek auto-creates the app (slug from folder name) under the editor's **personal workspace** and returns presigned `putUrl`s for the **missing** files only.
5. Agent **PUTs** the file bytes out-of-band, then calls **`deploy_commit`**.
6. drobek runs the async job (lint → store blobs → activate). Agent polls **`deploy_status`** → `ready`, returns the **live URL** `https://drobek.app/<me>/app/dashboard`.
7. Editor opens it → it's live. Shares the URL. 🎉

## B. Editor — iterate, rollback, collaborate

- **Redeploy:** change files → *"deploy"* again. Content-hash dedup uploads only what changed. New **immutable version**; live pointer flips.
- **Rollback:** dashboard → app → **Deploys** tab → pick a previous version → **Rollback** (pointer repoint). Or via MCP.
- **Preview** *(M2):* deploy to a preview URL, review, **promote** to live.
- **Team:** editor creates a **team workspace**, **invites** a teammate by email → they log in → land in the team with a role (`editor` / `viewer` / `workspace-admin`). Apps live under `/<team>/app/<slug>`.

## C. Editor — give the app data + auth (M1b/M1c)

1. App needs to store data. Agent calls **`collection_define`** (name + JSON Schema) — or the editor defines it in the dashboard **Data** tab.
2. The app reads/writes via **REST** or the **JS SDK** (`drobek.collection('todos').create({...})`), or the agent seeds data via **`record_*`** MCP tools.
3. Editor sets the collection's **access mode** (public-read / public-write / locked / owner-only).
4. App needs its **own users**: editor enables **end-user auth**. The app is now served on the **per-workspace apps-origin** (`<team>.apps.drobek.app/<slug>`) so end-user sessions are isolated + shared across the team's apps (SSO). Editor drops in the **login component**.

## D. End-user — using a hosted app

1. Visitor opens the app's URL. If **public** → just works. If **team-only/password** → gated.
2. If the app uses auth: the **login widget** offers **email code / Google / GitHub**. Visitor logs in → **HttpOnly cookie** on the apps-origin.
3. Visitor uses the app; **owner-only** data means they see/edit only their own records (server derives owner from the session). One account works across all of that workspace's auth apps (**SSO**).

## E. Super-admin — self-host

1. `git clone` drobek (or pull the GHCR images) → copy `.env.example` → set `SUPERADMIN_EMAIL`, SMTP, Google/GitHub OAuth, `DROBEK_MASTER_KEY`, apps-domain.
2. `docker compose up` → `web` + `mcp-server` + `postgres` + `redis` start; migrations run.
3. Super-admin opens the dashboard → logs in with the `SUPERADMIN_EMAIL` address (magic-code) → becomes **super-admin**, sees everything.
4. Connects Claude Code to **their** MCP URL → deploys as in flow A. Configures proxy upstreams, limits, lifecycle as needed.

## F. Workspace-admin — proxy to a company backend (M2)

1. Workspace-admin registers an **upstream** in the dashboard (base URL pinned + secret) → drobek envelope-encrypts the secret.
2. A static app calls `/<ws>/api/proxy/<name>/...`; drobek injects auth server-side and forwards (SSRF-guarded). The app never sees the URL or secret.
3. An `editor` who isn't allowed to expose a backend is **forced through** this controlled proxy — governance.

---

## Sequence: MCP deploy (happy path)

```
agent ──deploy_init(manifest)──▶ web/mcp: diff blobs, create app, presign
agent ◀──{deployId, uploads:[putUrl...]}──
agent ──PUT bytes──▶ object store (out-of-band, per file)
agent ──deploy_commit(deployId)──▶ enqueue BullMQ job
worker: lint → (block on hard error) → store content-hash blobs → flip active_deploy_id
agent ──deploy_status(deployId)──▶ ◀── ready + live URL   (live progress via Redis pub/sub)
```
