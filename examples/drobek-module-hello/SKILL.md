# hello — the example platform module

Use it to check that platform modules work end to end: a server route, the
browser SDK, per-app config and a rate limit. It greets the visitor and
counts "waves".

## Minimal working code

```js
// src/main.js — the bare `drobek` import is the platform SDK (no install).
import { drobek } from 'drobek';

const out = document.querySelector('#out');
let message = '';

drobek.hello.ping().then((hello) => {
  message = hello.message;
  out.textContent = `${message} (${hello.waves} waves so far)`;
});

document.querySelector('#wave').addEventListener('click', async () => {
  try {
    const { waves } = await drobek.hello.wave('Ada');
    out.textContent = `${message} (${waves} waves so far)`;
  } catch (err) {
    // err is a DrobekError: err.status, err.code, err.message, err.hint
    out.textContent = err.code === 'rate_limited' ? 'Slow down a little.' : err.message;
  }
});
```

## SDK

```ts
drobek.hello.ping(): Promise<{ greeting: string; message: string; waves: number; signed: boolean; signature?: string }>
drobek.hello.wave(name: string): Promise<{ waves: number }>   // name: 1–40 characters
```

HTTP (what the SDK calls): `GET /__drobek/v1/hello`, `POST /__drobek/v1/hello/wave`
with `{ "name": "Ada" }`. Only the app itself may call them (same origin; the
SDK sends the `X-Drobek-SDK: 1` header).

## Config (configure_module)

```json
{ "greeting": "Hello", "excited": false }
```

- `greeting` (1–80 characters): the text `ping()` returns. **Changing it needs the
  app owner's confirmation**: configure_module answers `applied: false` with
  `pending_confirmation` and a `confirm_url` — give the user that link and say
  what you asked for. Until they confirm, the old greeting stays in force.
- `excited` (boolean): adds `!` to the message. Applies immediately.

`configure_module` takes a partial config (a JSON merge patch): send only the
keys you change; `null` resets a key to its default.

## Limits and rules

- `wave` is limited to `HELLO_WAVES_PER_MINUTE` calls per visitor IP per
  minute (default 30; the operator may set another value per workspace).
  Past it the call fails with `rate_limited` (HTTP 429, `Retry-After`).
- Both routes are public: no sign-in needed.
- Optional secret `HELLO_SIGNATURE`: when the app owner sets it in the
  dashboard, `ping()` also returns `signed: true` and an HMAC `signature` of
  the message. You never see or set the secret yourself.

## Common errors

| error | cause | fix |
|---|---|---|
| `invalid_request` + `details[].path = "name"` | wave name empty or over 40 chars | send 1–40 characters |
| `rate_limited` | too many waves from one visitor | show a friendly message; retry after `Retry-After` seconds |
| `csrf_rejected` | called with fetch from another origin or without the SDK | call through `drobek.hello` from the app itself |
| `invalid_params` from configure_module | config key has the wrong type/length | see the `issues[].path` in the error |
