---
name: port-artifact
description: the user wants a Claude artifact (or a folder of HTML, JS, CSS, images and video) moved to drobek — text files unchanged via write_files, each binary uploaded at the same path, preview, publish on request
---

# port-artifact — move a Claude artifact to drobek

## 1. When to use

The user has a Claude artifact (an HTML page, a React component, or a
folder like `index.html` + `film.mp4` + `poster.jpg` + `s1.jpg` + a script)
and wants it on drobek. YOU port it from the files in your environment: the
drobek server fetches nothing from claude.ai. Paths stay as they are — the
app serves text files and uploaded assets side by side at `/<path>`, so
`<video src="film.mp4">` and `img/s1.jpg` work unchanged. Never rewrite a
path, never inline a binary, never paste base64 into a tool call.

## 2. Minimal working code

A multi-file artifact ported as is (`create_app({ name, template: "html" })`,
then this `index.html`, `style.css` and `chapters.js` in ONE `write_files`):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Summer at Grandma's</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces&display=swap" />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <video id="film" src="film.mp4" poster="poster.jpg" controls preload="metadata"></video>
    <nav id="chapters"></nav>
    <img src="s1.jpg" alt="The garden" />
    <script src="chapters.js"></script>
  </body>
</html>
```

Then each binary, one upload URL per file (exact byte size, same relative path):

```json
{ "app_id": "…", "path": "film.mp4", "size": 26214400, "content_type": "video/mp4" }
```

```sh
curl -fsS -T film.mp4 '<upload_url>'     # 201 {"path":"/film.mp4",…}
stat -c %s s1.jpg || stat -f %z s1.jpg   # the exact size for the next create_asset_upload
```

A React artifact (one component, `export default function App`) goes into the
react-ts template: the component in `src/main.tsx`, rendered by `createRoot`.
`window.storage` becomes `localStorage` (one browser) or `drobek.data` (shared,
`skill_info('data')`):

```tsx
// src/main.tsx
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  // artifact: await window.storage.get('count') / window.storage.set('count', …)
  const [count, setCount] = useState(() => Number(localStorage.getItem('count') ?? 0));
  useEffect(() => localStorage.setItem('count', String(count)), [count]);
  return <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>;
}

createRoot(document.getElementById('root')!).render(<App />);
```

## 3. API and types

The procedure (tool → what to check):

1. Ask the user: "Move <artifact> to drobek as a new app?" — and whether it
   goes to their personal workspace (`list_apps({})` lists the others).
2. `create_app({ name, template?, workspace? })` → `app_id`, `preview_url`,
   the briefing (read its limits). `html` for a page, `react-ts` for a component.
3. Text files (`.html .js .mjs .css .json .svg .txt .md .jsx .tsx`) with
   `write_files({ app_id, files, reasoning })`, content and paths unchanged,
   1–20 per call (split bigger folders into several calls).
4. Every binary (video, audio, image, font) with
   `create_asset_upload({ app_id, path, size, content_type? })` →
   `{ upload_url, expires_at, max_bytes, asset_path, curl }`. Run the `curl -T`
   line in your sandbox. No shell or no network → give the user each
   `upload_url`: in a browser it is an upload page for that one file.
5. Check: `write_files` → `compile.ok: true`; `list_assets({ app_id })` lists
   every binary with its size; give the user the `preview_url` and ask them to
   play the video; `get_logs({ app_id, kind: "runtime" })` for browser errors.
6. `publish({ app_id })` ONLY when the user explicitly asks → `published_url`.
7. Offer the public gallery once: show the description (≤ 160 chars) and ask;
   ONLY after an explicit yes `set_gallery_listing({ app_id, listed: true,
   description, user_confirmed: true })`.

Fix a wrong upload by uploading to the same path again (it replaces) or
`delete_asset({ app_id, path })`.

## 4. Rules and limits

What differs from the artifact sandbox (the app CSP):

- Scripts: only the app itself and `https://esm.sh` (inline scripts run).
  `cdnjs`/`unpkg`/`jsdelivr` `<script src>` is blocked: load the library as a
  module from esm.sh (`import * as THREE from 'https://esm.sh/three@0.160.0'`)
  or copy the library file into the app as a text file.
- React artifact packages (`lucide-react`, `recharts`, `d3`, `lodash`,
  `three`, `papaparse`, …) → pinned esm.sh URLs in `drobek.json` `imports`.
  Tailwind classes → Tailwind's browser build (`skill_info('ui')`).
  `@/components/ui/*` (shadcn) does not exist: plain elements instead.
- `fetch` reaches only the app itself and esm.sh: an external API goes
  through `drobek.proxy` with the owner's secret (`skill_info('proxy')`).
- Fonts (Google Fonts), CSS, images, `<video>`/`<audio>` from any https URL
  work; `<iframe>` only YouTube (`youtube-nocookie.com`), Vimeo, Google Drive
  (plus what the operator allows).
- No `window.claude.*` on drobek: `window.claude.complete` has no
  replacement (drop the feature, or call an LLM API through `drobek.proxy`);
  `window.storage` → `localStorage` or `drobek.data`; sign-in → `drobek.auth`,
  a form that must reach the owner → `drobek.forms`. `skill_info()` lists them.
- Limits (defaults; the briefing and `create_asset_upload` give this
  server's): text files 512 KiB each, 5 MiB and 200 files per version;
  assets `APP_ASSET_MAX_BYTES` 100 MiB each, `APP_ASSETS_QUOTA` 1 GiB per app,
  `APP_ASSET_UPLOADS_PER_HOUR` 60; an upload URL is single use, 30 minutes.
- Asset types come from the bytes: PNG, JPEG, GIF, WebP, SVG, MP4 (H.264/AAC),
  WebM, M4A, MP3, Ogg, WAV, WOFF, WOFF2. No transcoding (MOV/HEVC: convert
  first). A big `data:` URI inside the HTML: save it as a file and upload it.
- An app text file at a path wins over an asset there (`asset_path_taken`).

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `asset_too_large` | the file is over `APP_ASSET_MAX_BYTES` | compress it (lower bitrate) or link it from its https URL |
| `asset_type_not_allowed` | the bytes are not an allowed type for the extension | convert (MP4 H.264/AAC, WebM, JPEG, PNG, WebP); keep the right extension |
| `asset_quota_exceeded` | the app's assets would pass `APP_ASSETS_QUOTA` | `list_assets`, `delete_asset` what the page does not use |
| `asset_path_taken` | a text file of the app holds that path | delete that file with `write_files` or upload under another path |
| `asset_size_mismatch` | the PUT body is not `size` bytes | `stat` the file, ask for a new URL with the exact size |
| `upload_token_invalid` | the URL was used (even by a failed PUT) or is older than 30 minutes | a new `create_asset_upload` |
| `rate_limited` | over `APP_ASSET_UPLOADS_PER_HOUR` upload URLs | upload what you have URLs for; ask for more after the hour |
| `invalid_path` | `write_files` with a media extension (`.mp4`, `.mp3`), `..` or an absolute path | binaries via `create_asset_upload`; app-relative paths |
| `limit_exceeded` | a text file over 512 KiB (inlined base64, a bundled library) | move the binary out; load the library from esm.sh |
| `unresolved_import` | a React artifact package not in `drobek.json` | add its pinned esm.sh URL |
| `secret_in_source` | an API key in the artifact's code | remove it; the owner sets it in the dashboard (`drobek.proxy`) |
| `user_confirmation_required` | gallery listing without the user's yes | ask; send `user_confirmed: true` only after a yes |
