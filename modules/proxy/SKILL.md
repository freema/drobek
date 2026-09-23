# proxy — call an external API without putting its key in the app

Use it when the app needs an API that takes a secret key: OpenAI,
Anthropic, Stripe, a weather or maps API, the owner's own backend. The
browser calls drobek; drobek adds the key on the server and forwards the
request. **Never put an API key in the app's files** (write_files refuses
it), never import `openai` / `@anthropic-ai/sdk` / `stripe` in the browser,
and never ask the user for a key in chat.

## How it is set up (two steps, two people)

1. **The workspace admin registers the upstream** in the drobek dashboard
   (workspace → Upstreams): a name (e.g. `openai`), the base URL
   (`https://api.openai.com`, ports 80/443 only), the allowed methods and
   path prefixes, how the key is sent (`Authorization: Bearer …` or a
   named header) and the key itself. You cannot do this over MCP — tell the
   user exactly what to register.
2. **You assign it to the app** with `configure_module`:

```json
{ "app_id": "…", "module": "proxy", "config": { "upstreams": { "openai": { "rules": { "call": "user" } } } } }
```

Assigning an upstream **needs a workspace admin's confirmation**: the answer
is `applied: false`, `confirm_role: "admin"` and a `confirm_url` — give the
user that link (an editor can only reject it). Until an admin confirms,
calls answer 403. `get_app` → `modules.proxy.info.upstreams` shows
every upstream of the workspace: `registered`, `assigned`, `call`,
`hasSecret` (whether the key is set — never its value), `allowedMethods`,
`allowedPathPrefixes`.

## Minimal working code (react-ts template, with the auth module)

`call: "user"` means only signed-in users may call it, so the UI lives in
`<LoginGate>` (`skill_info('auth')`).

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
  async function ask() {
    setAnswer('Thinking…');
    const res = await drobek.proxy.fetch('openai', '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: question }] }),
    });
    const body = await res.json();
    setAnswer(res.ok ? body.choices[0].message.content : body.message ?? `Error ${res.status}`);
  }
  return (
    <main>
      <h1>Ask</h1>
      <textarea value={question} onChange={(e) => setQuestion(e.target.value)} />
      <button onClick={ask} disabled={!question}>Ask</button>
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

## SDK

```ts
drobek.proxy.fetch(upstream: string, path?: string, init?: RequestInit): Promise<Response>
```

- Same as `fetch`: `path` (with its `?query`) is appended to the
  upstream's base URL; `init` is a normal `RequestInit` (method, headers,
  body as a string). It resolves with the standard `Response` for **any**
  status — check `res.ok`. It does not throw a DrobekError.
- drobek's own refusals are JSON `{ error, message }` (table below); any
  other status/body is the upstream's.
- Your `Authorization` and `Cookie` headers are dropped; the server's key
  wins. Other headers (e.g. `anthropic-version`) pass through.
- Streaming (SSE) responses are not supported: the response arrives whole.

## Config

- `upstreams.<name>.rules.call` (default `"user"`): who may call —
  `user` (any signed-in user of the app), `admin` (the app's admins),
  `public` (anyone, even signed out), `none`; combine with `|`.
  **`public` needs the owner's confirmation** and every client IP is
  limited to `PROXY_PUBLIC_CALLS_PER_MIN_PER_IP` calls per minute — every
  visitor spends the owner's API budget, so prefer `user`.
- `upstreams.<name>.rateLimit` (optional): calls per minute to this
  upstream from the whole app.
- Remove an assignment: `{ "upstreams": { "openai": null } }` (applies at
  once).

## What the server enforces

- Only upstreams assigned to this app, and only the methods + path prefixes
  the admin allowed.
- `PROXY_CALLS_PER_MIN` (60): calls per app per minute, all upstreams.
- No redirects are followed (a 3xx is returned as-is); 20 s timeout; the
  response is at most 5 MiB; request bodies at most 1 MiB.
- Private/internal addresses and ports other than 80/443 are unreachable.
- The key is added on the server and never appears in responses, logs,
  get_app or skill_info.

## Common errors

| error | cause | fix |
|---|---|---|
| `forbidden` (403) `upstream_not_assigned` | not in the app's config, or not confirmed yet | `configure_module('proxy', …)`; the owner confirms |
| `unauthorized` (401) | `call: "user"` and nobody is signed in | wrap the UI in `<LoginGate>` |
| `forbidden` (403) | the caller's role does not match `call` | show a friendly message |
| `not_found` (404) `upstream_not_registered` | no such upstream in the workspace | ask the workspace admin to register it (name must match) |
| `forbidden` (403) `upstream_not_allowed` | no admin confirmed this app for it (e.g. assigned before it was registered) | remove it from the config, add it again, an admin confirms |
| `method_not_allowed` (405) / `path_not_allowed` (403) | outside the upstream's allow-lists | use an allowed method/path, or ask the admin to widen them |
| `rate_limited` (429) | a per-minute limit | wait `Retry-After` seconds; never retry in a loop |
| `csrf_rejected` (403) | plain `fetch('/__drobek/v1/proxy/…')` | use `drobek.proxy.fetch` |
| `ssrf_blocked` (403) | the upstream resolves to a private address | the admin must use a public host |
| `upstream_error` (502) | unreachable, timed out or > 5 MiB | show "try again later" |
