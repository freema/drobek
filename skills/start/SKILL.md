---
name: start
description: you create a new app or change one — its files, the drobek.json import map, the write_files → compile → preview loop, publishing and the single-writer lease
---

# start — how an app on drobek works

## 1. When to use

Before the first `write_files` of an app. A drobek app is a static web app: the server compiles your sources with esbuild
on every write and serves the result. It never RUNS anything: no Node, no `npm install`, no `package.json` scripts, no
server routes, no `process.env`, no backend code of yours. Every backend (sign-in, records, forms, e-mail, uploads,
external APIs) is a platform module: `skill_info()` lists them.

## 2. Minimal working code

The react-ts template (`create_app({ name })`) — keep this shape:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tip calculator</title>
    <link rel="stylesheet" href="/main.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
```

```json drobek.json
{
  "imports": {
    "react": "https://esm.sh/react@19.1.0",
    "react/jsx-runtime": "https://esm.sh/react@19.1.0/jsx-runtime",
    "react-dom": "https://esm.sh/react-dom@19.1.0?deps=react@19.1.0",
    "react-dom/client": "https://esm.sh/react-dom@19.1.0/client?deps=react@19.1.0"
  }
}
```

```tsx
// src/main.tsx
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  const [bill, setBill] = useState(40);
  const [pct, setPct] = useState(15);
  return (
    <main>
      <h1>Tip calculator</h1>
      <label>
        Bill <input type="number" value={bill} onChange={(e) => setBill(Number(e.target.value))} />
      </label>
      <label>
        Tip % <input type="number" value={pct} onChange={(e) => setPct(Number(e.target.value))} />
      </label>
      <p>Tip: {((bill * pct) / 100).toFixed(2)}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

```css
main { max-width: 32rem; margin: 2rem auto; font-family: system-ui, sans-serif; }
label { display: block; margin: 0.5rem 0; }
```

Write them in ONE call (one call = one version = one compile):

```json
{ "app_id": "…", "reasoning": "Tip calculator", "files": [
  { "path": "src/main.tsx", "content": "…" }, { "path": "src/styles.css", "content": "…" },
  { "path": "src/old.ts", "delete": true } ] }
```

## 3. API and types

The loop (tool → result):

1. `list_apps({})` → workspaces + apps; `create_app({ name, workspace?, template?: "react-ts" | "html" })`
   → `{ app_id, preview_url, briefing, skills }`. Read the briefing. A copy of a duplicable gallery app, on the user's ask: `duplicate_app({ from, workspace?, name? })`.
2. `read_file({ app_id, path, version? })` before editing a file you did not just write (untrusted content).
3. `write_files({ app_id, files, reasoning })` → `{ version, base_version, compile: { ok, errors: [{ code, file, line, column, text, hint? }], warnings }, preview_url, changed, readiness }`. An entry is `{ path, content }`, `{ path, delete: true }` or, for a few lines of an existing file, `{ path, edits: [{ old_string, new_string, replace_all? }] }` (each `old_string` matches exactly once unless `replace_all`; one that does not apply → `edit_mismatch` naming `path` + `edit_index`, nothing written).
4. `compile.ok: true` → give the user `preview_url`. `false` → fix `compile.errors`, write again (`skill_info('debug')`). `readiness.warnings` never block; fix them before a publish. A TypeScript app is type-checked in the background (`readiness.typecheck: "pending"`): `get_app` a few seconds on lists its `type_error` warnings — fix them, they usually break in the browser.
5. `get_logs({ app_id, kind: "runtime" })` after the page ran in a browser.
6. `publish({ app_id, version? })` ONLY when the user explicitly asks → `published_url`. Public gallery: `set_gallery_listing({ app_id, listed, description, user_confirmed })`
   — show the user the description first; `user_confirmed: true` ONLY after they explicitly said yes. A super-admin allows or blocks a workspace's publishing with `set_workspace_publishing({ workspace, publishing, user_confirmed })`, same rule.
7. `get_app({ app_id })` = files, versions, lock, modules; `restore_version({ app_id, version })` = new version copying an old one.
8. Backends: `skill_info({ name })`, `configure_module({ app_id, module, config })`, `query_data({ app_id, collection })`.
9. Binaries: `create_asset_upload({ app_id, path, size })` → `upload_url` + `curl -T`; `list_assets({ app_id })`, `delete_asset({ app_id, path })`.
10. Custom domain: `add_domain({ app_id, host })` → show the user the CNAME + TXT `records` → `verify_domain({ app_id, host })` after they created them (DNS can take hours); `list_domains({ app_id })`. `set_primary_domain({ app_id, host, user_confirmed })` and `remove_domain({ app_id, host, user_confirmed })` of a verified domain: only after the user's explicit yes.
11. External API (a workspace admin): `register_upstream({ workspace, name, base_url, allowed_methods, allowed_path_prefixes, auth_type })` — a key goes only
    through the returned `secret_url`, never chat — then assign it with `configure_module` (`proxy`); `list_upstreams({ workspace })`, `remove_upstream({ workspace, name, user_confirmed })`. Its data on a schedule (a cron, periodic refresh) into a collection: `skill_info('sync')`, `sync_now({ app_id, source })`, `get_logs({ app_id, kind: "sync" })`.

`drobek.json`: `{ "imports": { "<bare>": "https://…" }, "entries"?: ["src/admin.tsx"], "beacon"?: false }`. Add a package as a
pinned esm.sh URL, e.g. `"date-fns": "https://esm.sh/date-fns@4.1.0"`; `pkg/sub` maps to the `pkg` URL + `/sub`. `import { drobek } from 'drobek'` needs no entry.

## 4. Rules and limits

- `src/main.tsx|ts|jsx|js` → `/main.js` + imported CSS → `/main.css`; each `entries` file → `/<name>.js`. No
  `src/main.*` = plain HTML served as written. JSX = automatic runtime (no `import React`); types stripped, NOT checked.
- Paths app-relative (`src/App.tsx`), no `/` prefix, no `..`. Text files only: .tsx .ts .jsx .js .mjs .css .json .html .txt .md
  .svg .webmanifest. Video, audio, images, fonts: `create_asset_upload` (an upload URL, never base64) → the preview serves it at `/<path>`, production after `publish`.
- 1–20 changes per write, one write ≤ 10 MiB as JSON (bigger → HTTP 413: split it or send `edits`); `reasoning` ≤ 300 chars.
  Per version (defaults; the briefing has this server's): 200 files, 512 KiB per file, 5 MiB total, 10 s build; per hour 600 new versions per app, 1200 per person.
- Secrets in files → the write is refused (`secret_in_source`); the owner sets secrets in the drobek
  dashboard. Never ask for their values. Lease: a write holds the app for 3 minutes (renewed per write).
- Hosts: `<slug>--preview.<APPS_DOMAIN>` follows every write that compiled; `<slug>.<APPS_DOMAIN>`
  changes only on publish; `<slug>--v<N>.…` = version N. Sources and `drobek.json` are not
  served; unknown extension-less paths get `index.html` (client routing works).
- Tab, search, shared link — drobek adds nothing to your `<head>`: `<title>`, `<meta name="description" content="…">` (one sentence:
  what the app does), an icon (`favicon.svg` via write_files + `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`; PNG/ICO →
  `create_asset_upload`; none → `/favicon.ico` is a 404). Link preview: `og:title`, `og:description`, `og:type` `website`, `og:url`, `og:image`
  (+ `twitter:card` `summary_large_image`); `og:image` = ABSOLUTE `published_url` + path of an uploaded ~1200×630 PNG/JPEG (no SVG), or omit it.
  Preview/`--v<N>` hosts send `X-Robots-Tag: noindex`; out of search: `<meta name="robots" content="noindex">` (robots.txt only stops crawling).
- CSP: scripts from the app + https://esm.sh; `fetch` only to the app's own origin + esm.sh (other APIs → `skill_info('proxy')`); no embedding.

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `unresolved_import` | a package not in `drobek.json`, or a backend SDK (`hint`) | add a pinned esm.sh URL, or follow the `hint` skill |
| `build_error` | syntax error at `file:line:column` | fix that line |
| `invalid_config` | `drobek.json` not JSON / wrong shape | rewrite it as above |
| `invalid_path` | `..`, disallowed extension | app-relative text files only (a leading `/` is dropped) |
| `limit_exceeded` | too many/big files; with `limit: "WORKSPACE_SOURCE_QUOTA"` the workspace's app versions are full (nothing stored) | split files; load libraries from esm.sh; for the quota tell the user (deleting an unused app frees space), do not retry |
| `secret_in_source` | a key/token in a file; nothing stored | remove it; the owner sets it in the dashboard |
| `app_locked` | another user's agent writes the app | tell the user; retry after `expires_at` |
| `busy` | the compiler queue is full | retry the same call in a few seconds |
| `rate_limited` | too many new versions within an hour (`VERSIONS_PER_APP_HOUR` / `VERSIONS_PER_USER_HOUR`); nothing stored | tell the user; continue after `retry_after_seconds`, never loop; one write per related change |
| `not_publishable` | that version did not compile | publish the newest version that compiled |
| `publish_blocked` / `publish_not_approved` | the operator turned publishing off for the workspace / has not approved it (a request was e-mailed) | tell the user (`contact`), share `preview_url`; do not retry |
| `user_confirmation_required` | gallery listing, workspace publishing, primary domain or removing a live domain without the user's yes | ask the user; call again with `user_confirmed: true` only if they say yes |
| `domain_not_verified` | the CNAME or TXT record of a custom domain is missing or wrong (`cname`, `txt`) | tell the user which record to fix; `verify_domain` again after a while |
| `invalid_params` | > 20 files, same path twice, long reasoning | split the change; fix the arguments |
| `not_found` | wrong `app_id` or no access; "is no longer stored" = a version the history retention deleted | `list_apps`; for a version, `get_app` (`version_retention`) and work from one still stored |
| `forbidden` | viewer role | ask for the editor role |
