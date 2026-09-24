# proxy — call an external API without putting its key in the app

## 1. When to use

The app needs an API that takes a secret key (OpenAI, Anthropic, Stripe, a
weather/maps API, the owner's backend), or any API on another origin (the
apps CSP blocks direct `fetch` to other sites). The browser calls drobek,
drobek adds the key server-side and forwards. Never put a key in app files
(write_files refuses it), never import `openai` / `@anthropic-ai/sdk` /
`stripe` in the browser, never ask the user for a key in chat.

## 2. Minimal working code

Setup has two steps. (1) A workspace admin registers the upstream in the
drobek dashboard (workspace → Upstreams): name, base URL (public host, port
80/443), allowed methods + path prefixes, auth (`Bearer` or a named header)
and the key. Not possible over MCP — tell the user exactly what to register.
Check with `get_app` → `modules.proxy.info.upstreams`. (2) Assign it to the
app:

```json
{ "app_id": "…", "module": "proxy", "config": { "upstreams": { "openai": { "rules": { "call": "user" } } } } }
```

This needs a **workspace admin's** confirmation: the answer is `applied:
false`, `confirm_role: "admin"` + `confirm_url` — give the user the link (an
editor can only reject it); until an admin confirms, calls answer 403.

```tsx
// src/main.tsx
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { drobek } from 'drobek';
import { LoginGate } from 'drobek/auth';
import './styles.css';

function Ask() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  async function ask() {
    setBusy(true);
    const res = await drobek.proxy.fetch('openai', '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: question }] }),
    });
    const body = await res.json();
    setAnswer(res.ok ? body.choices[0].message.content : (body.message ?? `Error ${res.status}`));
    setBusy(false);
  }
  return (
    <main>
      <h1>Ask</h1>
      <textarea aria-label="Question" value={question} onChange={(e) => setQuestion(e.target.value)} />
      <button onClick={ask} disabled={!question || busy}>{busy ? 'Thinking…' : 'Ask'}</button>
      <p role="status">{answer}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <LoginGate title="Ask">
    <Ask />
  </LoginGate>
);
```

`call: "user"` = only signed-in users (`skill_info('auth')`), hence `<LoginGate>`.

## 3. API and types

```ts api
// drobek.proxy
export interface Api {
  /** fetch() through drobek: `path` (+ ?query) is appended to the upstream's base URL. Any status resolves — check res.ok. */
  fetch(upstream: string, path?: string, init?: RequestInit): Promise<Response>;
}
```

- Same as `fetch`: `init` is a normal `RequestInit` (method, headers, body
  as a string). It never throws a `DrobekError`; drobek's own refusals are
  JSON `{ error, message, details? }` (table below), anything else is the
  upstream's answer.
- Your `Authorization` and `Cookie` headers are dropped (the server's key
  wins); other headers (e.g. `anthropic-version`) pass through.
- The response body arrives decoded (gzip/br undone). Only safe headers come
  back (`Content-Type`, caching, `Retry-After`, request ids, rate-limit
  hints …); `Set-Cookie`, CORS and an absolute `Location` never do.
- Config `upstreams.<name>`: `rules.call` (default `user`) = `user | admin |
  public | none`, joined with `|` (`owner` is refused); `rateLimit?` = calls
  per minute from the whole app; `id` = the upstream record an admin
  confirmed, set by drobek — never write it. Unassign: `{ "upstreams":
  { "openai": null } }`.
- `get_app` → `modules.proxy.info.upstreams[]`: `{ name, registered,
  assigned, call?, rateLimit?, hasSecret, allowedMethods?,
  allowedPathPrefixes? }` — never the key or the base URL.
- REST: `/__drobek/v1/proxy/<upstream>/<path>` with `X-Drobek-SDK: 1`.

## 4. Rules and limits

- Assigning an upstream and opening `call` to `public` need the owner's
  confirmation. `public` = every visitor spends the owner's API budget;
  prefer `user`.
- Only assigned upstreams, only the admin's methods + path prefixes.
- `PROXY_CALLS_PER_MIN` 60 per app (all upstreams);
  `PROXY_PUBLIC_CALLS_PER_MIN_PER_IP` 10 for `public` upstreams;
  `PROXY_MAX_CONCURRENT_PER_APP` 8 calls of one app in flight at once —
  queue them, don't fire 20 in parallel.
- No redirects followed (a 3xx comes back as-is); 20 s timeout; response
  ≤ 5 MiB; request body ≤ 1 MiB; streaming (SSE) arrives whole.
- Private/internal addresses and ports other than 80/443 are unreachable.
- The key never appears in responses, logs, get_app or skill_info.

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `forbidden` (403) | `details.reason: upstream_not_assigned` (not configured / not confirmed), or the caller's role | `configure_module('proxy')`; an admin confirms |
| `forbidden` (403) | `details.reason: upstream_not_allowed` (no admin confirmed this app, e.g. assigned before it was registered) | remove it from the config, add it again, an admin confirms |
| `forbidden` (403) | `details.reason: upstream_replaced` (deleted and registered again since the confirmation) | remove it from the config, add it again, an admin confirms |
| `unauthorized` (401) | `call: "user"` and nobody signed in | wrap the UI in `<LoginGate>` |
| `not_found` (404) | `details.reason: upstream_not_registered` | ask the workspace admin to register it (same name) |
| `method_not_allowed` (405) | method outside the allow-list | use an allowed method |
| `path_not_allowed` (403) | path outside the allowed prefixes | use an allowed path, or ask the admin |
| `rate_limited` (429) | a per-minute limit | wait `Retry-After`; never loop |
| `proxy_busy` (429) | too many calls in flight (app or server) | wait `Retry-After`; fewer parallel calls |
| `csrf_rejected` (403) | raw `fetch('/__drobek/v1/proxy/…')` | use `drobek.proxy.fetch` |
| `ssrf_blocked` (403) | upstream resolves to a private address | the admin must use a public host |
| `upstream_error` (502) | unreachable, timed out or > 5 MiB (decoded) | show "try again later" |
| `config_error` (500) | the upstream's stored key is unusable | the admin re-enters it in the dashboard |
