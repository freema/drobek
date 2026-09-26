# {{module}} — keep a list of items on the server

## 1. When to use

The app keeps a shared list on the server: every visitor of the app sees the
same items, and adding one is a server call. Nothing is stored in the
browser.

## 2. Minimal working code

```ts
// src/main.ts — the bare `drobek` import is the platform SDK (no install).
import { drobek, DrobekError } from 'drobek';

const list = document.querySelector<HTMLUListElement>('#items')!;
const form = document.querySelector<HTMLFormElement>('#add')!;

async function render() {
  const { items } = await drobek.{{module}}.list();
  list.replaceChildren(...items.map((item) => Object.assign(document.createElement('li'), { textContent: item.title })));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = String(new FormData(form).get('title') ?? '');
  try {
    await drobek.{{module}}.add(title);
    form.reset();
    await render();
  } catch (err) {
    // err.code: see "Errors → fix"
    alert(err instanceof DrobekError && err.code === '{{module}}_full' ? 'The list is full.' : String(err));
  }
});

void render();
```

## 3. API and types

```ts api
// drobek.{{module}}
export interface Item {
  id: number;
  title: string;
  created_at: string;
}
export interface Api {
  /** The app's items, newest first (at most 100); upstream: the owner set {{MODULE}}_API_KEY */
  list(): Promise<{ items: Item[]; upstream: boolean }>;
  /** title: 1–200 characters; rate-limited ({{MODULE}}_ADDS_PER_MINUTE per visitor IP per minute) */
  add(title: string): Promise<Item>;
}
```

HTTP (what the SDK calls): `GET /__drobek/v1/{{module}}/items` and
`POST /__drobek/v1/{{module}}/items` with `{ "title": "…" }`. Only the app
itself may call them (same origin; the SDK sends `X-Drobek-SDK: 1`).

Config (configure_module takes a partial config; `null` resets a key):

```json
{ "app_id": "…", "module": "{{module}}", "config": { "write": "user", "maxItems": 500 } }
```

- `write`: `"public"` (anyone may add, the default) or `"user"` (only end
  users signed in through the `auth` module). **Changing it to `"public"`
  needs the app owner's confirmation**: configure_module answers
  `applied: false` with a `confirm_url` — give the user that link.
- `maxItems` (1–100000, default 1000): the most items the app keeps.

## 4. Rules and limits

- `add` is limited to `{{MODULE}}_ADDS_PER_MINUTE` calls per visitor IP per
  minute (default 30; the operator may set another value per workspace).
- Optional secret `{{MODULE}}_API_KEY`: the app owner sets it in the
  dashboard; `list()` answers `upstream: true` then. Never ask the user for
  its value and never put it in the app's code.

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `invalid_request` + `details[].path = "title"` | empty title or over 200 characters | send 1–200 characters |
| `unauthorized` | `write` is `"user"` and nobody is signed in | sign in first (`skill_info('auth')`) |
| `{{module}}_full` (409) | the app keeps `maxItems` items already | tell the user; the owner can raise `maxItems` |
| `rate_limited` | too many adds from one visitor | retry after `Retry-After` seconds |
| `csrf_rejected` | called with fetch from another origin or without the SDK | call through `drobek.{{module}}` from the app itself |
