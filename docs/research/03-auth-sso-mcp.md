# Research: Auth, SSO, fixed-role RBAC, MCP OAuth

> Prior-art research (2026-06-30). Conclusion adopted: **port the puls-mcp auth module** (hand-rolled, same Remix stack) + add workspaces & fixed roles. (Better Auth evaluated below as the greenfield alternative.)

## Prior art

**Magic-link / email-OTP** — single-use short-TTL hashed code, emailed, verified, mint a session. (puls-mcp already implements this.)

**SSO libraries — self-hostable vs SaaS-locked:**
- **Better Auth** — OSS TypeScript, runs inside your Node process; plugins for `magicLink`, `emailOTP`, OAuth/OIDC client, `organization` (multi-tenant), `admin` (roles), plus `oidc-provider` + `mcp` so your app can *be* an OAuth 2.1 AS. Best greenfield fit.
- **Lucia** — maintenance mode (2025), DIY resource.
- **Auth.js / NextAuth** — works but framework-coupled, weaker as an OIDC *provider*.
- **Ory Kratos + Hydra** — fully OSS, API-first, but two extra services.
- **Keycloak** — OSS, full-featured, but JVM ~2 GB RAM — heavy.
- **WorkOS** — SaaS only, not self-hostable. Fine for the private SaaS side only.

**RBAC** — drobek wants **fixed roles** → a code-level enum + tenant-scoped membership table, not a user-editable roles table. Postgres RLS for workspace isolation.

> **Decision for drobek:** reuse the **puls-mcp** hand-rolled auth (email code + Google OIDC + full OAuth 2.1 AS for MCP), already proven in the same Remix/RR7 + Postgres stack — no Better Auth dependency. Add workspaces + fixed roles.

## MCP auth (spec 2025-11-25)

The MCP server is an **OAuth 2.1 resource server** that validates tokens (drobek co-locates its own authorization server). Flow a client (Claude Code) performs:
1. Call MCP with no token → **401** + `WWW-Authenticate`.
2. Fetch **Protected Resource Metadata** (RFC 9728) `/.well-known/oauth-protected-resource` → `authorization_servers`.
3. Discover AS (RFC 8414 / OIDC) — must advertise `code_challenge_methods_supported`.
4. Get `client_id` via Client ID Metadata Docs / pre-registration / RFC 7591 DCR.
5. **Authorization-code + PKCE (S256)** in browser, with the **`resource` param (RFC 8707)** = MCP server URI.
6. `Authorization: Bearer …` on every request; insufficient scope → **403** → step-up.

**Token → drobek account:** drobek's own AS issues the token after web login, so `sub` = drobek user id; embed `role` + workspace memberships as claims. Scopes (`deploy:write`, `data:write`) gate the action class; the server checks **role + scope + workspace**. Audience-bound to drobek's MCP URI.

## Recommendation

Port puls-mcp's auth. Fixed roles as a TS union, server-enforced; `users` / `workspaces` / `memberships(user, workspace, role)`; no custom-role table. OSS core ships all auth + MCP/OIDC endpoints + schema (self-hostable); private drobek-web adds managed SMTP, click-to-add SSO, SCIM.

## Gotchas

- **Self-host SMTP** — deliverability is the #1 magic-link failure; require SPF/DKIM/DMARC; console transport fallback.
- **OIDC config** — exact redirect URIs; must advertise `code_challenge_methods_supported`; clock skew.
- **Token lifetimes** — short access + rotating refresh; RFC 8707 audience binding; never pass the MCP token to upstream APIs (confused-deputy).
- **Role escalation** — scope authorizes the action class, role+workspace authorizes the object; validate both; gate `super-admin` tightly.

### Sources
- MCP Authorization spec (2025-11-25); Better Auth MCP + OIDC-provider plugins; Lucia status; Ory/Keycloak comparisons; multi-tenant RBAC + Postgres RLS guides.
