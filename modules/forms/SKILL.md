# forms — contact, order and feedback forms without a backend

Use it when visitors fill in a form and the answers must be kept or reach
the owner: a contact form, an order or booking request, a sign-up list,
feedback. drobek stores every submission and e-mails it to the app's
owners. Never use Formspree, Netlify Forms, EmailJS, Google Forms embeds or
a `mailto:` form: they cannot run here, or leak the data to a third party.

## Minimal working code (react-ts template)

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

`<Form name="…">` renders a `<form>` around your inputs, adds the invisible
anti-spam field, fetches the time token when it mounts and sends every
named field; after a success it shows `success` (default "Thank you —
sent."), on an error a message (`role="alert"`). `drobek/forms` is compiled
into your app with your own React (`drobek.json` maps `react` and
`react/jsx-runtime`; the react-ts template does). It works for any form
name, with no configuration: anyone may submit and the owners get an e-mail.

Without React:

```js
import { drobek } from 'drobek';
drobek.forms.prepare('contact');                     // on page load: fetch the token early
await drobek.forms.submit('contact', new FormData(formElement)); // or a plain object
```

## SDK

```ts
type FieldValue = string | number | boolean | null | string[];
drobek.forms.prepare(form: string): Promise<void>
drobek.forms.submit(form: string, data: Record<string, FieldValue> | FormData): Promise<{ ok: true; id: string }>
drobek.forms.submissions(form: string, opts?: { limit?: number; before?: string }) // admins
  : Promise<{ submissions: { id, created_at, data, user_id, notified }[]; next_cursor: string | null }>
drobek.forms.csvUrl(form: string): string               // admins: <a href={…} download>

// import { Form } from 'drobek/forms'
<Form name="contact" success?={<p>…</p>} onSuccess?={({ id }) => …} onError?={({ code, message }) => …}
      className?="…">{inputs + submit button}</Form>
```

Errors reject with a `DrobekError` (`err.code`, `err.status`, `err.message`).

## Config (`configure_module`, optional)

```json
{ "app_id": "…", "module": "forms", "config": { "forms": {
  "contact": { "notify": { "emails": ["sales@example.com"], "owners": true } },
  "members-feedback": { "rules": { "submit": "user" } } } } }
```

- `notify.emails` (≤ 10): extra addresses that get every submission. Any
  change **needs the owner's confirmation**: `configure_module` answers
  `applied: false` with a `confirm_url`; give the user that link.
- `notify.owners` (default `true`): e-mail the app's owners (the editors and
  admins of its drobek workspace). `false` = store only.
- `rules.submit`: `public` (default) or `user` (signed-in users only, see
  `skill_info('auth')`).

## What the server enforces

- The body: a flat object of text (≤ 10 000 characters), numbers,
  true/false or lists of texts; ≤ 50 fields, 32 KiB in total; names starting
  with `_` are reserved. No files (use the files module, submit the id).
- Anti-spam: a filled honeypot is dropped silently (it answers like a
  success); a submission less than 2 s after its token is refused; tokens
  last 2 hours (the SDK renews them).
- `FORMS_SUBMITS_PER_IP_HOUR` (10) per visitor per app, `FORMS_PER_APP_PER_DAY`
  (200) per app. Notification e-mails also count against the email module's
  `EMAIL_PER_APP_PER_DAY`; past it submissions are still stored.
- The e-mail shows the fields as plain text: HTML in a field is never
  rendered. Submissions are personal data: only the app's admins (auth
  module, role `admin`) can list or export them; the owner also sees them in
  drobek.

## Common errors

| error | cause | fix |
|---|---|---|
| `invalid_request` (400) | an empty form, a nested object, a file, a `_` field | see `details[].path`; send flat text fields |
| `submitted_too_fast` (429) | sent < 2 s after the token | the SDK waits by itself; call `prepare` early |
| `invalid_form_token` (400) | `_t` missing, from another form, or older than 2 h | submit through the SDK / `<Form>` |
| `rate_limited` (429) | 10 submissions from one visitor within an hour | show a message; `Retry-After` |
| `limit_exceeded` (429) | the app's daily submissions | try again tomorrow |
| `unauthorized` / `forbidden` | `rules.submit: user` without sign-in; listing without admin | `<LoginGate>`; sign in as an admin |
| `unsupported_media_type` (415) | not JSON / multipart, or a file part | use the SDK |
