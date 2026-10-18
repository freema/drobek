---
name: port-app
description: the user brings a Lovable, Bolt, v0 or other Vite + React project (repo, zip, folder) to drobek — files kept, packages pinned on esm.sh, Tailwind in the page, Supabase calls moved to drobek modules
---

# port-app — move a Lovable, Bolt, v0 or Vite + React app to drobek

## 1. When to use

The user brings a project exported from Lovable, Bolt, v0, StackBlitz or any
Vite + React (+ TypeScript, Tailwind, shadcn/ui) app — a repo, a zip, a folder.
YOU port it from the files you have; the server fetches nothing. Most files go
over unchanged: drobek compiles the TSX, `drobek.json` `paths` resolves `@/`,
packages load from esm.sh. Not this skill: Next.js, Remix, SvelteKit, Nuxt or
Astro with server code (route handlers, server components or actions) — tell
the user at once that the server part does not port; the client components
can be rebuilt as a react-ts app. A Claude artifact → `skill_info('port-artifact')`.

## 2. Minimal working code

`drobek.json`: each dependency the code imports, pinned to the version of
`package.json`; React stays on the export's version and every package that
imports React gets `?deps=` on it (one React on the page):

```json drobek.json
{
  "imports": {
    "react": "https://esm.sh/react@18.3.1",
    "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
    "react-dom": "https://esm.sh/react-dom@18.3.1?deps=react@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client?deps=react@18.3.1",
    "react-router-dom": "https://esm.sh/react-router-dom@6.26.2?deps=react@18.3.1,react-dom@18.3.1",
    "@radix-ui/react-slot": "https://esm.sh/@radix-ui/react-slot@1.1.0?deps=react@18.3.1,react-dom@18.3.1",
    "lucide-react": "https://esm.sh/lucide-react@0.462.0?deps=react@18.3.1"
  },
  "paths": { "@/*": ["src/*"] }
}
```

`index.html` loads `/main.js` + `/main.css`, not `/src/main.tsx`. `tailwind.config` colors and the
`@apply` rules move into the `text/tailwindcss` style; the `:root`/`.dark` variables stay in
`src/index.css` (without `@tailwind`):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Guestbook</title>
    <meta name="description" content="Sign the guestbook and read what others wrote." />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <script type="module" src="https://esm.sh/@tailwindcss/browser@4.1.11"></script>
    <style type="text/tailwindcss">
      @custom-variant dark (&:is(.dark *));
      @theme inline {
        --color-background: hsl(var(--background)); --color-foreground: hsl(var(--foreground));
        --color-primary: hsl(var(--primary)); --color-border: hsl(var(--border));
        --radius-lg: var(--radius); --radius-md: calc(var(--radius) - 2px);
      }
      @layer base { * { @apply border-border; } body { @apply bg-background text-foreground; } }
    </style>
    <link rel="stylesheet" href="/main.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
```

A Supabase table becomes a data collection (declared with `configure_module`,
`skill_info('data')`); a public `import.meta.env.VITE_*` value a constant:

```tsx
// src/lib/messages.ts
import { drobek } from 'drobek';

export const APP_TITLE = 'Guestbook'; // was import.meta.env.VITE_APP_TITLE
type Entry = { name: string; message: string };
const messages = drobek.data.collection<Entry>('messages');
// was supabase.from('messages').select('*').order('created_at', { ascending: false })
export const listMessages = async () => (await messages.list({ sort: '_created_at', dir: 'desc' })).records;
// was supabase.from('messages').insert(entry); row.id / row.created_at → _id / _created_at
export const signGuestbook = (entry: Entry) => messages.create(entry);
```

## 3. API and types

1. Inventory: `package.json` dependencies, the routes (`<Route path>`), each
   `import.meta.env`, each backend call (`supabase.`, `fetch('https://…')`),
   `public/`, the `<head>`. Show the user the plan (the table) and ask: "Move
   <project> to drobek as a new app?" Then `create_app({ name, template: "react-ts" })`.
2. `write_files` in parts (≤ 20 files a call), paths unchanged: first everything but
   `src/main.tsx` and `src/App.tsx` — `drobek.json`, `index.html`, `src/index.css`, `src/lib/*`,
   `src/components/*`, the pages (nothing imports them yet: the template's `src/main.tsx` still
   compiles) — then those two, deleting the template's `src/styles.css`; fix `compile.errors`.
3. `public/x` is served at `/x`: text (`.svg`, `robots.txt`, a manifest) via
   `write_files` at `x`; images and fonts via `create_asset_upload({ app_id,
   path: "x", size })` + `curl -T` — never base64.
4. Backends, each after its `skill_info`:

| in the export | on drobek |
|---|---|
| Supabase Auth (`supabase.auth.*`, a sign-in page) | `auth`: `<LoginGate>`, `drobek.auth.me()` — `skill_info('auth')` |
| Supabase tables, RLS policies | `data`: a collection per table, policies → `rules`, columns → `schema` — `skill_info('data')`; rows: the user's CSV/JSON export → `create_records` (≤ 500 a call), or a `sync` source on the table's REST API through a proxy upstream — `skill_info('sync')` |
| Supabase Storage | `files` — `skill_info('files')` |
| Edge Functions, an API called with a key | a `proxy` upstream (the owner sets the key), or drop it and tell the user — `skill_info('proxy')` |
| Resend / Mailgun / EmailJS in the client | `email` — `skill_info('email')` |
| a form posting to a third party | `forms` — `skill_info('forms')` |
| incoming webhooks (Stripe, GitHub) | `webhooks` — `skill_info('webhooks')` |
| `import.meta.env.VITE_*` | a public value → a constant; a secret → the upstream's key in the dashboard |

5. Check `compile.warnings` (`blocked_by_csp`, `missing_reference`), `get_app`
   (`type_error`), give the user the `preview_url`, after they opened it
   `get_logs({ app_id, kind: "runtime" })`. Checklist: every route renders (a
   deep link too), no request outside the app and esm.sh in the network log,
   a phone width, dark mode when the original had it.
6. `publish({ app_id })` ONLY when the user explicitly asks.

## 4. Rules and limits

- Never port: `vite.config.*`, `tailwind.config.*`, `postcss.config.*`,
  `tsconfig*.json`, `components.json`, `.env*`, lockfiles, `node_modules`,
  `supabase/`, server code, `src/vite-env.d.ts`, third-party scripts of
  `index.html` (analytics, `cdn.gpteng.co`) — the app CSP blocks them.
- Scripts only from the app and `https://esm.sh`; `fetch` only to the app
  (`/__drobek/v1/*`) and esm.sh: a Supabase or Firebase client cannot work.
- `?deps=react@<v>,react-dom@<v>` on every React package: without it esm.sh serves another React
  and rendering fails (React error #31). Not `?external=react` — that leaves a bare
  `import "react"` the browser cannot resolve.
- Tailwind's browser build has no `@plugin` and no config file: `@plugin "tailwindcss-animate"`
  stops ALL styles (leave it out; `animate-*` classes then do nothing). A few v3 names differ
  (`shadow-sm` → `shadow-xs`, `outline-none` → `outline-hidden`). `@tailwind`/`@apply` left in a
  bundled `.css` file do nothing. A small app may use plain CSS (`skill_info('ui')`).
- `import.meta.env` is undefined at run time (a `TypeError`); a key never goes
  into a file. A path without an extension serves `index.html` (client routing).

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `unresolved_import` | a package not in `imports`, or `@/…` without `paths` | add its pinned esm.sh URL, or `"paths": { "@/*": ["src/*"] }` |
| `invalid_config` | `paths` not shaped `{ "@/*": ["src/*"] }` | aliases onto app paths, one `*` at the end |
| `blocked_by_csp` | a third-party script, or `fetch('https://…')` | drop the script; call the API through `drobek.proxy` |
| `missing_reference` | a `public/` file neither written nor uploaded | write it (text) or `create_asset_upload` (binary) at that path |
| `type_error` | a type mismatch in the app's own code (the background check) | fix it; a warning never blocks the version |
| `secret_in_source` | a key from `.env` pasted into the code | remove it; the owner sets it on a proxy upstream |
| `limit_exceeded` | a version over 200 files or 5 MiB | leave out the `components/ui/*` files nothing imports |
