# forms — contact, order and feedback forms without a backend

## 1. When to use

Visitors fill in a form and the answers must be kept or reach the owner:
contact, order/booking request, sign-up list, feedback. drobek stores each
submission and e-mails it to the app's owners. Never use Formspree, Netlify
Forms, EmailJS, Google Forms embeds or `mailto:` forms.

## 2. Minimal working code

No configuration needed: any form name works, anyone may submit, the
owners get an e-mail.

```tsx
// src/main.tsx
import { createRoot } from 'react-dom/client';
import { Form } from 'drobek/forms';
import './styles.css';

function Contact() {
  return (
    <main>
      <h1>Contact us</h1>
      <Form name="contact" success={<p id="thanks">Thanks, we will get back to you.</p>}>
        <label>
          Name <input name="name" required />
        </label>
        <label>
          Email <input name="email" type="email" required />
        </label>
        <label>
          Message <textarea name="message" required />
        </label>
        <button type="submit">Send</button>
      </Form>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Contact />);
```

`<Form name>` renders the `<form>`, adds the hidden anti-spam field, fetches
the time token on mount, sends every named field, then shows `success`
(default "Thank you — sent.") or an error (`role="alert"`). `drobek/forms`
is compiled with the app's React (`drobek.json` maps `react` +
`react/jsx-runtime`; the react-ts template does).

Without React:

```js
import { drobek } from 'drobek';

const form = document.querySelector('form');
void drobek.forms.prepare('contact'); // fetch the token early
if (form) form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await drobek.forms.submit('contact', new FormData(form));
  form.replaceWith('Thanks!');
});
```

Extra recipients / signed-in-only form:

```json
{ "app_id": "…", "module": "forms", "config": { "forms": {
  "contact": { "notify": { "emails": ["sales@example.com"], "owners": true } },
  "members-feedback": { "rules": { "submit": "user" } } } } }
```

## 3. API and types

```ts api
// drobek.forms
export type FieldValue = string | number | boolean | null | string[];
export interface Submission { id: string; created_at: string; data: Record<string, FieldValue>; user_id: string | null; notified: boolean }
export interface Api {
  prepare(form: string): Promise<void>; // fetch the time token early
  submit(form: string, data: Record<string, FieldValue> | FormData): Promise<{ ok: true; id: string }>; // waits ≥ 2 s after the token
  submissions(form: string, opts?: { limit?: number; before?: string }): Promise<{ submissions: Submission[]; next_cursor: string | null }>; // admins
  csvUrl(form: string): string; // admins: <a href={…} download>
}
```

```ts api
// drobek/forms
import type { FormHTMLAttributes, JSX, ReactNode } from 'react';
export interface FormProps extends Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit' | 'onError' | 'name' | 'action' | 'method' | 'children'> {
  name: string; // ^[a-z0-9][a-z0-9_-]{0,39}$
  children: ReactNode;
  success?: ReactNode;
  onSuccess?: (result: { id: string }) => void;
  onError?: (error: { code: string; message: string }) => void;
}
export function Form(props: FormProps): JSX.Element;
```

Config per form name: `rules.submit` `public` (default) | `user`;
`notify.emails` (≤ 10 extra addresses); `notify.owners` (default `true`;
`false` = store only). Failures reject with `DrobekError`.

## 4. Rules and limits

- Any change to `notify.emails` needs the owner's confirmation:
  `configure_module` answers `applied: false` + `confirm_url`.
- Body: a flat object — text ≤ 10 000 chars, numbers, booleans, null, lists
  of texts; ≤ 50 fields, 32 KiB; names starting with `_` are reserved. No
  files (upload with `files`, submit the id).
- Anti-spam: a filled honeypot is dropped silently (answered like a
  success); a submit < 2 s after its token is refused; tokens last 2 h.
- `FORMS_SUBMITS_PER_IP_HOUR` 10 per visitor per app,
  `FORMS_PER_APP_PER_DAY` 200 per app. Notifications also count against
  `EMAIL_PER_APP_PER_DAY`; past it submissions are still stored.
- Submissions are personal data: only app admins (auth, role `admin`) can
  list/export them; the owner also sees them in drobek.

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `invalid_request` (400) | empty form, nested object, a `_` field | read `details[].path`; send flat text fields |
| `submitted_too_fast` (429) | sent < 2 s after the token | the SDK waits by itself; call `prepare` early |
| `invalid_form_token` (400) | `_t` missing, other form, older than 2 h | submit through the SDK / `<Form>` |
| `rate_limited` (429) | 10 submissions from one visitor in an hour | show a message; `Retry-After` |
| `limit_exceeded` (429) | the app's daily submissions | try again tomorrow |
| `unauthorized` (401) | `rules.submit: user` without sign-in | `<LoginGate>` (`skill_info('auth')`) |
| `forbidden` (403) | listing submissions without the admin role | sign in as an admin |
| `unsupported_media_type` (415) | not JSON / multipart, or a file part | use the SDK |
| `unavailable` (503) | the server has no `DROBEK_MASTER_KEY` or mail paused | tell the owner; retry later |
