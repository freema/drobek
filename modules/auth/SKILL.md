# auth — sign-in for the people who use the app

Use it when only certain people may use the app (a team, a company domain,
invited e-mails), when some of them are admins, or when data must belong to
the signed-in person. Users sign in with a 6-digit code drobek e-mails them;
there are no passwords. Never build your own login, and never use Firebase
Auth, Auth0, Clerk or similar: they cannot run here.

## 1. Say who may sign in (`configure_module`)

```json
{ "app_id": "…", "module": "auth", "config": {
  "allow": { "emails": ["ana@example.com"], "domains": ["example.com"] },
  "adminEmails": ["boss@example.com"] } }
```

- `allow.emails`: exact addresses. `allow.domains`: every address at that
  exact domain (`example.com`, not `sub.example.com`). `adminEmails` may sign
  in too and get the role `admin`. Addresses are case-insensitive.
- The editors of the app's workspace (you and the user you build for) can
  always sign in with their own e-mail, as `admin`: the preview works before
  you configure anything.
- `allow.anyone: true` lets anybody sign in and **needs the owner's
  confirmation**: `configure_module` answers `applied: false` with a
  `confirm_url`. Give the user that link and say why.
- `configure_module` takes a partial config (a JSON merge patch); lists are
  replaced as a whole, so send the full list.

## 2. Minimal working code (react-ts template)

```tsx
// src/main.tsx
import { createRoot } from 'react-dom/client';
import { drobek } from 'drobek';
import { LoginGate } from 'drobek/auth';
import './styles.css';

function Board({ email, role }: { email: string; role: string }) {
  return (
    <main>
      <h1>Team board</h1>
      <p id="who">Signed in as {email} ({role})</p>
      <button onClick={() => drobek.auth.logout()}>Sign out</button>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <LoginGate title="Team board">{(user) => <Board email={user.email} role={user.role} />}</LoginGate>
);
```

`<LoginGate>` shows the e-mail → code form (fields "Email" and "Code") to
signed-out visitors and its children to signed-in ones. `drobek/auth` is
compiled into your app with your own React: `drobek.json` must map `react`
and `react/jsx-runtime` (the react-ts template does). No install, no
`node_modules`.

Without React (any template):

```js
import { drobek } from 'drobek';
const user = await drobek.auth.me();            // null when signed out
if (!user) {
  await drobek.auth.sendCode(email);             // e-mails the code
  const u = await drobek.auth.verify(email, code); // sets the session cookie
}
```

## SDK

```ts
interface User { id: string; email: string; role: 'user' | 'admin' }
drobek.auth.me(): Promise<User | null>        // also extends the 30-day session
drobek.auth.sendCode(email: string): Promise<{ sent: true; email: string; expires_in: number }>
drobek.auth.verify(email: string, code: string): Promise<User>
drobek.auth.logout(): Promise<void>
drobek.auth.onChange(cb: (user: User | null) => void): () => void // unsubscribe

// import { LoginGate, useAuth } from 'drobek/auth'
<LoginGate title?="Sign in" requireAdmin?={false} loading?={<p>…</p>}>
  {children | ((user: User) => ReactNode)}
</LoginGate>
useAuth(): { user: User | null; loading: boolean; error: string | null; logout(); refresh() }
```

Errors reject with a `DrobekError` (`err.code`, `err.status`, `err.message`).

## What the server enforces

- The session is an HttpOnly cookie of **this host** (30 days, extended by
  every `me()`); your code never sees a token. Other platform modules see
  the signed-in user and apply their `user` / `admin` / `owner` rules to it.
- **Preview and production are different hosts** (`<slug>--preview.…` and
  `<slug>.…`): a sign-in on the preview does not carry over. Test on the
  preview, then sign in again on the published app. Users are shared: the
  same e-mail is the same user (same `id`) on both.
- A code is valid 10 minutes, works once, and dies after 5 wrong tries.
- Per app (defaults in parentheses; this server's values are in the
  `limits` of `skill_info('auth')`): `AUTH_CODES_PER_IP_15MIN` (5) and
  `AUTH_CODES_PER_IP_DAY` (20) codes per visitor IP,
  `AUTH_CODES_PER_EMAIL_HOUR` (3) per address (more requests answer "sent"
  but send nothing new), `AUTH_CODES_PER_APP_HOUR` (100, but never more
  than the app's share of the server's sign-in budget — 25 by default; then
  sign-in e-mails pause 15 minutes), `AUTH_ATTEMPTS_PER_IP_15MIN` (30 send/verify calls),
  `END_USERS_MAX_PER_APP` (1000 users).
- Every request re-checks the user, in every module: removed from the
  allowlist or disabled → signed out at once; a role follows `adminEmails`
  on the next request. The owner can sign every user of the app out at once
  from the dashboard.
- Only the app itself can call these routes (the SDK sends the
  `X-Drobek-SDK: 1` header; other origins are refused).

## Common errors

| error | cause | fix |
|---|---|---|
| `email_not_allowed` (403) | the address is not in `allow` / `adminEmails` (or is disabled) | add it with `configure_module`, or tell the user who may sign in |
| `invalid_code` (400) | wrong or expired code | re-enter it, or `sendCode` again |
| `too_many_attempts` (429) | 5 wrong codes | request a new code |
| `rate_limited` (429) | too many codes or attempts from one IP | wait (`Retry-After`), show a friendly message |
| `unavailable` (503) | sign-in e-mails paused or the mail server failed | try again later |
| `limit_exceeded` (429) | the app has `END_USERS_MAX_PER_APP` users | the owner removes users or raises the limit |
| `csrf_rejected` (403) | `fetch` without the SDK or from another origin | call through `drobek.auth` / `<LoginGate>` |
| `unresolved_import` for `react` from `drobek/auth` | `drobek.json` lacks react | add `react` and `react/jsx-runtime` (see the react-ts template) |
| `invalid_params` from configure_module | a bad e-mail/domain or an unknown key | see `issues[].path` |
