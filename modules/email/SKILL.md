# email — notify the app's owners by e-mail

## 1. When to use

Something in the app must reach its owners by e-mail: an access request, a
low-stock alert, a problem report. Also: the sender name / Reply-To of every
e-mail the app sends. An app can NOT e-mail an arbitrary address (no
EmailJS, SendGrid, Resend, nodemailer, `mailto:` tricks). A contact form →
use `forms` (`skill_info('forms')`): it stores and e-mails submissions.

## 2. Minimal working code

`notifyAdmins` needs a signed-in user, so the UI sits in `<LoginGate>`
(`skill_info('auth')`).

```tsx
// src/main.tsx
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { drobek, DrobekError } from 'drobek';
import { LoginGate } from 'drobek/auth';
import './styles.css';

function RequestAccess() {
  const [status, setStatus] = useState('');
  async function ask() {
    setStatus('Sending…');
    try {
      const { sent } = await drobek.email.notifyAdmins('Access request', 'Please give me access to the stock list.');
      setStatus(sent > 0 ? 'The owners were notified.' : 'Nobody to notify.');
    } catch (err) {
      setStatus(err instanceof DrobekError && err.code === 'limit_exceeded' ? 'Daily limit reached — try tomorrow.' : 'Could not send.');
    }
  }
  return (
    <main>
      <h1>Stock</h1>
      <button onClick={ask}>Ask the owners for access</button>
      <p role="status">{status}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <LoginGate title="Stock">
    <RequestAccess />
  </LoginGate>
);
```

Optional sender settings:

```json
{ "app_id": "…", "module": "email", "config": { "fromName": "Acme bakery", "replyTo": "orders@acme.example" } }
```

## 3. API and types

```ts api
// drobek.email
export interface Api {
  /** E-mail the app's owners. subject 1–150 chars (one line), text 1–5000 chars plain text. */
  notifyAdmins(subject: string, text: string): Promise<{ sent: number }>;
}
```

- Recipients = the app's **owners**: editors and workspace-admins of the
  app's drobek workspace. The mail names the signed-in user who sent it.
  The subject becomes `[<app name>] <subject>`.
- Config: `fromName` (≤ 60 chars, one plain line, no `"<>@\`) — applies at
  once; `replyTo` (an address) — see rules. Failures reject with
  `DrobekError` (`code`, `status`, `message`).
- REST: `POST /__drobek/v1/email/notify-admins { subject, text }` with the
  header `X-Drobek-SDK: 1` (the SDK sends it).

## 4. Rules and limits

- A new or changed `replyTo` needs the owner's confirmation:
  `configure_module` answers `applied: false` + `confirm_url`; give the user
  the link.
- Recipients come only from the server: the owners, addresses the owner
  confirmed in a module config (e.g. `forms` notify lists), the signed-in
  user. App code never names an address.
- `EMAIL_NOTIFY_ADMINS_PER_DAY` 20 `notifyAdmins` calls per app per day;
  `EMAIL_PER_APP_PER_DAY` 50 notification e-mails per app per day
  (notifyAdmins + form notifications; sign-in codes do not count).
- An operator-wide hourly budget covers all app e-mail; past it,
  notifications pause for a while (`unavailable`), sign-in codes keep going.
- The text is escaped into drobek's layout: HTML shows as text.
  `skill_info('email').limits` has this server's values.

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `unauthorized` (401) | nobody is signed in | wrap the UI in `<LoginGate>` |
| `limit_exceeded` (429) | the app's daily e-mail limit | show "try again tomorrow"; never retry in a loop |
| `unavailable` (503) | app e-mail paused on the server, or SMTP failed | show a message; retry later |
| `invalid_request` (400) | empty or too long subject/text | read `details[].path` |
| `csrf_rejected` (403) | raw `fetch` without the SDK header | call `drobek.email.notifyAdmins` |
| `invalid_params` | configure_module: bad `fromName` / `replyTo` | read `issues[].path` |
