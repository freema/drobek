---
name: ui
description: you style the app or build its screens — Tailwind CSS from esm.sh without a build step, responsive layout, the accessibility minimum, forms and loading, empty and error states
---

# ui — styling and screens

## 1. When to use

Any visible UI. Two styling options, both without a build step: plain CSS
imported from `src/main.tsx` (bundled into `/main.css`), or Tailwind CSS v4's
browser build loaded from esm.sh in `index.html` (it scans the page's
classes at run time). Do not install `tailwindcss`/PostCSS or use
`cdn.tailwindcss.com` (the apps CSP blocks it).

## 2. Minimal working code

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Orders</title>
    <script type="module" src="https://esm.sh/@tailwindcss/browser@4.1.11"></script>
    <style type="text/tailwindcss">
      @theme { --color-brand: #0f766e; }
    </style>
    <link rel="stylesheet" href="/main.css" />
  </head>
  <body class="bg-slate-50 text-slate-900">
    <div id="root"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
```

```tsx
// src/main.tsx
import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };
type Order = { id: string; title: string };

function Orders() {
  const [orders, setOrders] = useState<Load<Order[]>>({ state: 'loading' });
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setTimeout(() => setOrders({ state: 'ready', data: [] }), 300); // replace with a drobek.data list()
  }, []);

  function add(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setOrders((o) => (o.state === 'ready' ? { ...o, data: [...o.data, { id: crypto.randomUUID(), title }] } : o));
    setTitle('');
    setSaving(false);
  }

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="mb-6 text-2xl font-semibold">Orders</h1>
      <form onSubmit={add} className="mb-6 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="title" className="sr-only">Order title</label>
        <input id="title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New order"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 focus:outline-2 focus:outline-brand" />
        <button disabled={saving} className="rounded-md bg-brand px-4 py-2 text-white disabled:opacity-50">
          {saving ? 'Saving…' : 'Add'}
        </button>
      </form>
      {orders.state === 'loading' && <p aria-busy="true" className="text-slate-500">Loading…</p>}
      {orders.state === 'error' && <p role="alert" className="text-red-700">{orders.message}</p>}
      {orders.state === 'ready' && orders.data.length === 0 && <p className="text-slate-500">No orders yet.</p>}
      {orders.state === 'ready' && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {orders.data.map((o) => (
            <li key={o.id} className="rounded-lg bg-white p-4 shadow-sm">{o.title}</li>
          ))}
        </ul>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Orders />);
```

## 3. API and types

- Tailwind v4 utilities as usual (`sm:` / `md:` / `lg:` breakpoints,
  `dark:`, `hover:`, `focus:`, `disabled:`); theme tokens in
  `<style type="text/tailwindcss">@theme { … }</style>` (`--color-brand` →
  `bg-brand`, `text-brand`, `outline-brand`); `@apply` works only there,
  NOT in `.css` files (esbuild does not run Tailwind).
- Keep critical layout in plain CSS too if a flash of unstyled content
  matters (Tailwind applies once its script ran).
- Async screens: model `loading | error | ready` (the `Load<T>` above); show
  an empty state; disable the submit button while saving.
- Platform UI: `<LoginGate>` (`skill_info('auth')`) renders a styled card
  in `div.drobek-login` (inline styles; wrap it to position it); `<Form>`
  (`skill_info('forms')`) takes `className` and your own styled inputs.
- Fonts: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">` is allowed.

## 4. Rules and limits

- CSP: `script-src` = the app + https://esm.sh (as `type="module"`),
  `style-src` = the app + inline + any https, `img-src` / `font-src` also
  `data:` and https, `connect-src` = the app + esm.sh. No `<iframe>` of the
  app in other sites.
- Responsive: the viewport `<meta>` in `index.html`; mobile first (base
  classes = phone, `sm:`+ for wider); no fixed widths wider than 100vw;
  tap targets ≥ 44 px.
- Accessibility minimum: `<html lang>`; one `<h1>`; every input has a
  `<label>` (or `aria-label`); buttons are `<button>`, links `<a href>`;
  images have `alt`; focus stays visible; status text in `role="status"`,
  errors in `role="alert"`, pending regions `aria-busy="true"`; contrast ≥
  4.5:1 (e.g. `text-slate-500` on white is the lightest body text).
- Forms: native validation (`required`, `type="email"`, `min`/`max`)
  first; show the server's message (`DrobekError.message`) next to the
  form; never clear the user's input on an error.

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| page unstyled | Tailwind script not `type="module"`, or not from esm.sh | use the `<script type="module" src="https://esm.sh/@tailwindcss/browser@4.1.11">` line |
| `unresolved_import` | `import 'tailwindcss'` in TypeScript or `@import "tailwindcss"` in a `.css` file | load the browser build in `index.html` instead |
| `@apply` styles missing | `@apply` / `@tailwind` in a `.css` file pass through esbuild untouched | move them into `<style type="text/tailwindcss">` |
| `build_error` | invalid CSS (`file:line`) | fix the rule |
| layout breaks on phones | missing viewport meta or fixed widths | add the meta; use `max-w-*` + `w-full` |
