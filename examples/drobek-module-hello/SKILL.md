# hello — the example platform module

## 1. When to use

Check that platform modules work end to end: a server route, the browser
SDK, per-app config, a secret and a rate limit. It greets the visitor and
counts "waves". Other modules may contribute greeters (the slot
`hello.greeter`).

## 2. Minimal working code

```ts
// src/main.ts — the bare `drobek` import is the platform SDK (no install).
import { drobek, DrobekError } from 'drobek';

const out = document.querySelector<HTMLParagraphElement>('#out')!;
let message = '';

drobek.hello.ping().then((hello) => {
  message = hello.message;
  out.textContent = `${message} (${hello.waves} waves so far)`;
});

document.querySelector('#wave')!.addEventListener('click', async () => {
  try {
    const { waves } = await drobek.hello.wave('Ada');
    out.textContent = `${message} (${waves} waves so far)`;
  } catch (err) {
    // err is a DrobekError: err.status, err.code, err.message, err.hint
    out.textContent = err instanceof DrobekError && err.code === 'rate_limited' ? 'Slow down a little.' : String(err);
  }
});
```

## 3. API and types

```ts api
// drobek.hello
export interface Hello {
  greeting: string;
  /** greeting + "!" when excited, else greeting + "." */
  message: string;
  waves: number;
  /** true when the owner set the HELLO_SIGNATURE secret */
  signed: boolean;
  signature?: string;
}
export type Visitor = { signed_in: false } | { signed_in: true; id: string; email: string; role: 'user' | 'admin' };
export interface Api {
  ping(): Promise<Hello>;
  /** The visitor as every platform module sees them (signed in through the auth module, or not). */
  whoami(): Promise<Visitor>;
  /** name: 1–40 characters; rate-limited (HELLO_WAVES_PER_MINUTE per visitor per minute) */
  wave(name: string): Promise<{ waves: number }>;
  /** Greet `name` (1–40 characters) with the configured greeting, or with a greeter another module contributes (its id). */
  greet(name: string, greeter?: string): Promise<{ text: string; greeter: string | null }>;
}
```

`greet(name)` answers `"<greeting>, <name>"`; `greet(name, id)` uses the
greeter another module contributes under that id. HTTP (what the SDK calls):
`GET /__drobek/v1/hello`, `POST /__drobek/v1/hello/wave` with
`{ "name": "Ada" }`, `GET /__drobek/v1/hello/greet?name=Ada&greeter=<id>`,
`GET /__drobek/v1/hello/whoami`. Only the app itself may call them (same
origin; the SDK sends the `X-Drobek-SDK: 1` header).

Config (configure_module takes a partial config; `null` resets a key):

```json
{ "app_id": "…", "module": "hello", "config": { "greeting": "Hello", "excited": false } }
```

- `greeting` (1–80 characters): the text `ping()` returns. **Changing it
  needs the app owner's confirmation**: configure_module answers
  `applied: false` with a `confirm_url` — give the user that link. Until
  they confirm, the old greeting stays in force.
- `excited` (boolean): adds `!` to the message. Applies immediately.

## 4. Rules and limits

- `wave` is limited to `HELLO_WAVES_PER_MINUTE` calls per visitor IP per
  minute (default 30; the operator may set another value per workspace).
- Every route is public: no sign-in needed.
- Optional secret `HELLO_SIGNATURE`: when the app owner sets it in the
  dashboard, `ping()` also returns `signed: true` and an HMAC `signature` of
  the message. Never ask the user for its value.

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `invalid_request` + `details[].path = "name"` | wave name empty or over 40 chars | send 1–40 characters |
| `rate_limited` | too many waves from one visitor | show a friendly message; retry after `Retry-After` seconds |
| `unknown_greeter` (404) | `greet(name, id)` with an id no module contributes | omit the greeter, or use one of `details.available` |
| `csrf_rejected` | called with fetch from another origin or without the SDK | call through `drobek.hello` from the app itself |
