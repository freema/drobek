# drobek

> Open-source hosting for **vibecoded micro-projects**. Drop a small HTML/static app and get a live URL in one step — MCP-native.

**Status:** 🌱 Early — we're shaping the concept. Architecture and APIs will change.

---

## The problem

Inside companies, people constantly produce **tiny one-off projects**: an internal dashboard, a landing page, a calculator, a demo for a client, a "can you make me a quick page that shows X". More and more of these are **vibecoded** — generated in minutes with an AI agent.

These projects have nowhere to live:

- **localhost** → disappears when you close the laptop
- **a ZIP in Slack** → nobody runs it
- **"real" hosting** (Vercel/Netlify/S3) → overkill for one HTML file: needs an account, a git repo, a build step, config
- **internal infra** → a ticket to IT, wait a week

So great little things never reach the people who'd use them.

## What drobek does

drobek is **"paste & it's live."** Hand it a folder or an HTML file → get a URL. No build, no config for static projects.

The headline channel is **MCP-native deployment**: the same AI agent that built the project deploys it. *"Deploy this to drobek"* → one tool call → live URL. Zero context switch, no leaving the chat.

## Deploy channels (planned)

- **MCP** — the agent that wrote it ships it (primary)
- **CLI** — `drobek deploy ./my-app`
- **Web drag & drop** — for non-devs
- **API / git push** — for everything else

*(Exact set is still open — see Open questions.)*

## Core concepts

- **Project** — a deployed unit (static bundle or small app); has a name, an owner, a URL.
- **Deploy** — an immutable version of a project (rollback-able).
- **Channel** — how a deploy arrives (MCP / CLI / web / API).
- **Hosting** — drobek serves the project on a subdomain (and, later, custom domains) with TLS.

## Open questions (being decided)

- **Static only, or running backends too?** (static is ~10× simpler; backends need isolation)
- Runtime & serving model (object storage + router? containers per project?)
- Isolation & security for untrusted vibecoded code
- Auth & multi-tenancy
- How a bundle travels over MCP (inline? presigned upload?)
- Subdomain + custom-domain + wildcard TLS model
- Quotas, limits, lifecycle (do stale projects expire?)

## Self-host quickstart

The whole stack builds **from source** and runs with one command — clone,
copy the env, `docker compose up`, and you have a working drobek: email
sign-in, workspaces, the MCP OAuth server, the deploy pipeline, path serving,
and the dashboard.

Prereqs: **Docker** (compose v2). [go-task](https://taskfile.dev) 3 + Node 22 +
pnpm 10 are only needed for the host-side `task check` / `task e2e` — not to run
the stack.

```sh
git clone https://github.com/freema/drobek && cd drobek
cp .env.example .env
# Two edits make it yours (the rest have working dev defaults):
#   1. SUPERADMIN_EMAIL  → the email you'll sign in with (becomes super-admin)
#   2. UPLOAD_SIGNING_SECRET → a real secret:  openssl rand -hex 32
docker compose up -d --build     # or: task up  (waits until healthy)
```

Six services come up, each with a healthcheck; the **web entrypoint applies the
core Drizzle migrations automatically** (journal `__drizzle_migrations_core`,
migrations `0000`→`0002`) before serving:

| Service | Host port | In-container | Check |
| ------- | --------- | ------------ | ----- |
| web (React Router 7 SSR) | [3041](http://localhost:3041) | 3000 | `GET /healthz` → `{ok,db,redis}`, 503 when a dependency is down |
| mcp-server (Express, OAuth 2.1 RS) | [3042](http://localhost:3042) | 3001 | `GET /health` → `{ok:true}` |
| worker (BullMQ deploy consumer) | — | — | `pgrep scripts/worker.mjs` |
| postgres 17 | 5441 | 5432 | `pg_isready` |
| redis 7 | 6391 | 6379 | `redis-cli ping` |
| mailpit (dev SMTP sink) | [8025](http://localhost:8025) | 1025/8025 | `/mailpit readyz` |

**Deploy a static app from your agent (the headline flow):**

1. Open [localhost:3041](http://localhost:3041) and sign in with your email.
   The dev stack sends the login code to the **mailpit** sink — read it at
   [localhost:8025](http://localhost:8025) (production wires real SMTP instead).
2. Point an MCP client (e.g. Claude Code) at `http://localhost:3042/mcp`. It
   discovers the drobek OAuth Authorization Server, you approve the consent
   screen in your browser (choosing the workspace + granting `deploy:write`),
   and it receives a scoped token.
3. Ask the agent to deploy your static app. It calls `deploy_init` → uploads the
   files → `deploy_commit`; the worker lints, stores, and activates the version,
   and the app goes live at `http://localhost:3041/<workspace>/app/<slug>`.
4. Roll back (the `rollback` tool or the dashboard) and browse the deploy
   history + apps list under `/workspaces/<slug>/apps`.

`docker compose down -v` wipes the volumes (postgres, redis, blobs) for a clean
start; `docker compose down` keeps your data.

Everyday commands:

```sh
task health       # curl both health endpoints
task logs         # tail web + mcp
task check        # host-side: build packages, typecheck, lint, unit tests
task e2e          # Playwright suite (incl. @local + the M1a acceptance) vs the stack
task e2e:smoke    # read-only @smoke specs only (safe against any target)
task db:generate  # drizzle-kit generate (journal __drizzle_migrations_core)
task db:migrate   # apply core migrations manually
task stop         # docker compose down
```

The end-to-end M1a acceptance —
[`tests-e2e/tests/m1a-acceptance.spec.ts`](./tests-e2e/tests/m1a-acceptance.spec.ts)
— exercises the whole flow above in one test (login → team → MCP OAuth →
deploy → serve → v2 → rollback → dashboard) and is the canonical proof the
self-hosted stack works.

`/api/version` returns the git sha `task up` bakes in via `GIT_SHA`
(fallback `dev`). Monorepo layout: `apps/{web,mcp-server}` +
`packages/{db,core,auth,tenancy,oauth,deploy,serving,dashboard,sdk}` +
`tests-e2e` (pnpm workspace). Architecture and the ratified D1–D5 decisions:
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## License

[AGPL-3.0](./LICENSE).
