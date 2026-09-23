# drobek

> An open-source cloud workspace for agent-built web apps. Your own agent
> (Claude Code, Cursor, …) connects over MCP and works **directly in drobek** —
> every write is compiled on the server, versioned, previewable and
> publishable — with backend capabilities only through TypeScript platform
> modules and a dashboard for the humans.

**Status:** 🌱 Early — the cloud-workspace rebuild is in progress on `next`.

---

## Why

People inside companies constantly need **tiny apps**: an internal dashboard,
a form, a calculator, a demo for a client. An AI agent writes one in minutes —
and then it has nowhere to live. Localhost disappears, a ZIP in Slack never
runs, "real" hosting needs a repo, a build and an account.

drobek gives the agent a place to work instead of a place to upload to: the
files live in drobek, drobek compiles them (esbuild, in-process — **the server
never executes app code**), keeps every change as an immutable version, and
serves the result. Secrets never pass through the agent: they are set by the
app owner in the dashboard.

## Core concepts

- **Workspace** — people with roles (workspace-admin / editor / viewer).
- **App** — a globally unique slug (`<slug>.<APPS_DOMAIN>`), owned by a workspace.
- **Version** — an immutable snapshot of the app's files, numbered per app.
  Publishing moves one pointer; publishing an older version is the rollback.
- **Modules** — the only backend an app gets: data collections, auth, forms,
  email, files and a secret-injecting proxy, configured in the dashboard.

The full plan is [`docs/vision-plan.md`](./docs/vision-plan.md).

## Self-host quickstart

The whole stack builds **from source** and runs with one command — clone,
copy the env, `docker compose up`, and you have a working drobek: email
sign-in, workspaces, the MCP OAuth server, app versions,
and the dashboard.

Prereqs: **Docker** (compose v2). [go-task](https://taskfile.dev) 3 + Node 22 +
pnpm 10 are only needed for the host-side `task check` / `task e2e` — not to run
the stack.

```sh
git clone https://github.com/freema/drobek && cd drobek
cp .env.example .env
# Two edits make it yours (the rest have working dev defaults):
#   1. SUPERADMIN_EMAIL  → the email you'll sign in with (becomes super-admin)
#   2. DROBEK_MASTER_KEY → a real key:  openssl rand -hex 32
docker compose up -d --build     # or: task dev  (waits until healthy)
```

drobek is **one Node process** (`apps/server`: Express + React Router 7 SSR +
the OAuth 2.1 AS + the MCP Resource Server at `/mcp`), shipped as one image
(`ghcr.io/freema/drobek`). It **applies the core Drizzle migrations itself on
start** (journal `__drizzle_migrations_core`) and **refuses to start** while a
secret still holds a `change-me…` placeholder. Next to it:

| Service | Host port | In-container | Check |
| ------- | --------- | ------------ | ----- |
| drobek (dashboard + OAuth AS + MCP `/mcp`) | [3041](http://localhost:3041) | 3000 | `GET /healthz` → `{ok,db,redis}`, 503 when a dependency is down; `GET /health` → `{ok:true}` |
| postgres 17 | 5441 | 5432 | `pg_isready` |
| redis 7 | 6391 | 6379 | `redis-cli ping` |
| mailpit (dev SMTP sink) | [8025](http://localhost:8025) | 1025/8025 | `/mailpit readyz` |

**Connect your agent:**

1. Open [localhost:3041](http://localhost:3041) and sign in with your email.
   The dev stack sends the login code to the **mailpit** sink — read it at
   [localhost:8025](http://localhost:8025) (production wires real SMTP instead).
2. Point an MCP client (e.g. Claude Code) at `http://localhost:3041/mcp`. It
   discovers the drobek OAuth Authorization Server (identifying itself with a
   Client ID Metadata Document URL or by Dynamic Client Registration), you
   approve the consent screen in your browser — three checkboxes: `read`,
   `write`, `publish` — and it receives a token bound to **you**, not to one
   workspace: it reaches every workspace you are a member of, with your role
   in each.
3. The agent now has six tools: `list_apps` (your workspaces + apps),
   `create_app` (an app with a compiling v1 from the `react-ts` or `html`
   template, plus a briefing of the rules), `get_app`, `read_file`,
   `write_files` (1–20 changes → one new version, compiled on the server; the
   compile errors come straight back) and `restore_version`. After each
   successful compile it hands you the `preview_url` —
   `http://<slug>--preview.apps.localhost:3041` locally,
   `https://<slug>--preview.<APPS_DOMAIN>` in production (serving those hosts
   lands in the next unit). One agent writes an app at a time (a 3-minute
   lease). Browse the apps, their version history and publish a version under
   `/workspaces/<slug>/apps`.

For scripts and tests without an OAuth flow, `task api-key:create
EMAIL=you@example.com NAME=laptop SCOPES=read,write` prints a personal `drk_…`
API key once (for an existing user of the local stack); send it as
`Authorization: Bearer drk_…` to `/mcp`.

`docker compose down -v` wipes the volumes (postgres, redis) for a clean
start; `docker compose down` keeps your data.

Everyday commands:

```sh
task dev          # build + start the stack, wait until healthy
task health       # curl the health endpoints
task logs         # tail the drobek service
task check        # host-side: build packages, typecheck, lint, unit tests
task build        # build the production image ghcr.io/freema/drobek:<sha>
task prod:proof   # build + prove the prod image (size, non-root, fail-closed, live boot)
task e2e          # Playwright suite (incl. @local specs) vs the stack
task e2e:smoke    # read-only @smoke specs only (safe against any target)
task api-key:create EMAIL=… NAME=… SCOPES=read,write  # print a drk_ API key once (local stack)
task db:generate  # drizzle-kit generate (journal __drizzle_migrations_core)
task db:migrate   # apply core migrations manually
task down         # docker compose down
```

`/api/version` returns the git sha `task dev` bakes in via `GIT_SHA`
(fallback `dev`). Monorepo layout: `apps/server` +
`packages/{db,core,compile,apps,audit,auth,tenancy,mcp,oauth,data,proxy,insights,serving,dashboard,agent-dx,sdk}` +
`tests-e2e` (pnpm workspace). Architecture and the ratified D1–D5 decisions:
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## License

[AGPL-3.0](./LICENSE).
