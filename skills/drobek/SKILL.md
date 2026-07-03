---
name: drobek
description: Build and deploy a static micro-app to drobek from your agent. Use when the user wants to ship a small web app / tool / page to drobek, give it a live URL, or add a JSON-schema-backed Data API (todos, guestbook, notes, etc.) over the drobek MCP server.
---

# Build for drobek

drobek is MCP-native hosting for static micro-apps. You (the agent) connect to
the drobek MCP server, deploy a folder of static files, and get a live URL. Apps
that need to store data use drobek's Data API: a JSON-schema-backed collection
per data type, reachable over REST from the browser and over MCP tools from you.

Connect the MCP server first (OAuth 2.1, PKCE). Then follow the flow below. The
AUTHORITATIVE, always-current tool/API schemas live in llms-full.txt and the MCP
docs resource — link to them, do not hand-copy schemas into app code.

## Structure your app

- Put `index.html` at the ROOT of the deploy (not in a subfolder). It is required.
- Use RELATIVE asset paths (`./app.js`, `styles.css`) — the app is served under
  `/:ws/app/:slug/`, so absolute `/asset.js` paths will 404.
- Ship only static files (HTML/CSS/JS/images/fonts). No server, no Node runtime.
  Strict lint at deploy time BLOCKS non-static bundles (e.g. anything pulling in
  chromium/puppeteer) — such a deploy ends `failed` and never activates.
- Routing: a single-page app should route client-side (hash or history) and fall
  back to `index.html`. A multi-page app ships one `.html` per exact path.
- A strict Content-Security-Policy applies. Inline what you can, or reference
  same-origin assets you deploy.

## Define your data schema first

If the app stores data, define the collection BEFORE writing code against it, so
the schema is the contract:

1. Call `whoami` to learn your `workspace` slug.
2. Call `collection_define({ workspace, slug, name, jsonSchema, accessMode })`.
   - `jsonSchema` is a real JSON Schema; every write is validated against it.
   - `accessMode` decides anonymous access (see the next section).
3. Only then write the app code (and any seed `record_create` calls) against
   those exact field names.

Re-calling `collection_define` for the same (app, collection) updates it — it is
idempotent, so you can evolve the schema.

## Use the Data API

Collections are reachable two ways over the SAME data:

- From YOU (the agent), via MCP tools: `record_create`, `record_read`,
  `record_update`, `record_delete`, `record_query`.
- From the deployed browser app, via same-origin REST:
  - `GET/POST  /:ws/app/:slug/data/:collection`
  - `GET/PATCH/DELETE  /:ws/app/:slug/data/:collection/:id`
  `GET` on the collection accepts equality filters by field plus `limit`,
  `cursor`, `sort`, `dir`.

Pick the access mode by who needs to write from the browser:

- `public-write` — anyone can read AND write (schema still validated). Good for a
  public guestbook/todo demo.
- `public-read` — anyone reads; only an editor+ member writes.
- `locked` — no anonymous access at all (members only).
- `owner-only` — reserved for per-end-user auth (a later unit); do not use yet.

Every write is schema-validated, write-rate-limited, and storage-quota-capped
regardless of mode.

## Deploy

1. Build the file list and compute each file's sha256 + byte length.
2. `deploy_init({ name?, slug?, manifest: [{ path, sha256, bytes }] })`. It
   returns a `deployId`, the app coordinates `{ workspace, slug, url }`, and
   presigned PUT URLs for ONLY the files not already stored (content-hash dedup).
3. `PUT` each returned `putUrl` with the exact bytes (the sink verifies the sha).
4. `deploy_commit({ deployId })` to enqueue build → lint → activate.
5. Poll `deploy_status({ deployId })` until `state === "ready"`:
   `awaiting_upload → queued → linting → storing → activating → ready | failed`.
6. On `ready`, open the returned live URL. On `failed`, read the lint report in
   the status and fix the flagged code.

Use `rollback({ slug, toDeployId? })` to repoint an app to a prior ready deploy.

## Check for errors

- Data/deploy tool failures come back with `isError: true` and a JSON body
  `{ error: <code>, message, details? }`. Read the `code` and act on it (e.g.
  `validation_failed` → fix the doc against the schema; `too_many_docs` → the
  app hit its document cap; `index_html_required` → move index.html to the root).
- The full code → meaning → fix table is the Error catalogue in llms-full.txt.
- PLACEHOLDER (agent loop): once app-error capture lands, check `app_errors` for
  the deployed app after the first user hits it, and self-correct. Until then,
  verify by opening the live URL and exercising the app yourself.

## Authoritative schemas

Do NOT duplicate the full tool/REST schemas here — they can change. Read the
authoritative, always-current contract:

- llms.txt (index) and **llms-full.txt** (every tool with its input schema + an
  example, the REST shapes, the deploy flow, limits, and the error catalogue) at
  your drobek web origin, e.g. `http://localhost:3041/llms-full.txt`.
- Or, once connected to MCP, read the `drobek://docs/llms-full` resource and the
  `drobek://docs/tools` resource — no web access needed.
- The guided MCP prompts `deploy-this-project` and `add-data-to-app` walk the
  exact call sequence.

See README.md in this skill for the one-command install and the maintenance rule.
