# Research: Static deploy pipeline, MCP file transfer, DB-backed serving

> Prior-art research (2026-06-30). Conclusions adopted: presigned out-of-band upload, content-hash manifest dedup, pg-boss job, content-hash blob rows, atomic pointer activation; serving from DB is fine for small text apps with caching.

## Prior art

**Ingest APIs (all converge):**
- **Netlify** — POST a file digest (`{path: sha}`); API replies with the subset it lacks; upload only those. Large deploys go async (`preparing → prepared → uploading → ready`). **Atomic**.
- **Cloudflare Pages/Workers** — upload a manifest (`path → hash`); hash is the content-addressed key, so unchanged files never re-upload. Completion returns a short-lived JWT to **activate**.
- **Vercel** — upload files keyed by SHA1; create a deployment referencing files by SHA.
- **Takeaways:** content-hash manifest, upload-only-missing, atomic activation, immutable deploys (rollback = repoint a pointer).

**MCP file transfer** — inline base64 works but burns tokens fast (~1 MB embedded-resource / ~8k-token practical limits). Robust pattern: a tool returns a **presigned/one-time upload URL**; the client POSTs bytes **out-of-band** so the LLM never streams the file through context.

**Job queues** — BullMQ (needs Redis), **pg-boss** (Postgres-only, `SKIP LOCKED`, ACID, no extra infra), Graphile Worker (Postgres, high throughput).

**Serving from DB** — Postgres binary reads ~10× slower than filesystem; JSONB/BYTEA hit a TOAST cliff past ~2 KB and pull whole values into memory; 1 GB column ceiling.

## Proposed deploy pipeline

**Files over MCP (recommended):** two-tool presigned out-of-band flow.
1. `deploy_init({workspace, slug, manifest:[{path, sha256, bytes}]})` → diff vs stored blobs → return `{deployId, uploads:[{path, putUrl}]}` for **missing files only**.
2. Client PUTs each file's raw bytes directly — not through MCP context. Tiny text (<~32 KB) may inline as a fallback.
3. `deploy_commit({deployId})` enqueues the async job.

Avoid "one base64 blob per file per tool call" — the token-cost trap.

**Job (pg-boss):** assemble manifest → lint (htmlhint/eslint/stylelint, **no browser**) → reject on hard errors → write a `deploys` row + store bytes → flip the workspace/slug **active pointer** in one transaction.

**Where bytes live:** hybrid. Text (HTML/CSS/JS) → Postgres is acceptable for tiny apps, stored as **individual rows keyed by content-hash** (`blobs(sha256 PK, content_type, bytes)`), not one fat JSONB doc — dedups across deploys, dodges the JSONB cliff. Binaries/images → filesystem/object storage; DB keeps only `{path → sha256}`.

**Atomic activation + rollback:** `apps(workspace, slug, active_deploy_id)`. Activation = update one FK; rollback = repoint. Old blobs immutable; GC unreferenced later.

## Proposed serving model

`/<ws>/app/<slug>/*` → `active_deploy_id` → manifest path → blob by hash. **In-memory LRU** keyed by `sha256` (content-addressed = never stale); `ETag: "<sha256>"` + `Cache-Control: ...immutable` for hashed assets; `no-cache` + revalidate for entry HTML. CDN/nginx micro-cache later.

**DB-as-store verdict:** fine for small text-heavy apps with content-hash blob rows + caching. Becomes a mistake the moment apps carry real images/video — push those to filesystem/object storage, keep metadata in Postgres.

## Gotchas

- **Untrusted JS on your origin = the big one.** Path-based serving on the drobek origin lets app JS read drobek cookies/storage and call your APIs. Mitigate (hardened same-origin) or serve from a **separate origin**; strict CSP; fixed `path→content_type` map (never sniff) + `X-Content-Type-Options: nosniff`.
- **Payload limits** — manifest dedup, cap per-deploy size, reject oversized at `deploy_init`.
- **Cache invalidation** — content-hash URLs self-invalidate; only the mutable entry pointer needs revalidation; purge CDN for the slug root on activation.
- **Status** — an MCP `deploy_status` tool polling pg-boss state closes the loop for the agent.
