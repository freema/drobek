# drobek

[![CI](https://github.com/freema/drobek/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/freema/drobek/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/freema/drobek)](https://github.com/freema/drobek/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)
[![Image](https://img.shields.io/badge/image-ghcr.io%2Ffreema%2Fdrobek-2496ed)](https://github.com/freema/drobek/pkgs/container/drobek)

> An open-source cloud workspace for agent-built web apps. Your own agent
> (Claude, Claude Code, Cursor, Codex, …) connects over MCP and works
> **directly in drobek**: every write is compiled on the server, kept as a
> version and previewable at once, and published when you say so. Apps get
> their backend only through TypeScript platform modules — sign-in, data,
> forms, e-mail, file uploads, external APIs — and the humans get a dashboard.

**Status:** [latest release](https://github.com/freema/drobek/releases/latest),
self-hostable (AGPL-3.0); the hosted edition is [drobek.app](https://drobek.app).
Apps built with it: the [gallery](https://www.drobek.app/gallery).

## The loop

1. Connect drobek to your agent (an MCP server with OAuth — you approve it in
   the browser).
2. Ask for an app: *"a shift planner for our warehouse"*. The agent calls
   `create_app` and gets a compiling starter plus a briefing of the rules.
3. It calls `write_files`. drobek compiles the files in-process with esbuild
   and returns the compile errors **in the same response**; the agent fixes
   them and writes again. Every write is an immutable version.
4. Each successful compile is live at once on the app's preview host,
   `https://<slug>--preview.<APPS_DOMAIN>` — the agent hands you the link.
5. When you are happy, the agent calls `publish` and the version goes live on
   `https://<slug>.<APPS_DOMAIN>` (or your own domain). Publishing an older
   version is the rollback.

Why it is built this way:

- **The server never executes app code.** It compiles and serves; the result
  runs only in browsers. No sandbox per app, no `npm install`, no server-side
  code of the agent's.
- **Secrets never pass through the agent.** The app owner sets them in the
  dashboard; modules use them server-side.
- **Every app is its own origin** (`<slug>.<APPS_DOMAIN>`), separate from the
  dashboard's.
- **One process, one image** (`ghcr.io/freema/drobek`) + Postgres + Redis
  (+ Caddy for TLS). It runs on an ordinary small server.

## Core concepts

- **Workspace** — people with roles (workspace-admin / editor / viewer).
- **App** — a globally unique slug, owned by a workspace. Its hosts:
  `<slug>.<APPS_DOMAIN>` (published), `<slug>--preview.<APPS_DOMAIN>` (the
  newest version that compiled), `<slug>--v<N>.<APPS_DOMAIN>` (exactly version
  N), plus verified custom domains.
- **Version** — an immutable, numbered snapshot of the app's sources and
  compiled output. Publishing moves one pointer.
- **Platform modules** — the only backend an app gets: routes under
  `/__drobek/v1/<name>` on the app's host, `drobek.<name>` in the browser SDK,
  a per-app config the agent proposes and the owner confirms when it is risky,
  a skill the agent reads. Built in (`modules/`, enabled with
  `DROBEK_MODULES`):
  - **`auth`** — the app's users sign in with an e-mailed code (allowlist,
    admins, `<LoginGate>`, sessions the owner can revoke);
  - **`data`** — collections of records with per-operation rules
    (`public` / `user` / `owner` / `admin`), JSON Schema, CSV;
  - **`forms`** — `<Form>` submissions stored and e-mailed to the owners, with
    bot protection;
  - **`email`** — notifications to the app's owners (never to arbitrary
    addresses), per-app and server-wide budgets;
  - **`files`** — end-user uploads with types sniffed from the bytes and a
    per-app quota;
  - **`proxy`** — calls to external APIs with the secret injected
    server-side, behind an SSRF guard.

  Operators can add their own modules against the public contract:
  `npm create drobek-module@latest <name>` scaffolds one against the npm
  packages `@drobek/modules` + `@drobek/sdk` —
  [`docs/MODULES.md` → Writing a module](./docs/MODULES.md#writing-a-module).

## Self-host quickstart

<!-- quickstart:start -->
What you need:

- a server with a public IPv4 (and/or IPv6), **linux/amd64** (there is no ARM
  image in v1), ports **80** and **443** reachable from the internet;
- a domain for the dashboard and a domain for the apps. Create these DNS
  records **before** step 3 (Let's Encrypt checks them):

  | Record | Points at | Example |
  | --- | --- | --- |
  | `A` (and/or `AAAA`) for the dashboard host | the server | `drobek.example.com` |
  | wildcard `A`/`AAAA` `*.<APPS_DOMAIN>` | the server | `*.apps.example.net` |

  A separate registrable domain for the apps (`example.net` next to
  `example.com`) is the safer choice; `apps.<your dashboard domain>` works too.
  No DNS at all (a test box)? Use `DOMAIN=localhost` in step 3 — Caddy's local
  CA (`tls internal`), reachable only from the machine itself.
- an SMTP account (host, port, user, password, a sender address) or a
  Resend API key — sign-in codes go out by e-mail.

Every command runs as root (or prefix `sudo`).

**1. Docker, git and go-task**

```sh
curl -fsSL https://get.docker.com | sh
apt-get install -y git openssl
snap install task --classic
docker compose version     # → Docker Compose version v2.x (or newer)
task --version             # → Task version: v3.x
```

**2. The drobek files** (the compose file, the scripts, the env template —
the image itself comes from GHCR)

```sh
git clone https://github.com/freema/drobek /opt/drobek
cd /opt/drobek
git checkout "$(git tag -l 'v*' --sort=-v:refname | head -n 1)"   # the newest release (skip before the first one)
```

**3. Configuration** — generates every secret, writes `.env.production`
(mode 600), renders `deployments/Caddyfile` with the image's own generator
(no Node on the host):

```sh
DOMAIN=drobek.example.com APPS_DOMAIN=apps.example.net \
TLS_ACME_EMAIL=you@example.com SUPERADMIN_EMAIL=you@example.com \
SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=no-reply@example.com \
EMAIL_FROM=no-reply@example.com \
task selfhost:init
```

Expected output (abridged):

```text
✓ created .env.production from .env.production.example (mode 600)
✓ generated POSTGRES_PASSWORD
✓ generated DROBEK_MASTER_KEY
✓ generated TLS_ASK_TOKEN
✓ dashboard https://drobek.example.com · apps https://<slug>.apps.example.net
✓ TLS mode for the app hosts: on-demand
✓ rendered deployments/Caddyfile (on-demand)
✓ docker compose config: OK
```

Then put the SMTP password in (never on the command line):

```sh
nano .env.production       # SMTP_PASS='…'   (single quotes if it has $, # or spaces)
```

`task selfhost:init` never asks anything and never overwrites a secret; run it
again whenever you like (after changing TLS settings: then `task tls:reload`).
The TLS default for a real domain is **on-demand** (one Let's Encrypt
certificate per app host, gated by drobek); `TLS_MODE=wildcard-file` or
`TLS_MODE=dns` pick a wildcard certificate instead — see "TLS" in
`docs/SELF-HOSTING.md`.

**4. Start**

```sh
docker compose --env-file .env.production -f docker-compose.production.yaml up -d --wait
```

The first start pulls the images and drobek applies every database
migration. Expected: `Container drobek-prod-postgres-1
Healthy`, `…-redis-1 Healthy`, `…-drobek-1 Healthy`, `…-caddy-1 Healthy`.

```sh
curl -s https://drobek.example.com/healthz      # → {"ok":true,"db":"up","redis":"up"}
curl -s https://drobek.example.com/api/version  # → {"sha":"<commit>","version":"vX.Y.Z"}
```

Tip: `alias dc='docker compose --env-file .env.production -f docker-compose.production.yaml'`
— the rest of this guide spells the command out.

**5. Sign in** — open `https://drobek.example.com`, enter your
`SUPERADMIN_EMAIL`, type the 6-digit code from the e-mail. You land on `/me`
with a personal workspace.

**6. Connect an agent (Claude Code)**

```sh
claude mcp add --transport http drobek https://drobek.example.com/mcp
```

Claude Code discovers drobek's OAuth server, opens the consent page in your
browser (`read`, `write`, `publish`) and gets a token bound to you. Without a
browser on the agent's machine, mint an API key on the server instead and
pass it as a header:

```sh
docker compose --env-file .env.production -f docker-compose.production.yaml exec drobek \
  node node_modules/@drobek/oauth/dist/cli/api-key-create.js \
  --email you@example.com --name laptop --scopes read,write,publish
# → drk_…   (shown once)
claude mcp add --transport http drobek https://drobek.example.com/mcp \
  --header "Authorization: Bearer drk_…"
```

**7. Publish an app** — ask the agent: *"Build a tip calculator on drobek and
publish it."* It calls `create_app` → `write_files` → `publish`; open the
`published_url` it returns (`https://tip-calculator.apps.example.net`). With
on-demand TLS the very first request to a new app host waits a few seconds for
its certificate.

**A test box without DNS** — the same steps with Caddy's local CA:

```sh
DOMAIN=localhost SUPERADMIN_EMAIL=you@example.com SMTP_HOST=… task selfhost:init   # → TLS mode internal
docker compose --env-file .env.production -f docker-compose.production.yaml up -d --wait
docker compose --env-file .env.production -f docker-compose.production.yaml cp \
  caddy:/data/caddy/pki/authorities/local/root.crt ./drobek-root.crt
curl --cacert drobek-root.crt https://localhost/healthz
```

Trust `drobek-root.crt` in your browser / OS to use it without warnings (Node
clients: `NODE_EXTRA_CA_CERTS=drobek-root.crt`). App hosts are
`https://<slug>.apps.localhost`, which browsers resolve to the machine itself.
`HTTPS_PORT=8443` (plus `HTTP_PORT=8080`) moves Caddy off 443 — every URL then
carries the port.
<!-- quickstart:end -->

Backups (`task backup` / `task restore`), upgrades (`task selfhost:upgrade`),
the three TLS paths, custom domains, abuse handling and every setting:
[`docs/SELF-HOSTING.md`](./docs/SELF-HOSTING.md).

## Connect your agent

The MCP endpoint is `<PUBLIC_APP_URL>/mcp` (OAuth 2.1; the client discovers,
registers and asks for your consent by itself). Scopes: `read`, `write`,
`publish`; the token is bound to you and reaches every workspace you belong
to, with your role in each.

- **Claude Code:** `claude mcp add --transport http drobek https://drobek.example.com/mcp`,
  then `/mcp` → sign in. For the hosted drobek:
  `claude plugin marketplace add freema/drobek-plugin` and
  `claude plugin install drobek@drobek` (MCP server + build skill +
  `/drobek:build-app`).
- **Claude (web / desktop):** add a custom connector with the `/mcp` URL.
- **Cursor:** `~/.cursor/mcp.json` → `{ "mcpServers": { "drobek": { "url": "https://drobek.example.com/mcp" } } }`.
- **Codex:** for the hosted drobek `codex plugin marketplace add freema/drobek-plugin`,
  `codex plugin add drobek@drobek`, `codex mcp login drobek`.
- **Scripts / CI:** a personal `drk_…` API key from `/me/api-keys` as
  `Authorization: Bearer drk_…`.

The agent gets fifteen tools — `list_apps`, `create_app`, `get_app`,
`read_file`, `write_files`, `restore_version`, `publish`,
`set_gallery_listing`, `skill_info`, `configure_module`, `query_data`,
`get_logs`, and for video, audio, images and fonts `create_asset_upload`,
`list_assets`, `delete_asset` (an upload URL — the file never passes through
the model). The full agent contract (scopes,
the briefing, skills, `/llms.txt`) is [`docs/AGENT.md`](./docs/AGENT.md); a
running server serves it at `/llms.txt`, `/llms-full.txt` and
`/build-with-your-agent`. To teach an agent the loop without the plugin:
`cp -r skills/drobek ~/.claude/skills/drobek`.

## Develop locally

Prereqs: **Docker** (compose v2) for the stack; [go-task](https://taskfile.dev)
3, Node 22 and pnpm 10 for the host-side `task check` / `task e2e`.

```sh
git clone https://github.com/freema/drobek && cd drobek
cp .env.example .env
# Two edits make it yours (the rest have working dev defaults):
#   1. SUPERADMIN_EMAIL  → the email you'll sign in with (becomes super-admin)
#   2. DROBEK_MASTER_KEY → a real key:  openssl rand -hex 32
task dev          # or: docker compose up -d --build
```

| Service | Host port | Check |
| ------- | --------- | ----- |
| drobek (dashboard + OAuth AS + MCP `/mcp`) | [3041](http://localhost:3041) | `GET /healthz` → `{ok,db,redis}` (503 when a dependency is down); `GET /health` → `{ok:true}` |
| postgres 17 | 5441 | `pg_isready` |
| redis 7 | 6391 | `redis-cli ping` |
| mailpit (dev SMTP sink) | [8025](http://localhost:8025) | the login codes land here |

The dev stack runs every built-in module plus the example
`drobek-module-hello`. Sign in at [localhost:3041](http://localhost:3041)
(the code is in Mailpit), then point your agent at
`http://localhost:3041/mcp`.

**Opening apps locally.** `APPS_DOMAIN=apps.localhost:3041`, and browsers
resolve every `*.localhost` name to your machine — nothing to add to
`/etc/hosts`:

| Host | Serves |
| --- | --- |
| `http://<slug>--preview.apps.localhost:3041` | the newest version that compiled |
| `http://<slug>.apps.localhost:3041` | the published version ("not published yet" until the first publish) |
| `http://<slug>--v<N>.apps.localhost:3041` | exactly version N |

curl and Node do not resolve `*.localhost` everywhere; send the app host in
the `Host` header instead:

```sh
curl -i -H 'Host: <slug>--preview.apps.localhost:3041' http://127.0.0.1:3041/
```

Browsers refuse `__Host-` cookies on plain `http://localhost`, so the http dev
stack (NODE_ENV ≠ production) uses the unprefixed, still host-only
`drobek_session` / `drobek_app_access` / `drobek_eu`; production and every
https origin use the `__Host-` names. `task dev:tls` runs the dev stack behind
Caddy on `https://localhost` with its local CA. For scripts without an OAuth
flow: `task api-key:create EMAIL=you@example.com NAME=laptop SCOPES=read,write`.

Everyday commands:

```sh
task dev          # build + start the stack, wait until healthy
task check        # host-side gate: install, doc-lint, build packages + app bundle, typecheck, lint, knip, unit tests
task logs         # tail the drobek service
task health       # curl the health endpoints
task e2e          # Playwright suite (incl. @local specs) vs the stack
task e2e:image    # what CI runs: the prod image behind Caddy + the whole suite
task e2e:smoke    # @smoke specs only (safe against any target, prod included)
task build        # build the production image ghcr.io/freema/drobek:<sha>
task prod:proof   # build + prove the prod image (size, non-root, fail-closed, live boot)
task dev:tls      # dev stack behind Caddy (tls internal); task dev:tls:down to leave
task db:generate  # drizzle-kit generate (journal __drizzle_migrations_core)
task down         # stop the stack (docker compose down -v also wipes the data)
```

Contributor rules and the repository map: [`CLAUDE.md`](./CLAUDE.md).

### End-to-end tests

`tests-e2e` is one Playwright suite with two tiers:

- **`@local`** — needs a local stack: seeds and reads Postgres / Redis /
  Mailpit directly. `global-setup.ts` TRUNCATEs the core tables first, but only
  with `ALLOW_DESTRUCTIVE=1` AND a `DATABASE_URL` host on its allow-list
  (`localhost`, `127.0.0.1`, `postgres`).
- **`@smoke`** — public HTTP + MCP only, safe against production: never the
  database, Redis or Mailpit. The MCP smoke loop (`mcp-loop.spec.ts`) signs in
  with a `drk_` key from `SMOKE_API_KEY` (read from the environment only),
  writes, previews and publishes a `smoke-*` app, and leaves nothing behind.
  MCP has no delete tool, so the spec cleans up by target: against the local
  stack (`TEST_ENV=local`) it creates a fresh `smoke-<random>` app and deletes
  it at the end — also when the test fails — through the dashboard delete
  action, signed in as the smoke user by e-mail OTP (Mailpit); against any
  other target (production) it re-uses ONE stable app per key,
  `smoke-<12 hex of a SHA-256 of the key>` (`list_apps` → `get_app`, then a
  new version + publish), so production keeps exactly one smoke app per smoke
  identity:

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

`task e2e` runs against the dev stack (`task dev`). **`task e2e:image`** is the
CI flow (`.github/workflows/ci.yml` runs the same `scripts/e2e-image.sh`):
build the production image, start it with `docker-compose.e2e.yaml` (project
`drobek-e2e`, its own loopback ports, so it runs next to the dev stack) behind
Caddy with `tls internal` on `https://localhost:8443` and
`https://<slug>--preview.apps.localhost:8443`, let it migrate a fresh DB, then
run `@smoke` + `@local` and tear everything down. `DROBEK_IMAGE=…` skips the
build, `E2E_KEEP=1` keeps the stack, extra args go to Playwright
(`task e2e:image -- tests/mcp-loop.spec.ts`).

## Versions and upgrades

drobek follows semantic versioning; while it is at 0.x, a minor release may
need an operator step, and its release notes say which. Every release is a git tag `vX.Y.Z`, an
immutable image `ghcr.io/freema/drobek:vX.Y.Z`, a
[GitHub release](https://github.com/freema/drobek/releases) and an entry in
[`CHANGELOG.md`](./CHANGELOG.md); `latest` and `previous` move with each
release ([`docs/SELF-HOSTING.md` → Image tags](./docs/SELF-HOSTING.md#image-tags)).
Migrations only go forward and run as their own step of
`task selfhost:upgrade`; a rollback is the previous image plus, when the
release migrated the database, the backup taken before it
([Upgrades and rollback](./docs/SELF-HOSTING.md#upgrades-and-rollback)).
Modules declare the contract range they need, and the server refuses to start
with a module it cannot satisfy
([`docs/MODULES.md` → Compatibility](./docs/MODULES.md#compatibility)).

## Extend drobek: write a module

An app's backend is a set of platform modules, and anyone can write one: an
npm package against the published contract, installed by the operator
without building an image.

```sh
npm create drobek-module@latest erp   # routes, SDK slice, migration, SKILL.md, tests
```

[`docs/MODULES.md` → Writing a module](./docs/MODULES.md#writing-a-module)
walks through the contract, publishing and installing;
[`examples/drobek-module-hello`](./examples/drobek-module-hello) is a working
one, and [Published modules](./docs/MODULES.md#published-modules) lists the
modules others can install.

## Contributing

Issues, questions and pull requests are welcome — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md). Questions and ideas go to
[Discussions](https://github.com/freema/drobek/discussions); security issues
are reported privately ([`SECURITY.md`](./SECURITY.md)).

## Documentation

| Document | What |
| --- | --- |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | one process, origins, versions, the compiler, serving, modules, TLS, jobs |
| [`docs/SELF-HOSTING.md`](./docs/SELF-HOSTING.md) | the quickstart, compose, every environment variable, TLS, backups, upgrades, custom domains, abuse |
| [`docs/MODULES.md`](./docs/MODULES.md) | the platform module contract and the built-in modules |
| [`docs/AGENT.md`](./docs/AGENT.md) | connecting agents, the tools and scopes, the briefing, skills, `llms.txt` |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | the threat model and how to report a vulnerability |
| [`docs/LICENSING.md`](./docs/LICENSING.md) | AGPL-3.0 §13 and the boundary with the hosted drobek.app |
| [`CHANGELOG.md`](./CHANGELOG.md) | every release |

## License

[AGPL-3.0](./LICENSE) — see [`docs/LICENSING.md`](./docs/LICENSING.md).
