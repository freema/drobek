# email — notify the app's owners by e-mail

Use it when something in the app should reach its owners by e-mail: a
visitor asks for access, a stock level is low, someone reports a problem.
Also for the sender name of every e-mail the app sends (form notifications,
sign-in codes). There is **no way to e-mail an arbitrary address** from an
app: not from the browser, not through drobek. Never use EmailJS, SendGrid,
Resend, nodemailer or a `mailto:` workaround: they cannot run here.

For contact forms use the `forms` module instead (`skill_info('forms')`):
it stores every submission and e-mails the owners for you.

## Minimal working code (react-ts template, with the auth module)

Only a signed-in user can notify the owners, so the button lives inside
`<LoginGate>` (`skill_info('auth')`).

```tsx
// src/main.tsx
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { drobek } from 'drobek';
import { LoginGate } from 'drobek/auth';
import './styles.css';

function RequestAccess() {
  const [status, setStatus] = useState('');
  async function ask() {
    setStatus('Sending…');
    try {
      await drobek.email.notifyAdmins('Access request', 'Please give me access to the stock list.');
      setStatus('The owners were notified.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not send.');
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

## SDK

```ts
drobek.email.notifyAdmins(subject: string, text: string): Promise<{ sent: number }>
```

- `subject`: 1–150 characters, one line. `text`: 1–5000 characters of plain
  text (newlines kept, no HTML: markup is shown as text).
- The recipients are the app's **owners**: the editors and workspace admins
  of the app's drobek workspace. The e-mail says which signed-in user sent
  it, so the owner can reply to them.
- Errors reject with a `DrobekError` (`err.code`, `err.status`, `err.message`).

## Config (`configure_module`, optional)

```json
{ "app_id": "…", "module": "email", "config": { "fromName": "Acme bakery", "replyTo": "orders@acme.example" } }
```

- `fromName` (≤ 60 characters, one plain line): the sender name of every
  e-mail the app sends. The address is always the server's own. Applies at
  once.
- `replyTo`: where replies to the app's e-mails go. A new `replyTo`
  **needs the owner's confirmation**: `configure_module` answers
  `applied: false` with a `confirm_url` for the user.

## What the server enforces

- Recipients come only from the server: the app's owners, addresses the
  owner confirmed in a module config (e.g. `forms` notifications), or the
  signed-in user. Your code never names an address.
- `EMAIL_NOTIFY_ADMINS_PER_DAY` (20): `notifyAdmins` calls per app per day.
- `EMAIL_PER_APP_PER_DAY` (50): notification e-mails per app per day
  (notifyAdmins + form notifications together; sign-in codes do not count).
- An operator-wide hourly cap covers all app e-mail on the server; past it,
  app e-mail pauses for a while (`unavailable`).
- Subjects are one line (line breaks become spaces); texts are escaped into
  drobek's e-mail layout. `skill_info('email')` shows this server's limits.

## Common errors

| error | cause | fix |
|---|---|---|
| `unauthorized` (401) | nobody is signed in | wrap the UI in `<LoginGate>` (auth module) |
| `limit_exceeded` (429) | the app's daily e-mail limit | show "try again tomorrow"; never retry in a loop |
| `unavailable` (503) | app e-mail is paused on the server, or the mail server failed | show a message; try again later |
| `invalid_request` (400) | empty or too long subject/text | see `details[].path` |
| `csrf_rejected` (403) | `fetch` without the SDK | call `drobek.email.notifyAdmins` |
| `invalid_params` from configure_module | a bad `fromName` / `replyTo` | see `issues[].path` |
