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
  email, files and a secret-injecting proxy. A module is platform code the
  operator enables with `DROBEK_MODULES` (routes under `/__drobek/v1/<name>`,
  `drobek.<name>` in the browser SDK, a per-app config, a skill for the agent);
  the contract is [`docs/MODULES.md`](./docs/MODULES.md). Built in
  (`modules/`, enable with `DROBEK_MODULES=auth,email,forms`):
  - **`auth`** — the people who use an app sign in with an e-mailed 6-digit
    code: an allowlist of addresses and domains, admins, a React
    `<LoginGate>`, host-only 30-day sessions the owner can revoke at once.
  - **`email`** — `drobek.email.notifyAdmins()` e-mails the app's owners; the
    app's sender name, reply-to and daily mail limit. Apps can never e-mail an
    arbitrary address; an operator-wide hourly cap pauses all module mail.
  - **`forms`** — a React `<Form name="contact">` (or
    `drobek.forms.submit()`): submissions stored and e-mailed to the owners,
    with a honeypot, a time token and per-visitor limits; admins list and
    export them as CSV. Requires `email`.

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
3. The agent now has nine tools: `list_apps` (your workspaces + apps),
   `create_app` (an app with a compiling v1 from the `react-ts` or `html`
   template, plus a briefing of the rules and the available skills),
   `get_app`, `read_file`, `write_files` (1–20 changes → one new version,
   compiled on the server; the compile errors come straight back),
   `restore_version`, `skill_info` (how to use a backend: the skills of the
   enabled modules), `configure_module` (an app's module config; risky changes
   wait for your confirmation in the dashboard, and secrets are never set
   through the agent) and `publish` (scope `publish`; only when you ask it to
   go live). After each successful
   compile it hands you the `preview_url`. One agent writes an app at a time
   (a 3-minute lease). Browse the apps, their version history and publish a
   version under `/workspaces/<slug>/apps`.

The agent-facing contract is served at `/llms.txt` and `/llms-full.txt`, and
`/build-with-your-agent` shows the setup. To teach your agent the build loop,
install the skill from this repo (`cp -r skills/drobek ~/.claude/skills/drobek`)
or, for the hosted drobek at `https://drobek.app/mcp`, the
[drobek plugin](https://github.com/freema/drobek-plugin) for Claude Code, Codex
and Cursor (MCP server + `build-app-on-drobek` skill + `/drobek:build-app`):
`claude plugin marketplace add freema/drobek-plugin` then
`claude plugin install drobek@drobek`.

### Opening apps locally

Every app is served on its own origin, never by the dashboard. Locally
`APPS_DOMAIN=apps.localhost:3041`, and browsers resolve every `*.localhost`
name to your machine, so there is nothing to add to `/etc/hosts`:

| Host | Serves |
| --- | --- |
| `http://<slug>--preview.apps.localhost:3041` | the newest version that compiled (the working copy) |
| `http://<slug>.apps.localhost:3041` | the published version (a "not published yet" page until the first publish) |
| `http://<slug>--v<N>.apps.localhost:3041` | exactly version N (404 when it does not exist or did not compile) |

Only the compiled output and plain assets are served — `*.ts`/`*.tsx`/`*.jsx`
sources and `drobek.json` never are; any other path without a file falls back
to `index.html` (client-side routing). Preview and version hosts send
`X-Robots-Tag: noindex`; every app response carries the app CSP,
`frame-ancestors 'none'` (per-app override: `apps.frame_ancestors`),
`Referrer-Policy: no-referrer` and `nosniff`. A `password` app shows a password
form and remembers the unlock in a host-only `__Host-drobek_app_access` cookie
(its key is derived from `DROBEK_MASTER_KEY`).

From a terminal, send the app host in the `Host` header — curl and Node do not
resolve `*.localhost` on every system:

```sh
curl -i -H 'Host: <slug>--preview.apps.localhost:3041' http://127.0.0.1:3041/
```

The dashboard session cookie is `__Host-drobek_session` (host-only, `Secure`)
in production and on any https origin. Browsers refuse `__Host-` cookies on
plain `http://localhost`, so the http dev stack (NODE_ENV ≠ production) uses
the unprefixed, still host-only `drobek_session` / `drobek_app_access` instead.

For scripts and tests without an OAuth flow, create a personal `drk_…` API
key in the dashboard at `/me/api-keys` (shown once; revocation is immediate)
or with `task api-key:create EMAIL=you@example.com NAME=laptop
SCOPES=read,write` on the local stack; send it as `Authorization: Bearer drk_…`
to `/mcp`. `/me/connections` lists the OAuth clients you approved and revokes
them (access + refresh tokens).

**Production / TLS:** `docker-compose.production.yaml` runs drobek behind
Caddy (dashboard + wildcard `*.<APPS_DOMAIN>`: your own wildcard cert, DNS-01
with a Caddy DNS module, or on-demand per host behind an `ask` guard). The
Caddyfile is generated from `.env` by `task caddy:config`; `task dev:tls` runs
the dev stack on `https://localhost` / `https://<slug>--preview.apps.localhost`
with Caddy's local CA. See [`docs/SELF-HOSTING.md`](./docs/SELF-HOSTING.md).

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
task e2e:image    # what CI runs: the prod image behind Caddy + the whole suite
task e2e:smoke    # @smoke specs only (safe against any target, prod included)
task api-key:create EMAIL=… NAME=… SCOPES=read,write  # print a drk_ API key once (local stack)
task dev:tls      # dev stack behind Caddy (tls internal) on https://localhost; task dev:tls:down to leave
task caddy:config # generate deployments/Caddyfile from .env (production TLS)
task tls:reload   # make the running Caddy re-read its config + certificate files
task db:generate  # drizzle-kit generate (journal __drizzle_migrations_core)
task db:migrate   # apply core migrations manually
task down         # docker compose down
```

### End-to-end tests

`tests-e2e` is one Playwright suite with two tiers:

- **`@local`** — needs a local stack: seeds and reads Postgres / Redis /
  Mailpit directly. `global-setup.ts` TRUNCATEs the core tables first, but only
  with `ALLOW_DESTRUCTIVE=1` AND a `DATABASE_URL` host on its allow-list
  (`localhost`, `127.0.0.1`, `postgres`).
- **`@smoke`** — public HTTP + MCP only, safe against production: never the
  database, Redis or Mailpit. The MCP smoke loop (`mcp-loop.spec.ts`) signs in
  with a `drk_` key from `SMOKE_API_KEY` (read from the environment only), and
  creates, writes, previews and publishes one `smoke-<random>` app (there is no
  public app deletion yet, so each run leaves that one app behind):

  ```sh
  BASE_URL_WEB=https://drobek.app SMOKE_API_KEY=drk_… task e2e:smoke
  ```

  Without the key it is skipped on a localhost target and fails anywhere else;
  under `task e2e` it mints a throwaway key in the local DB.

`mcp-loop.spec.ts` is the agent loop end to end: the official MCP SDK client
with an OAuth provider (401 → discovery → DCR → PKCE consent driven by
Playwright → token), then `list_apps` → `create_app` → `write_files` (compile
error → fix) → preview host → `publish` → production host → `restore_version`
→ `get_app`, asserted under 90 s.

`task e2e` runs against the dev stack (`task up`). **`task e2e:image`** is the
CI flow (`.github/workflows/ci.yml` runs the same `scripts/e2e-image.sh`):
build the production image, start it with `docker-compose.e2e.yaml` (project
`drobek-e2e`, its own loopback ports, so it runs next to the dev stack) behind
Caddy with `tls internal` on `https://localhost:8443` and
`https://<slug>--preview.apps.localhost:8443`, let it migrate a fresh DB, then
run `@smoke` + `@local` and tear everything down. `DROBEK_IMAGE=…` skips the
build, `E2E_KEEP=1` keeps the stack, extra args go to Playwright
(`task e2e:image -- tests/mcp-loop.spec.ts`).

`/api/version` returns the git sha `task dev` bakes in via `GIT_SHA`
(fallback `dev`). Monorepo layout: `apps/server` +
`packages/{db,core,compile,apps,audit,auth,tenancy,mcp,oauth,data,proxy,insights,serving,dashboard,agent-dx,sdk}` +
`tests-e2e` (pnpm workspace). Architecture and the ratified D1–D5 decisions:
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## License

[AGPL-3.0](./LICENSE).
