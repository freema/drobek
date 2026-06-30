# Research: Built-in Data API / BaaS for client-side apps

> Prior-art research (2026-06-30) informing drobek's Variant-1 data API. Conclusion adopted: **jsonb document collections behind a thin Remix API**.

## Prior art

- **Supabase** — PostgREST auto-generates a REST/GraphQL API over Postgres tables (schema-first). Client safety rests on **Row-Level Security**: the browser holds a publishable/anon key; RLS policies + user-JWT claims decide row access. Multi-tenant = a `tenant_id` column + RLS, not separate DBs.
- **Firestore** — schemaless JSON documents in collections; client SDKs hit the service directly, gated by declarative **Security Rules**. Closest "client writes directly, rules authorize" match.
- **PocketBase** — single ~15 MB Go binary, SQLite; each collection = a table. **API rules** are per-action filter expressions: `null` = superuser-only, `""` = public, expression = conditional. Lowest-ops reference.
- **Appwrite** — self-hostable; collection- and document-level permissions plus a row-security toggle.
- **Nhost** — open-source self-hostable Hasura: GraphQL auto-API over Postgres, role-based permissions from JWT claims.
- **Cloudflare D1 + KV** — neither is browser-exposed; access only via a Worker binding. Server-proxy pattern.
- **Vercel** — KV/Postgres deprecated June 2025 (→ Neon/Upstash marketplace); Edge Config is read-only for flags.

**Takeaway:** two camps — *direct-to-client + declarative authz* (Supabase/Firestore/PocketBase) vs *server-proxy* (Cloudflare/Vercel). drobek already has a Remix server + OAuth/MCP identity, so a **thin server-proxy with a simple data model** fits best.

## Options for Variant-1

Route under the app: `POST /<workspace>/app/<slug>/data/<collection>`; the loader/action resolves `(workspace, slug)` from the path and scopes every query.

- **(a) jsonb document collections in Postgres** — `app_documents(workspace, slug, collection, id, doc jsonb, ...)`. Firestore-like, schemaless, zero per-app migration. Isolation = composite key + server-injected `WHERE`, backstopped by RLS. GIN-indexable. **Simplest to ship.**
- **(b) Per-app key-value** — trivial, good for settings; too weak for list/query workloads.
- **(c) PostgREST/auto-API over per-app tables/schemas** — powerful but heavy: schema sprawl at thousands of apps, migration tooling, wider attack surface.

**Auth (all cases):** the static client is **untrusted — never trust the path**. Writes carry a token; the server validates it, confirms ownership of `(workspace, slug)`, then injects the tenant predicate. Public reads optionally per-collection.

## Recommendation

**Option (a): jsonb document collections behind a thin Remix API.** Suits self-hostable Node+Postgres (no extra service), Firestore-like ergonomics, authorization in one auditable layer. Add RLS as defense-in-depth.

*Gotchas:* validate/size-cap docs on write (jsonb enforces nothing); index `(workspace,slug,collection)` early + lazy GIN; document→typed-table migration later is a data copy.

## Gotchas

- **CORS** — same-origin under `/<ws>/app/<slug>/…` means no CORS; never `*` with credentials.
- **Abuse/quota** — per-app rate limits, max doc size, docs/collection caps, per-workspace storage quota, short-TTL write tokens.
- **Schema evolution** — optional per-collection JSON-Schema validation; version collections (`collection@v2`).
- **Tenant-leak risk** — one missing `WHERE` leaks every tenant; centralize the filter + RLS backstop + test it.
