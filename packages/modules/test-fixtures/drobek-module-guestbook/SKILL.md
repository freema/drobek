# guestbook — visitors sign, everyone reads

A test module installed into the operator's modules directory. Visitors leave
a short message with their name; the app lists the newest entries.

## Minimal working code

```js
// src/main.js — the bare `drobek` import is the platform SDK (no install).
import { drobek } from 'drobek';

const list = document.querySelector('#entries');

async function refresh() {
  const book = await drobek.guestbook.list();
  list.textContent = book.entries.map((e) => `${e.name}: ${e.message}`).join('\n');
}

document.querySelector('#sign').addEventListener('click', async () => {
  try {
    await drobek.guestbook.sign('Ada', 'Lovely app!');
    await refresh();
  } catch (err) {
    // err is a DrobekError: err.status, err.code, err.message, err.hint
    list.textContent = err.code === 'guestbook_closed' ? 'The guestbook is closed.' : err.message;
  }
});

refresh();
```

## SDK

```ts
drobek.guestbook.list(): Promise<{ title: string; open: boolean; entries: { name: string; message: string; created_at: string }[] }>
drobek.guestbook.sign(name: string, message: string): Promise<{ entries: number }>   // name 1–40, message 1–280 characters
```

## Config

`{ title: string, open: boolean, maxEntries: 1–100 }` (defaults `Guestbook`,
`true`, `20`). With `open: false` `sign` fails with `guestbook_closed` (403).
`sign` is rate-limited per visitor IP (`GUESTBOOK_SIGNS_PER_HOUR`, default 10).

The module also contributes the greeter `guestbook` to `drobek.hello.greet(name, 'guestbook')`.
