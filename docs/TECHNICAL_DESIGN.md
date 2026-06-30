# drobek — Technical design & contracts

> Concrete data model, API/MCP contracts, and key sequences. Draft 2026-06-30. Pairs with `ARCHITECTURE.md`. Shapes are indicative, not final.

## 1. Data model (Postgres, via Drizzle)

```sql
-- Identity (ported from puls-mcp)
users(id pk, email unique, google_sub null, created_at)
sessions(token pk, user_id fk, expires_at)                      -- HttpOnly drobek session
oauth_clients(id pk, redirect_uris[], ...)                      -- MCP DCR
oauth_authorization_codes(code pk, client_id, user_id, pkce_challenge, scope, expires_at)
oauth_access_tokens(token pk, user_id, client_id, scope, audience, expires_at)

-- Tenancy
workspaces(id pk, kind 'personal'|'team', slug unique, name, created_at)
memberships(user_id fk, workspace_id fk, role 'super-admin'|'workspace-admin'|'editor'|'viewer', pk(user,ws))

-- Apps & deploys
apps(id pk, workspace_id fk, slug, active_deploy_id null, routing_mode 'spa'|'exact',
     visibility 'public'|'team'|'password', password_hash null, status 'live'|'hibernated',
     uses_end_user_auth bool, created_at, unique(workspace_id, slug))
deploys(id pk, app_id fk, manifest jsonb, lint_report jsonb, created_at)   -- immutable
blobs(sha256 pk, content_type, bytes bytea)                                -- content-addressed
deploy_files(deploy_id fk, path, sha256 fk, pk(deploy_id, path))           -- manifest expanded

-- Data API
collections(id pk, app_id fk, name, json_schema jsonb,
            access_mode 'public-read'|'public-write'|'locked'|'owner-only', unique(app_id, name))
app_documents(id pk, app_id fk, collection, owner_end_user_id null, doc jsonb,
              created_at, updated_at, index(app_id, collection))

-- Hosted-app end-users (workspace-scoped; SSO)
workspace_end_users(id pk, workspace_id fk, email, provider 'email'|'google'|'github', created_at,
                    unique(workspace_id, email))
workspace_end_user_sessions(token pk, workspace_id fk, end_user_id fk, expires_at)  -- HttpOnly on apps-origin

-- Proxy
upstreams(id pk, workspace_id fk, name, base_url, allowed_methods[], allowed_path_prefixes[],
          auth_type 'none'|'bearer'|'header'|'basic', allowed_app_ids[], unique(workspace_id, name))
upstream_secrets(upstream_id pk fk, ciphertext, iv, auth_tag, wrapped_dek)  -- AES-256-GCM, KEK=DROBEK_MASTER_KEY

-- Ops
app_metrics(app_id fk, day date, visits int, ..., pk(app_id, day))         -- cheap counters, no PII
audit_log(id pk, workspace_id fk, actor_user_id, action, target, meta jsonb, created_at)  -- append-only
```

## 2. MCP tool contracts (M1)

Auth: every call carries `Authorization: Bearer <oauth_access_token>`; server checks `role + scope + workspace`.

```
deploy_init({ workspace?, slug?, name?, manifest: [{path, sha256, bytes}] })
  -> { deployId, app: {workspace, slug, url}, uploads: [{path, putUrl, expiresAt}] }   // missing files only

deploy_commit({ deployId })            -> { jobId, status: 'queued' }
deploy_status({ deployId })            -> { status: 'queued'|'linting'|'storing'|'ready'|'failed',
                                            url?, lint: {errors[], warnings[]}, progress? }
list_apps({ workspace? })              -> { apps: [{slug, url, status, lastDeployAt}] }

collection_define({ workspace, slug, name, jsonSchema, accessMode })  -> { ok, collection }
record_create({ ...locator, collection, doc })   -> { id, doc }
record_read({ ...locator, collection, id })       -> { doc }
record_update({ ...locator, collection, id, patch }) -> { doc }
record_delete({ ...locator, collection, id })     -> { ok }
record_query({ ...locator, collection, where?, sort?, limit?, cursor? }) -> { items[], nextCursor? }
```
Errors are **actionable** (for the agent): `{ error: { code, message, fix? } }` (feeds the feedback loop).

## 3. REST contracts (runtime, called by the hosted app / SDK)

```
# Data (under the app's origin)
GET    /<ws>/app/<slug>/data/<collection>?where=field:val&sort=-created_at&limit=50
POST   /<ws>/app/<slug>/data/<collection>            { ...doc }
GET    /<ws>/app/<slug>/data/<collection>/<id>
PATCH  /<ws>/app/<slug>/data/<collection>/<id>       { ...patch }
DELETE /<ws>/app/<slug>/data/<collection>/<id>
  - access enforced by collection.access_mode; owner-only → server derives owner from end-user session
  - mutations require CSRF token (double-submit) + Origin check; SameSite cookie

# End-user auth (apps-origin)
POST   /__drobek/auth/email/start     { email }          -> sends code
POST   /__drobek/auth/email/verify    { email, code }    -> Set-Cookie (HttpOnly)
GET    /__drobek/auth/google|github                       -> OAuth redirect
GET    /__drobek/auth/me                                   -> { endUser | null }
POST   /__drobek/auth/logout

# Proxy
ANY    /<ws>/api/proxy/<name>/<path...>   -> forwarded to upstream with injected auth

# SDK
GET    /sdk@1.js                                           -> versioned, immutable-cached
```

## 4. MCP OAuth (connect) sequence

```
client → MCP (no token)            ⇒ 401 + WWW-Authenticate
client → /.well-known/oauth-protected-resource   ⇒ { authorization_servers }
client → /.well-known/oauth-authorization-server ⇒ endpoints + code_challenge_methods=[S256]
client → /oauth/register (DCR)     ⇒ { client_id }
browser → /oauth/authorize (PKCE)  ⇒ drobek login (email/Google) + consent ⇒ code
client → /oauth/token (code+verifier, resource=<mcp-uri>) ⇒ access_token (aud-bound)
client → MCP (Bearer)              ⇒ 200
```

## 5. Deploy job (worker)

```
on deploy_commit:
  validate manifest complete (all blobs present)  → else fail(missing)
  lint(html/css/js)  → hard errors? fail(lint, actionable)  : collect warnings
  upsert blobs(sha256) ; insert deploy_files
  in txn: insert deploy ; update apps.active_deploy_id = deploy.id
  publish progress to redis ch:deploy:<id>  (SSE → dashboard + deploy_status)
```

## 6. Serving resolution

```
req <host>/<ws>/app/<slug>/<path>  (or <ws>.apps.<host>/<slug>/<path> for auth apps)
  → load app ; visibility gate (public | team-login | password)
  → deploy_files[active_deploy_id][path or SPA-fallback index.html]
  → stream blob ; ETag=sha256 ; immutable for hashed assets ; CSP + nosniff
```

## 7. Open technical questions
Token format for end-user sessions (opaque vs JWT) · blob storage threshold PG↔disk · SDK bundle size budget · rate-limit buckets (Redis) granularity · multi-instance cache invalidation. See Linear gap tickets PHY-74…80.
