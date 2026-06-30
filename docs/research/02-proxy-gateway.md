# Research: API Proxy / Gateway (Variant 2)

> Prior-art research (2026-06-30) informing drobek's proxy. Conclusion adopted: **minimal viable BFF proxy** with admin-registered upstreams, envelope-encrypted secrets, SSRF-guarded.

## Prior art

- **Vercel rewrites + proxy/edge middleware** — turn the platform into a reverse proxy to external origins; secrets from env vars; newer `proxy.ts` attaches keys the browser never sees. Closest analogue to drobek's "registered upstream + injected key".
- **Cloudflare Workers + API Shield** — Worker between browser and API adds the secret header, forwards, re-adds CORS. API Shield adds schema validation, mTLS, abuse controls.
- **Kong** — `request-transformer` adds headers; per-consumer plugins inject credentials/signed JWTs. Authenticate inbound caller → inject upstream credential.
- **Tyk** — OSS self-hostable Go gateway; per-API header injection + rate limiting/quotas. Good self-host reference.
- **Zuplo** — composable policies (auth, OpenAPI validation, CORS, rate limit, transforms). Policy-pipeline model worth emulating.
- **Hasura Actions / Remote Schemas** — declarative upstream + header-injection config with precedence.
- **BFF / Token-Handler (Curity, Duende, Auth0)** — server-side confidential client holds tokens; browser gets an HttpOnly cookie session. **This is drobek's governance thesis exactly: frontend never holds credentials.**

## Design for drobek's proxy (Node/Remix)

**Route** — resource route `routes/$workspace.api.proxy.$name.$.tsx` (splat captures sub-paths). `loader` = GET/HEAD, `action` = POST/PUT/PATCH/DELETE.

**Config & storage** — `upstreams(id, workspace_id, name, base_url, allowed_methods, allowed_path_prefixes, auth_type, rate_limit, allowed_app_ids[])`. Secrets in `upstream_secrets`, **envelope-encrypted**: random AES-256-GCM DEK per secret, DEK wrapped by a master KEK from env/KMS; store `ciphertext + iv + authTag + wrappedDEK`. Decrypt in-memory only.

**Auth injection** — server-side switch on `auth_type`: `bearer`/`header`/`basic`/`hmac`.

**Scoping/authz** — resolve workspace from path, verify calling app ∈ workspace + `allowed_app_ids`, authenticate caller via app session/token, enforce method + path-prefix allowlist before any outbound call.

**CORS** — drobek owns CORS; reflect only registered app origins; handle preflight. Upstream CORS irrelevant.

**Rate limiting** — token-bucket keyed on `(workspace, app, upstream)`; `429` + `Retry-After`.

```
browser app ──fetch /ws/api/proxy/crm/contacts──▶ drobek route
  ├ authn caller + authz (app∈ws, app∈allowlist)
  ├ validate method + path prefix; rate-limit
  ├ load upstream cfg; decrypt secret (envelope)
  ├ build outbound req: base_url + path, inject auth
  ├ SSRF guard (allowlist host) ──▶ upstream API
  └ stream response back + CORS headers ──▶ browser
```

## Recommendation & MVP

Ship a **minimal viable proxy**: per-workspace upstream registration (fixed `base_url`, admin-only — no user-entered URL at request time), `bearer`/`header` auth, envelope-encrypted secrets, method+path allowlist, app-scoped authz, CORS, Postgres token-bucket. Defer HMAC, OpenAPI validation, response caching, Redis limits.

## Gotchas

- **SSRF** (biggest): pin `base_url` at registration (admin-only), allowlist hostnames, **resolve DNS once and connect to that IP**, block private/link-local/metadata ranges, **do not follow redirects**.
- **Secret leakage** — never log injected headers or upstream error bodies; decrypt only in-memory; rotate KEK.
- **Streaming/large bodies** — stream, cap body size.
- **Timeouts** — connect + total timeouts via `AbortController`; cap concurrent upstream calls per workspace.
