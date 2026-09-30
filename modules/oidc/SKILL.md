# oidc — sign in with a company account (OpenID Connect)

## 1. When to use

The people who use the app already have a company account at an OpenID
Connect provider — Google Workspace, Microsoft Entra ID, Okta, Keycloak,
Auth0 — and should sign in with it instead of an e-mailed code. `oidc` is a
sign-in provider of the `auth` module: `auth` still decides WHO gets in (the
allowlist, `adminEmails`), keeps users, roles and sessions; `oidc` only
proves the identity. Without a company IdP, keep the e-mail code
(`skill_info('auth')`). The module has no config of its own: everything
goes into the auth config under `providers.oidc`.

## 2. Minimal working code

1. Turn the provider on in the AUTH config (the owner confirms: the answer
   has `confirm_url` — give it to the user):

```json
{ "app_id": "…", "module": "auth", "config": {
  "allow": { "domains": ["acme.com"] },
  "providers": { "oidc": { "enabled": true,
    "issuer": "https://login.microsoftonline.com/0f1e2d3c-aaaa-bbbb-cccc-123456789abc/v2.0",
    "clientId": "6f1c2a8e-1111-2222-3333-444455556666", "label": "Acme" } } } }
```

2. The owner registers the redirect URI
   `https://<dashboard host>/__drobek/auth/callback/oidc` at the IdP (the
   dashboard's host, not the app's; the same for every app of the server)
   and pastes the client secret into the dashboard as the auth module's
   secret `OIDC_CLIENT_SECRET`. Never ask for the secret in chat.
3. The app shows the button: `<LoginGate>` adds "Continue with <label>"
   for every enabled provider by itself:

```tsx
// src/main.tsx
import { createRoot } from 'react-dom/client';
import { LoginGate } from 'drobek/auth';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <LoginGate title="Acme handbook">
    {(user) => (
      <main>
        <h1>Acme handbook</h1>
        <p>Signed in as {user.email}</p>
      </main>
    )}
  </LoginGate>
);
```

A button of your own leaves the page for the IdP and comes back signed in:

```tsx
// src/SignIn.tsx
import { drobek } from 'drobek';

export function SignIn() {
  const start = () => drobek.auth.signIn('oidc', { returnTo: '/' }).catch((e: unknown) => alert(e instanceof Error ? e.message : 'Sign-in failed'));
  return <button onClick={start}>Sign in with your Acme account</button>;
}
```

To offer the company account only, add `"emailCode": { "enabled": false }`
next to `oidc` in `providers`.

## 3. API and types

No SDK of its own: `drobek.auth.signIn('oidc', { returnTo? })`,
`drobek.auth.providers()` and `<LoginGate>` (`skill_info('auth')`).
`auth.providers.oidc` takes:

| field | default | meaning |
|---|---|---|
| `enabled` | `false` | on/off (turning it on waits for the owner) |
| `issuer` | the server's `AUTH_OIDC_ISSUER` | https URL, EXACTLY the `issuer` of `<issuer>/.well-known/openid-configuration` |
| `clientId` | `AUTH_OIDC_CLIENT_ID` (only with the server's issuer) | the client (application) ID at the IdP |
| `scopes` | `["openid","email","profile"]` | must include `openid` |
| `trustEmail` | `false` | treat every address as verified |
| `label` | `"Company account"` | the button reads "Continue with <label>" |
| `claims.email` | `"email"` | the claim with the address (`preferred_username`, `upn`) |
| `prompt` | — | `select_account` (account chooser), `login` or `consent` |
| `relinkByEmail` | `false` | issuer migration (see `skill_info('auth')`) |

Issuers: Google `https://accounts.google.com`; Microsoft
`https://login.microsoftonline.com/<tenant id>/v2.0`; Okta
`https://<org>.okta.com` (or its authorization server); Keycloak
`https://<host>/realms/<realm>`; Auth0 `https://<tenant>.auth0.com/` (with
the trailing slash).

`get_app` → `modules.auth.secrets` shows `OIDC_CLIENT_SECRET` with
`hasSecret`; `modules.auth.info.providers` lists the server's
`AUTH_OIDC_*` variables that are set (`serverEnv`, names only) — with
`AUTH_OIDC_ISSUER` there the operator runs one IdP for every app and the app
may leave `issuer`, `clientId` and the secret out.

## 4. Rules and limits

- Microsoft Entra ID: use the TENANT-SPECIFIC issuer. A multi-tenant
  `/common` or `/organizations` issuer never matches the discovery document
  and every sign-in fails. Entra sends no `email_verified`: set
  `trustEmail: true` (the tenant owns the addresses), and
  `claims.email: "preferred_username"` when `email` is empty.
- The allowlist still decides: add the company domain to `allow.domains`
  (or `allow.anyone`). An unverified address is refused unless `trustEmail`.
- Changing `issuer`, `clientId`, `trustEmail` or `claims` while on waits for
  the owner and signs the provider's users out; a new issuer is a new identity (`account_linked`
  until the owner confirms `relinkByEmail`).
- The flow: authorization code + PKCE S256, `state` and `nonce` by `auth`;
  the ID token must be RS256, ES256 or PS256 (never `none` or HS*), signed
  by the IdP's published keys, for this client (`aud`, `azp`), unexpired,
  `iat` within 5 minutes, the right `nonce`. The address comes from the ID
  token, else from userinfo.
- The IdP must be public https (port 443 or `PROXY_ALLOWED_PORTS`); only the
  operator's `AUTH_OIDC_ISSUER` may be on a private network. Calls time out
  after 5 s and read at most 64 KiB; redirects are not followed.
- `OIDC_DISCOVERY_CACHE_SEC` 3600: the discovery document is cached this
  long (keys 1 hour; an unknown key id refetches them at most once a
  minute), so a change at the IdP can take that long to show.

## 5. Errors → fix

The app only ever sees `auth`'s codes; the reason is in the server log.

| error | cause | fix |
|---|---|---|
| `provider_error` (502) | any oidc failure below | read the cause with the owner; retry after the fix |
| `oidc_discovery_failed` | no issuer/clientId, discovery unreachable, `issuer` mismatch (e.g. Entra `/common`), no PKCE S256, no client secret, keys unreachable | fix `issuer` to the discovery document's value; owner sets `OIDC_CLIENT_SECRET` |
| `oidc_token_invalid` | user cancelled, wrong secret or redirect URI, ID token failed a check, no address | register `…/__drobek/auth/callback/oidc`; owner re-enters the secret; set `claims.email` |
| `email_not_verified` | the IdP did not verify the address | verify at the IdP, or `trustEmail: true` for a company IdP |
| `email_not_allowed` | the address is not in the allowlist | add the domain to `allow.domains` |
| `provider_not_enabled` (404) | `signIn('oidc')` while it is off or not confirmed | enable it; the owner confirms `confirm_url` |
| `invalid_params` | configure_module: bad issuer (not https, a query), scopes without `openid` | read `issues[].path` |
