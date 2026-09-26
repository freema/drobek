# drobek — developer guide

## Overview

drobek is an open-source (AGPL-3.0) cloud workspace for agent-built web apps:
an agent connects over MCP, writes files, drobek compiles them in-process with
esbuild, keeps every write as a version with a preview host, and publishes on
request. App backends are TypeScript platform modules; a dashboard covers
secrets, confirmations, domains, data and users. One Node process, one image
(`ghcr.io/freema/drobek`), Postgres + Redis (+ Caddy for TLS).
Map: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Hard rules

1. **Node/TypeScript only.** pnpm monorepo, Node 22, ESM. No second language.
2. **Logic lives in `packages/*` or `modules/*`, never only in `apps/server`.**
   The server wires packages together; drobek-web consumes the image, not the
   apps.
3. **The server never executes app code** — not to build, render or test it.
   esbuild runs over an in-memory file map; the output only runs in browsers.
4. **Secrets never pass through MCP or an LLM.** Values are set write-only in
   the dashboard and stored envelope-encrypted; tools return names +
   `hasSecret`. Never log a secret.
5. **`task check` is the gate** (Taskfile, go-task — there is no Makefile).
   It runs `pnpm install`, the doc-lint, build, typecheck, lint, knip and unit tests.
6. **One long-lived branch, `next`.** Commits end with `(NSO-xxx)`; push only
   at milestone end; one MR per milestone.
7. **Migrations:** core migrations live in `packages/db/drizzle/migrations`
   (journal `__drizzle_migrations_core`), each module has its own folder and
   journal (`__drizzle_migrations_mod_<name>`). Numbers are pre-assigned per
   task when work runs in parallel — never pick the next free number
   yourself; after a merge re-chain the snapshot `prevId` and keep the
   journal `when` values ascending (see `docs/progress.md` gotchas).
8. **e2e at block end.** Per task: unit tests + e2e spec files + green
   `task check`. `task e2e` (and the black-box pass) runs once per milestone
   block against the dev stack.
9. **v1 scope only.** No "later" features, no roadmap sections in docs.
10. **Docs describe the current design.** `pnpm doc-lint` (in `task check`
    and CI) refuses retired vocabulary outside `docs/archive/` and
    `CHANGELOG.md`, keeps the README quickstart identical to
    `docs/SELF-HOSTING.md`'s and requires every `.env*.example` key in the
    SELF-HOSTING env reference.
11. **Agent surface in sync.** A change to the MCP tools or the SDK updates the
    `@drobek/agent-dx` manifest, `skills/drobek` and the plugin's skills in the
    same change (drift-guarded by `tool-docs-parity.test.ts` and
    `skill.test.ts`). A new operator env var goes into `.env.example`,
    `.env.production.example` and the SELF-HOSTING env reference.

## Commands

```sh
task dev            # build + start the dev stack (drobek, postgres, redis, mailpit), wait until healthy
task check          # host-side gate: install, doc-lint, build packages + app bundle, typecheck, lint, knip, unit tests
task test           # unit tests only (builds packages first)
task e2e            # Playwright vs the dev stack (@local + @smoke) — block end
task e2e:image      # the CI flow: prod image behind Caddy + the whole suite
task logs / task down / task health
pnpm doc-lint       # the doc-lint alone
pnpm --filter <pkg> test:run   # one package (run `pnpm build:packages` first)
```

Dev URLs: dashboard + MCP `http://localhost:3041` (`/mcp`), apps
`http://<slug>--preview.apps.localhost:3041`, Mailpit `http://localhost:8025`.
Self-host tasks (`selfhost:*`, `backup`, `restore`, `tls:reload`) are in
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md).

## Where things live

```
apps/server/            Express entry: host dispatch, /mcp, React Router, in-process jobs, migrate
packages/apps           apps, slugs, versions, publish/restore, lease, host classification, takedown
packages/compile        in-process esbuild over an in-memory file map
packages/serving        app-host handler, CSP, caches, password gate, TLS ask
packages/modules        module contract, registry, runtime, SDK build, limits provider, end-user sessions
packages/mcp            MCP tool bodies          packages/oauth   OAuth 2.1 AS + MCP RS + API keys
packages/agent-dx       briefing, tool manifest, limits, error catalogue, llms.txt renderers
packages/dashboard      dashboard routes + server halves
packages/{auth,tenancy,audit,domains,email,insights,proxy,core,db,sdk}
packages/skills-check   compiles + typechecks every skill code block (test-only)
modules/<name>          built-in platform modules (auth, email, forms, data, proxy, files) + SKILL.md
skills/                 general skills (start, debug, ui, port-artifact) + the platform skill skills/drobek
examples/               drobek-module-hello (an external module)
tests-e2e/              Playwright (@local needs the dev stack, @smoke is safe anywhere)
tests-eval/             manual agent eval (`task eval`, never CI)
scripts/                self-host scripts, e2e image flow, prod proof, doc-lint
docs/                   ARCHITECTURE, SELF-HOSTING, MODULES, AGENT, SECURITY, LICENSING, progress, vision-plan; archive/ = history
```

## Conventions

- English in code, docs and commits. Errors are `{ code, message, hint }` from
  the catalogue; module routes answer `{ error, message, details? }`.
- DB-backed unit tests use PGlite + `setDbForTests()` from `@drobek/db`.
- DB errors: use `pgErrorCode` / `isUniqueViolation` / `dbErrorForLog` from
  `@drobek/db`; never read `err.code` or log `err.message` of a query error
  (guarded by `packages/db/src/error-guard.test.ts`).
- Every operator-facing limit is an env var with a production default.
- Working memory of the implement loop, gotchas and failed approaches:
  [`docs/progress.md`](docs/progress.md) — read "Notes and gotchas" before
  touching an unfamiliar area, append to it after.
