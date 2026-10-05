# proxy — call an external API without putting its key in the app

## 1. When to use

The app needs an API that takes a secret key (Anthropic, OpenAI, Stripe, a
weather/maps API, the owner's backend), or any API on another origin (the apps
CSP blocks direct `fetch` to other sites). drobek adds the key server-side and
forwards. Never put a key in app files (write_files refuses it), never import
`openai` / `@anthropic-ai/sdk` / `stripe` in the browser or ask for a key in chat.

## 2. Minimal working code

(1) A workspace admin registers the upstream: `register_upstream({ workspace,
name, base_url, allowed_methods, allowed_path_prefixes, auth_type })` (public
host, port 80/443). `auth_type: "none"` registers at once; `bearer` / a named
`header` need a key, which never goes through MCP: give the user the answer's
`secret_url` (the dashboard form) to paste it. Check with `list_upstreams`.
One upstream = one host; never register in bulk (`UPSTREAMS_MAX_PER_WORKSPACE`
20, `UPSTREAM_REGISTRATIONS_PER_HOUR` 20 → `limit_exceeded` / `rate_limited`).
(2) Assign it to the app (an unregistered name is refused):

```json
{ "app_id": "…", "module": "proxy", "config": { "upstreams": { "anthropic": { "rules": { "call": "user" } } } } }
```

A **workspace admin** confirms it: the answer is `applied: false` + `confirm_url`
(`confirm_role: "admin"`) — give the user the link; until then calls answer 403.

### Streaming (LLM APIs)

Ask an LLM API to stream (`stream: true`): the `text/event-stream` answer arrives
event by event, renders as it is written and never hits a timeout. Stop = abort.

```tsx
// src/main.tsx
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { drobek } from 'drobek';
import { LoginGate } from 'drobek/auth';

function Ask() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const stop = useRef<AbortController | null>(null);
  async function ask() {
    setAnswer('');
    const ctrl = (stop.current = new AbortController());
    try {
      const res = await drobek.proxy.fetch('anthropic', '/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 4096, stream: true, messages: [{ role: 'user', content: question }] }),
      });
      if (!res.ok || !res.body) return setAnswer((await res.json()).message ?? `Error ${res.status}`);
      const [reader, decoder] = [res.body.getReader(), new TextDecoder()];
      let buffer = '';
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        buffer += decoder.decode(r.value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          const data = event.split('\n').find((line) => line.startsWith('data: '));
          const e = data ? JSON.parse(data.slice(6)) : null;
          if (e?.type === 'content_block_delta' && e.delta.type === 'text_delta') setAnswer((a) => a + e.delta.text);
          if (e?.error) setAnswer((a) => `${a}\n[${e.message ?? e.error.message}]`);
        }
      }
    } catch {
      setAnswer((a) => `${a} [stopped]`);
    }
  }
  return (
    <main>
      <textarea aria-label="Question" value={question} onChange={(e) => setQuestion(e.target.value)} />
      <button onClick={ask} disabled={!question}>Ask</button> <button onClick={() => stop.current?.abort()}>Stop</button>
      <p role="status">{answer}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<LoginGate title="Ask"><Ask /></LoginGate>);
```

`call: "user"` = signed-in users only (`skill_info('auth')`), hence `<LoginGate>`.
Without `stream: true` the answer arrives whole (`await res.json()`).

## 3. API and types

```ts api
// drobek.proxy
export interface Api {
  /** fetch() through drobek: `path` (+ ?query) is appended to the upstream's base URL. Any status resolves — check res.ok. */
  fetch(upstream: string, path?: string, init?: RequestInit): Promise<Response>;
}
```

- Same as `fetch`: `init` is a normal `RequestInit` (method, headers, body,
  signal). It never throws a `DrobekError`; drobek's own refusals are JSON
  `{ error, message, details? }` (table below), anything else is the upstream's.
- Your `Authorization` and `Cookie` headers are dropped (the server's key
  wins); other headers (e.g. `anthropic-version`) pass through.
- The response body arrives decoded (gzip/br undone). Only safe headers come
  back (`Content-Type`, caching, `Retry-After`, request ids, rate-limit
  hints …); `Set-Cookie`, CORS and an absolute `Location` never do.
- Config `upstreams.<name>`: `rules.call` (default `user`) = `user | admin |
  public | none`, joined with `|` (`owner` is refused); `rateLimit?` = calls per
  minute from the whole app; `id` = the record an admin confirmed, set by
  drobek — never write it. Unassign: `{ "upstreams": { "anthropic": null } }`.
- `get_app` → `modules.proxy.info.upstreams[]`: `{ name, registered, assigned,
  call?, rateLimit?, hasSecret, allowedMethods?, allowedPathPrefixes? }`.
- REST: `/__drobek/v1/proxy/<upstream>/<path>` with `X-Drobek-SDK: 1`.

## 4. Rules and limits

- Assigning an upstream and opening `call` to `public` need confirmation.
  `public` = every visitor spends the owner's API budget; prefer `user`.
- Only assigned upstreams, only the admin's methods + path prefixes.
- `PROXY_CALLS_PER_MIN` 60 per app; `PROXY_PUBLIC_CALLS_PER_MIN_PER_IP` 10 for
  `public` upstreams. In flight at once: `PROXY_MAX_CONCURRENT_PER_APP` 8 per
  app, `PROXY_MAX_CONCURRENT_PER_CALLER` 2 per user (or IP) — an open stream
  counts until it ends: queue calls, abort a stream nobody reads.
- A redirect within the same scheme, host, port and allowed prefixes (`/rss` →
  `/rss/`) is followed on the server, at most 3 hops (301/302/303 after POST →
  GET); any other is `upstream_redirect` (502). The app never sees a 3xx but 304.
- Buffered: 120 s and ≤ 5 MiB for the whole redirect chain; request ≤ 1 MiB.
  A `text/event-stream` answer streams; 60 s without data, 10 min or 32 MiB cut
  it with a last `event: error`, `data: {"error":"upstream_error","message":…,
  "details":{"reason":"stream_idle|stream_too_long|stream_too_large"}}`.
- Private/internal addresses and ports other than 80/443 are unreachable.
- The key never appears in responses, logs, get_app or skill_info.

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `forbidden` (403) | `details.reason: upstream_not_assigned` (not configured / not confirmed), or the caller's role | `configure_module('proxy')`; an admin confirms |
| `forbidden` (403) | `details.reason: upstream_not_allowed` (no admin confirmed this app) or `upstream_replaced` (deleted and registered again since) | remove it from the config, add it again, an admin confirms |
| `unauthorized` (401) | `call: "user"` and nobody signed in | wrap the UI in `<LoginGate>` |
| `not_found` (404) | `details.reason: upstream_not_registered` | `register_upstream` (a workspace admin), same name |
| `invalid_params` (configure_module) | `upstream_not_registered`: the name is not registered | register it first, then assign |
| `method_not_allowed` (405) | method outside the allow-list | use an allowed method |
| `path_not_allowed` (403) | path outside the allowed prefixes | use an allowed path, or ask the admin |
| `rate_limited` (429) | a per-minute limit | wait `Retry-After`; never loop |
| `proxy_busy` (429) | too many calls in flight (user, app or server) | wait `Retry-After`; fewer parallel calls; stop unused streams |
| `csrf_rejected` (403) | raw `fetch('/__drobek/v1/proxy/…')` | use `drobek.proxy.fetch` |
| `ssrf_blocked` (403) | upstream resolves to a private address | the admin must use a public host |
| `upstream_error` (502) | unreachable, no answer in 120 s or > 5 MiB (decoded); in a stream: the `error` event | show "try again later"; stream long LLM answers |
| `upstream_redirect` (502) | a redirect to another host/scheme/port, outside the prefixes, > 3 hops or a loop; `details.location_path` = the target path | call the final path directly; ask the admin to allow that prefix, or to register the other host as its own upstream |
| `config_error` (500) | the upstream's stored key is unusable | the admin re-enters it in the dashboard |
