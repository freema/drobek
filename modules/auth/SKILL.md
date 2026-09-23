# auth — sign-in for the people who use the app

## 1. When to use

Only some people may use the app (invited e-mails, a company domain), some
of them are admins, or records must belong to the signed-in person. Sign-in
is a 6-digit code e-mailed by drobek; no passwords. Never build your own
login; Firebase Auth, Auth0, Clerk, NextAuth cannot run here.

## 2. Minimal working code

```json
{ "app_id": "…", "module": "auth", "config": {
  "allow": { "emails": ["ana@example.com"], "domains": ["example.com"] },
  "adminEmails": ["boss@example.com"] } }
```

```tsx
// src/main.tsx
import { createRoot } from 'react-dom/client';
import { drobek } from 'drobek';
import { LoginGate } from 'drobek/auth';
import './styles.css';

function Board({ email, role }: { email: string; role: 'user' | 'admin' }) {
  return (
    <main>
      <h1>Team board</h1>
      <p id="who">Signed in as {email} ({role})</p>
      {role === 'admin' && <p>Admin tools go here.</p>}
      <button onClick={() => drobek.auth.logout()}>Sign out</button>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <LoginGate title="Team board">{(user) => <Board email={user.email} role={user.role} />}</LoginGate>
);
```

- `<LoginGate>` shows the e-mail → code form (labels "Email", "Code") to
  signed-out visitors, its children to signed-in users. `requireAdmin`
  lets only admins through.
- `drobek/auth` is compiled into the app with the app's React: `drobek.json`
  must map `react` and `react/jsx-runtime` (the react-ts template does).
- The editors of the app's workspace (you, the user you build for) can
  always sign in with their own address, as `admin`: the preview works
  before any config.

Without React:

```js
import { drobek } from 'drobek';

const form = document.querySelector('form');
if (form) form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = String(new FormData(form).get('email'));
  const code = String(new FormData(form).get('code') ?? '');
  if (!code) await drobek.auth.sendCode(email);
  else console.log('signed in', await drobek.auth.verify(email, code));
});
console.log('current user', await drobek.auth.me());
```

## 3. API and types

```ts api
// drobek.auth
export interface User { id: string; email: string; role: 'user' | 'admin' }
export interface Api {
  me(): Promise<User | null>; // null = signed out; also extends the 30-day session
  sendCode(email: string): Promise<{ sent: true; email: string; expires_in: number }>;
  verify(email: string, code: string): Promise<User>; // sets the session cookie
  logout(): Promise<void>;
  onChange(listener: (user: User | null) => void): () => void; // returns unsubscribe
}
```

```ts api
// drobek/auth
import type { JSX, ReactNode } from 'react';
export interface User { id: string; email: string; role: 'user' | 'admin' }
export interface LoginGateProps {
  children: ReactNode | ((user: User) => ReactNode);
  title?: string; // default "Sign in"
  requireAdmin?: boolean; // other signed-in users see "no access" + sign out
  loading?: ReactNode; // shown while the session is checked
}
export function LoginGate(props: LoginGateProps): JSX.Element;
export function useAuth(): { user: User | null; loading: boolean; error: string | null; logout(): Promise<void>; refresh(): Promise<void> };
```

Config (`configure_module`, a JSON merge patch; lists are replaced whole):
`allow.emails` exact addresses, `allow.domains` exact domains (not
subdomains), `allow.anyone` everybody, `adminEmails` may sign in as `admin`.
Failures reject with `DrobekError` (`code`, `status`, `message`).

## 4. Rules and limits

- `allow.anyone: true` needs the owner's confirmation: `configure_module`
  answers `applied: false` + `confirm_url`; give the user the link.
- The session is an HttpOnly cookie of THIS host (30 days); the app never
  sees a token. Preview (`<slug>--preview.…`) and production (`<slug>.…`)
  are different hosts: sign in on each. Users (ids) are shared.
- A code lives 10 minutes, works once, dies after 5 wrong tries.
- Every module request re-checks the user: removed from `allow` or disabled
  → anonymous at once; the role follows `adminEmails` on the next request.
  Other modules apply their `user` / `owner` / `admin` rules to this user.
- Per app: `AUTH_CODES_PER_IP_15MIN` 5, `AUTH_CODES_PER_IP_DAY` 20,
  `AUTH_CODES_PER_EMAIL_HOUR` 3 (more requests answer "sent", send nothing),
  `AUTH_CODES_PER_APP_HOUR` 100 (never above the app's share of the server's
  sign-in budget, 25 by default; then sign-in mail pauses 15 min),
  `AUTH_ATTEMPTS_PER_IP_15MIN` 30, `END_USERS_MAX_PER_APP` 1000.
  `skill_info('auth').limits` has this server's values.
- Only the app's own pages can call the routes (the SDK sends `X-Drobek-SDK: 1`).

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `email_not_allowed` (403) | address not in `allow` / `adminEmails`, or disabled | `configure_module('auth')`, or tell the user who may sign in |
| `invalid_code` (400) | wrong, used or expired code | re-enter, or `sendCode` again |
| `too_many_attempts` (429) | 5 wrong codes | request a new code |
| `rate_limited` (429) | too many codes/attempts from one IP | wait `Retry-After`; show a message |
| `unavailable` (503) | sign-in mail paused or SMTP down | try later |
| `limit_exceeded` (429) | `END_USERS_MAX_PER_APP` reached | the owner removes users |
| `csrf_rejected` (403) | raw `fetch` or another origin | use `drobek.auth` / `<LoginGate>` |
| `unresolved_import` | `drobek.json` lacks `react` for `drobek/auth` | map `react` + `react/jsx-runtime` |
| `invalid_params` | configure_module: bad address/domain, unknown key | read `issues[].path` |
