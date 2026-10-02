# Self-hosting drobek

drobek is one image (`ghcr.io/freema/drobek`) plus Postgres, Redis and Caddy.
Caddy terminates TLS for the dashboard and for every app host, and proxies
everything to drobek on the internal network. This guide takes a clean
server to a working instance — dashboard over TLS, an agent connected over
MCP, a published app — and covers backups, upgrades and every setting.

**Measured:** on a clean Ubuntu 24.04 + Docker host (a fresh GitHub
`ubuntu-24.04` runner, 2026-09-30) with the released `v0.6.1` image, the
image pull took 8 s, the whole quickstart below (init → TLS dashboard → user →
MCP → published app with an uploaded file) **31 s**, a backup 3 s and a
restore on a second "machine" (fresh checkout + `task selfhost:init` +
`task restore`) 25 s. The run is the manual `selfhost-rehearsal.yml`
workflow (`task selfhost:rehearsal` with `tls internal`).

## Quickstart (clean Ubuntu 24.04 + Docker)

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
curl -s https://drobek.example.com/api/version  # → {"name":"drobek","sha":"<commit>","version":"vX.Y.Z","commitTime":"…","startedAt":"…","modules":[…]}
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

## Hosts

| Host | What | Example |
| --- | --- | --- |
| `PUBLIC_APP_URL` | dashboard, OAuth server, MCP at `/mcp` | `https://drobek.example.com` |
| `<slug>.<APPS_DOMAIN>` | an app's published version | `https://shop.apps.example.com` |
| `<slug>--preview.<APPS_DOMAIN>` | the working copy (newest version that compiled) | `https://shop--preview.apps.example.com` |
| `<slug>--v<N>.<APPS_DOMAIN>` | exactly version N | `https://shop--v3.apps.example.com` |
| a verified custom domain | the app's published version ([Custom domains](#custom-domains)) | `https://shop.example.org` |

DNS: an `A`/`AAAA` record for the dashboard host and a **wildcard**
`*.<APPS_DOMAIN>` record, both pointing at the server. The dashboard may sit on
the apex of `APPS_DOMAIN` (`drobek.app` + `*.drobek.app`) — it never serves an
app — but a separate registrable domain for the apps is the safer choice.

## Production compose

[`docker-compose.production.yaml`](../docker-compose.production.yaml) runs
drobek, postgres 17, redis 7 and caddy, all `restart: unless-stopped` with a
healthcheck each. Only Caddy publishes ports (80, 443, 443/udp —
`HTTP_PORT` / `HTTPS_PORT` / `PUBLISH_IP` move them); drobek, postgres and
redis stay on the internal network. Nothing secret is written in the file —
every value comes from `.env.production` (`--env-file` for interpolation,
`env_file` for drobek). A missing secret or host stops
`docker compose` before anything starts (`${VAR:?}`); a missing mail
transport (`SMTP_HOST`, or `RESEND_API_KEY` with `EMAIL_TRANSPORT=resend`)
stops drobek itself at start, and
`docker compose --env-file .env.production -f docker-compose.production.yaml config`
prints no warnings. The compose project is **`drobek-prod`** (not `drobek`,
the dev stack's name in a checkout — a `down -v` here can never reach the dev
volumes).

[`.env.production.example`](../.env.production.example) documents every
variable (what it is, how it is generated, which ones are secrets). The
compose file fixes, for drobek: `NODE_ENV=production`,
`TRUST_PROXY=x-real-ip`, `APPS_URL_SCHEME=https`, `FILES_DIR=/data/files`,
`ASSETS_DIR=/data/assets`,
`DATABASE_URL` / `REDIS_URL` of the bundled services, `PUBLIC_ORIGIN`
defaulting to `PUBLIC_APP_URL`, and `DROBEK_MODULES` defaulting to all six
built-ins.

| Variable | Required | What |
| --- | --- | --- |
| `DROBEK_IMAGE_TAG` | — (`latest`) | image tag, see [Image tags](#image-tags) |
| `PUBLIC_APP_URL` | yes | `https://<dashboard host>[:<HTTPS_PORT>]` |
| `APPS_DOMAIN` | yes | apps live on `*.<APPS_DOMAIN>` (`:<port>` when not 443) |
| `POSTGRES_PASSWORD` | yes, secret | generated; only used when `pg_data` is first created |
| `DROBEK_MASTER_KEY` | yes, secret | generated, 64 hex; encrypts upstream secrets, signs app cookies — keep it with your backups |
| `TLS_ASK_TOKEN` | secret | generated; the on-demand TLS `ask` token (drobek + Caddy) |
| `SMTP_HOST` | yes (smtp) | SMTP server; `SMTP_PORT` (587), `SMTP_SECURE` (0 / 1 = implicit TLS), `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| `EMAIL_TRANSPORT` / `RESEND_API_KEY` | — (`smtp`) / secret | `resend` sends through the Resend API instead of SMTP (then `SMTP_*` is not needed and `RESEND_API_KEY` is) |
| `SUPERADMIN_EMAIL` | recommended | your sign-in e-mail(s), super-admin over every workspace |
| `LANDING_URL` | — | your own website: `<PUBLIC_APP_URL>/` answers 301 there instead of the built-in landing page |
| `DOCS_URL` | — | a website with the drobek docs: the agent docs link `<DOCS_URL>/<page>` instead of the files on GitHub |
| `DASHBOARD_GITHUB_STARS` | — (on) | `off` = the dashboard footer makes no call to `api.github.com` for the repository's star count |
| `TLS_*`, `CADDY_*` | per TLS path | see [TLS](#tls) |
| `HTTP_PORT`, `HTTPS_PORT`, `PUBLISH_IP` | — | published ports / bind address |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | optional Google sign-in |
| `TLS_CUSTOM_DOMAINS`, `DOMAINS_MAX_PER_APP`, `DOMAINS_DNS_SERVERS`, `DOMAINS_RECHECK_INTERVAL_MS` | — | [custom domains](#custom-domains) (catch-all certificate on by default in on-demand mode; 3 per app) |
| `TERMS_URL`, `ABUSE_REPORTS_PER_IP_HOUR`, `ABUSE_BRAND_WORDS` | — | [abuse handling](#abuse-and-takedowns) (terms link of the 451 page; 5 reports / IP / hour; publish-heuristic brand words) |
| `GALLERY_ENABLED`, `GALLERY_API_PER_IP_MINUTE`, `GALLERY_OPENS_PER_IP_HOUR`, `GALLERY_LIKES_PER_USER_HOUR`, `GALLERY_FRAME_ANCESTORS`, `DUPLICATES_PER_USER_HOUR` | — (off) | [the public gallery](#public-gallery) (`true` = owners may list published apps; `GET /api/public/gallery`; 60 requests / IP / minute; 60 counted opens / IP / hour; 30 likes / account / hour; your gallery website's origins that may show listed apps as live previews and receive visitors back after a like; 10 copies of gallery apps per person per hour) |
| `PUBLISH_APPROVAL`, `OPERATOR_EMAIL`, `PUBLISH_NOTIFY` | — (`open`, off) | [publish approval](#publish-approval) (`approval` = a workspace publishes only after a super-admin allowed it; the contact refused users see; `first` / `every` = e-mail the operator about publishes) |
| `EMAIL_SIGNIN_APP_HOURLY_SHARE` | — (25) | one app's percent of the sign-in e-mail budget — raise it on a single-app server (see [Production compose](#production-compose)) |
| `EMAIL_WORKSPACE_HOURLY_SHARE` | — (50) | one workspace's percent of each module e-mail budget — raise it to 100 on a single-workspace server |
| limits (`OTP_*`, `COMPILE_*`, `DATA_*`, `FILES_*`, `EMAIL_*`, …) | — | production defaults; every variable is in the [Environment reference](#environment-reference) |

The file is read by `docker compose` and by `docker run --env-file` (the
Caddyfile generator): one `KEY=value` per line, no inline comments; quote a
value that contains `$`, `#` or spaces with single quotes. Careful: `docker
compose` lets a variable **exported in your shell** override the same key in
`--env-file` — don't export drobek settings in the shell you run compose from.
The `task` commands (`selfhost:*`, `backup`, `restore`, `tls:reload`) go
through `scripts/selfhost-compose.sh`, which removes every key of
`.env.production` from the environment first, so the file always wins there.

The compose file sets `TRUST_PROXY=x-real-ip` for drobek: behind Caddy the
client IP (every per-IP rate limit) comes only from the `X-Real-IP` header
Caddy sets from the TCP peer — a client-sent `X-Real-IP` or
`X-Forwarded-For` is overwritten/ignored. Leave `TRUST_PROXY` unset only when
a different proxy (e.g. nginx with `X-Real-IP $remote_addr`) is in front.
Per-IP limits need a resolved client IP: a request that arrives without a
trusted header (a proxy that does not set `X-Real-IP`, a request that
bypassed the proxy) gets no per-IP bucket at all — not a shared one — so only
the per-app, per-user and per-code limits hold it. drobek logs one
`rate_limit_no_client_ip` warning per limit (once per start) when that
happens; seeing it in production means the proxy header is missing.

drobek sends its responses uncompressed; the generated Caddyfile compresses
them (`encode zstd gzip`) on every site — dashboard, app hosts and custom
domains. Only `200` responses of at least 1 KB with a text type (HTML, CSS,
JavaScript, JSON, XML, SVG, plain text, fonts, wasm) are compressed: a `206`
range stays byte-exact, images are left alone, and `text/event-stream` is
never compressed, so MCP's streamable HTTP and any SSE an app backend proxies
arrive event by event. With a different proxy in front, compress the same way
and keep `text/event-stream` out of it.

Request bodies on the dashboard origin are capped at `DASHBOARD_MAX_BODY_BYTES`
(1 MiB): a bigger body sent to a dashboard page, the sign-in or an OAuth
endpoint answers `413` — a declared `Content-Length` before anything is read,
a chunked body as soon as the bytes that arrived pass the cap — and the
connection closes after the answer. `/mcp` (`MCP_MAX_BODY_BYTES`), the asset
upload URLs (the asset size) and the Data tab's CSV import (a 10 MiB file)
keep their own limits. The generated Caddyfile refuses the same bodies on the
dashboard site before they reach drobek (`request_body`, those paths left to
drobek), so after changing the variable re-run `task selfhost:init` and
`task tls:reload`. With a different proxy in front, cap the dashboard origin
the same way or leave it to drobek.

**Stopping and restarting drobek** (an upgrade, `docker compose restart`, a
host reboot) does not cut the requests it is answering. On `SIGTERM` drobek
stops accepting connections, closes idle keep-alive connections, ends the MCP
listen streams (the long-lived `GET /mcp` an MCP client holds open; the
stopping server answers a new one 405), lets requests in flight — a
`write_files` compile, a token refresh, a page — finish for up to
`SHUTDOWN_GRACE_MS` (20 s), cuts whatever is still running after that, stops
its background jobs and exits. The compose file gives the container
`stop_grace_period: 30s` so Docker does not kill it first; keep it about 10 s
above `SHUTDOWN_GRACE_MS` when you raise that. An error nothing in drobek
caught (an uncaught exception or an unhandled promise rejection) stops it the
same way: the error is logged, sent to the error reporter (`ERROR_REPORTER`)
and drobek exits with code 1 once the requests in flight drained, so Docker's
`restart: unless-stopped` starts it again. MCP sessions live in the
process: after a restart a client's next request with its old session id
answers `404 MCP session not found — reconnect.`, which per the MCP
specification makes the client open a new session (reconnect a client that
does not). The same answer comes for a session drobek closed while running:
one without a request for `MCP_SESSION_IDLE_TTL_MS` (1 hour; an open listen
stream counts as a request), a user's least recently used one when they open
more than `MCP_SESSIONS_PER_USER` (10), and every session of an API key or
an OAuth connection the moment it is revoked. Each closing leaves a
`mcp session closed` log line with the reason (`idle`, `limit`, `revoked`),
the short session id and the user id.
drobek keeps idle connections open for 125 s, longer than Caddy's 2-minute
upstream keep-alive, so Caddy never reuses a connection drobek is closing;
with a different proxy in front, keep its upstream idle timeout below 125 s.

**Database connections.** drobek keeps two Postgres pools of up to
`DB_POOL_MAX` (20) connections each: one for requests (dashboard, MCP, app
hosts) and one for its background jobs, opened only while a job runs —
keep `2 × DB_POOL_MAX` plus a few below Postgres's `max_connections` (100 in
the bundled database). A request's query that runs past
`DB_STATEMENT_TIMEOUT_MS` (30 s), or waits past `DB_LOCK_TIMEOUT_MS` (10 s)
for a row or lock another request holds, is cut off instead of holding a
connection everyone else waits for: an agent gets `busy` (`reason:
"database_timeout"`), an app's page or module call and the asset upload URL a 503,
the dashboard its error page, and the log a `db error 57014` / `55P03` line.
The background jobs run without the statement timeout and the migrations
without either. `0` turns a timeout off (the database's own setting, e.g.
one set on the role, applies).

Platform modules (the backends apps use through `import { drobek } from
'drobek'`) are enabled with `DROBEK_MODULES` (comma-separated; a
short name `x` loads the package `drobek-module-x` from the server's
dependencies, or from `DROBEK_MODULES_DIR` for a module you installed with
`task selfhost:module:add` — [Third-party modules](#third-party-modules)). The server applies each module's migrations on start and
refuses to start on a module it cannot load. Limits come from their env vars
or, with `LIMITS_PROVIDER_URL` + `LIMITS_PROVIDER_SECRET`, from your own
signed limits endpoint. The image ships the built-in `auth`, `email`,
`forms`, `data`, `proxy`, `files`, `sync` and `oidc`
(`DROBEK_MODULES=auth,email,forms,data,proxy,files,sync,oidc`, the compose default;
`forms` requires `email`, `sync` requires `proxy` and `data`, `oidc` requires `auth`). Proxy upstreams may only use ports 80 and 443
(`PROXY_ALLOWED_PORTS`); an upstream on a private address needs its hostname
on `PROXY_ALLOWED_HOSTS` (keep it empty in production). The old
`/<ws>/api/proxy/<name>/*` dashboard-host route is gone: an app calls
`/__drobek/v1/proxy/<name>/*` once the upstream is assigned to it. `files`
stores end-user uploads on disk under `FILES_DIR` (`/data/files`, the
`files_data` volume): one file per distinct content, the type sniffed from
the bytes, at most `FILES_MAX_BYTES` (10 MiB) per file and
`FILES_QUOTA_PER_APP` (500 MiB) per app. Enabling `data` on a server that stored records through the
pre-module Data API imports them (collections → the app's data config,
access modes → rules, live documents → records) and drops the old
`collections` / `app_documents` tables in its first migration — back up the
database first. An app's preview and production hosts share its records. Module
e-mail uses the same SMTP settings as the dashboard login and is capped
server-wide by `EMAIL_GLOBAL_HOURLY_MAX` (default 500 recipients per hour).
End users' sign-in codes get a reserved part of it, `EMAIL_SIGNIN_HOURLY_MAX`
(default 20 % of the cap, at least 50, at most half — 100 of 500), one app
at most `EMAIL_SIGNIN_APP_HOURLY_SHARE` percent of those (default 25, at
least 10 — raise it on a single-app server);
notifications (forms, `notifyAdmins`) get the rest, and one app at most
`EMAIL_APP_HOURLY_SHARE` percent of that (default 25); one workspace (all
its apps) at most `EMAIL_WORKSPACE_HOURLY_SHARE` percent of each (default
50 — raise it to 100 on a single-workspace server). Past its budget a
class pauses for exactly `EMAIL_GLOBAL_PAUSE_MINUTES`, then starts a fresh
hourly budget — notifications pausing never
blocks sign-in — and the log gets an `email_global_pause` ALERT line (with
`class`) — alert on it. The contract and the
provider protocol are in [`MODULES.md`](./MODULES.md).

Volumes (named `drobek-prod_<name>`):

| Volume | Holds | In `task backup` |
| --- | --- | --- |
| `pg_data` | the database: apps, every version's files (content-addressed blobs), users, keys, module data | yes (`pg_dump -Fc`) |
| `files_data` | the files module's uploads (`/data/files`; `mod_files` rows point at them) | yes (tar) |
| `assets_data` | app assets — video, audio, images, fonts served at `/<path>` (`/data/assets`; `app_assets` rows point at them) | yes (tar) |
| `modules_data` | modules you installed (`/data/modules` = `DROBEK_MODULES_DIR`: one directory per module + `modules.lock.json`, [Third-party modules](#third-party-modules)) | yes (tar) |
| `caddy_data` | ACME account, issued certificates, Caddy's local CA — losing it means re-issuing every certificate | yes (tar) |
| `caddy_config` | Caddy's autosaved config (rebuilt from the Caddyfile) | no |
| `redis_data` | sessions, caches, rate limits, leases, un-flushed request counters (AOF) | no — after a restore everyone signs in again |

## Environment reference

Every variable drobek, its compose files and its tests read. The production
compose file sets the ones marked *(compose)* itself; everything else is
optional unless the table says otherwise, and every limit has a production
default. The same variables, with longer comments, are in
[`.env.example`](../.env.example) (the dev stack) and
[`.env.production.example`](../.env.production.example) (self-host). A
limit marked *(plan)* can also come per workspace from the limits provider.

### Hosts, image and ports

| Variable | Default | What |
| --- | --- | --- |
| `PUBLIC_APP_URL` | dev `http://localhost:3041` | **required** — the dashboard origin: OAuth issuer, dashboard, MCP at `/mcp`. Never serves an app |
| `PUBLIC_MCP_URL` | `PUBLIC_APP_URL` + `/mcp` | the MCP resource identifier (the token audience, RFC 8707) |
| `PUBLIC_ORIGIN` | `PUBLIC_APP_URL` | invite links and the Google `redirect_uri` base |
| `APPS_DOMAIN` | dev `apps.localhost:3041` | **required in production** — apps live on `*.<APPS_DOMAIN>` (host[:port], no scheme) |
| `APPS_URL_SCHEME` | `http` for `*.localhost`, else `https` *(compose: https)* | scheme of the app URLs drobek hands out |
| `APPS_UNKNOWN_HOST_LIMIT` / `APPS_UNKNOWN_HOST_WINDOW_MS` | 60 / 60000 | "no app here" answers per client IP per window, then 429 |
| `APPS_MODULE_BODY_TIMEOUT_MS` | 120000 | a `/__drobek/*` request (module routes, uploads, the beacon) must deliver its body within it, else 408; raise it with `FILES_MAX_BYTES` for big uploads over slow links |
| `DASHBOARD_MAX_BODY_BYTES` | 1048576 | the largest request body of the dashboard origin's pages, sign-in and OAuth endpoints — a declared length or a chunked body counted as it arrives; a bigger one answers 413 before it is read further. `/mcp`, the asset upload URLs and the Data tab's CSV import keep their own limits. The generated Caddyfile carries the same cap: re-render it after a change ([Production compose](#production-compose)) |
| `DROBEK_IMAGE_TAG` | `latest` | image tag of the production compose ([Image tags](#image-tags)) |
| `HTTP_PORT` / `HTTPS_PORT` / `PUBLISH_IP` | 80 / 443 / all | ports and bind address Caddy publishes |
| `TRUST_PROXY` | auto *(compose: `x-real-ip`)* | which client-IP header is trusted: `x-real-ip` = only Caddy's `X-Real-IP`; unset = `X-Real-IP`, else the rightmost `X-Forwarded-For` hop |
| `NODE_ENV` | *(compose: production)* | `production` turns on `__Host-` cookies and the fail-closed secret checks, and ignores the dev-only switches below |
| `PORT` | 3000 | the port drobek listens on inside the container (the dev compose maps `WEB_PORT` to it) |
| `SHUTDOWN_GRACE_MS` | 20000 | on `SIGTERM` (and after an error nothing caught, which exits with code 1), how long requests in flight may finish before the rest is cut ([Production compose](#production-compose)); keep the container's stop grace period (compose: 30 s) above it |

### Database

| Variable | Default | What |
| --- | --- | --- |
| `DB_POOL_MAX` | 20 | connections of each of drobek's two Postgres pools — requests, and the background jobs (open only while a job runs); 1–200. Keep `2 × DB_POOL_MAX` plus a few below Postgres's `max_connections` ([Production compose](#production-compose)) |
| `DB_STATEMENT_TIMEOUT_MS` | 30000 | a request's query running longer is cut off (Postgres `statement_timeout`; MCP `busy` with `reason: "database_timeout"`, module routes `503 unavailable`). Not for the background jobs or the migrations; `0` = drobek sets none, else 100–3600000 |
| `DB_LOCK_TIMEOUT_MS` | 10000 | a query of a request or a job waiting longer for a row, table or advisory lock is cut off (Postgres `lock_timeout`), answered like the statement timeout. Not for the migrations; `0` = drobek sets none, else 100–3600000 |

### Secrets and TLS

| Variable | Default | What |
| --- | --- | --- |
| `DROBEK_MASTER_KEY` | — | **required, secret** — 64 hex; encrypts module and upstream secrets, keys the app-access cookie and the forms token. Keep it with your backups |
| `POSTGRES_PASSWORD` | — | **required, secret** (production compose) — used when `pg_data` is first created |
| `TLS_ASK_TOKEN` | — | secret, ≥ 32 URL-safe characters — the on-demand TLS `ask` token (drobek + Caddy); unset = every certificate refused |
| `TLS_INTERNAL` | — | `1` = Caddy's local CA for every site (a test box, `task dev:tls`) |
| `TLS_WILDCARD_CERT_FILE` / `TLS_WILDCARD_KEY_FILE` / `TLS_CERTS_DIR` | — / — / `./certs` | TLS path (a): your wildcard certificate files |
| `TLS_DNS_PROVIDER` / `TLS_DNS_PROVIDER_ARGS` / `TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN` | — | TLS path (b): ACME DNS-01 |
| `CADDY_IMAGE` / `CADDY_BUILD_TARGET` / `CADDY_DNS_MODULE` | `caddy:2-alpine` / — / — | the DNS-01 Caddy build (`drobek-caddy:dns`, `dns`, `github.com/caddy-dns/<provider>`) |
| `TLS_ACME_EMAIL` | — | ACME account e-mail for expiry notices |
| `TLS_CUSTOM_DOMAINS` | on in on-demand mode | `1` / `0` — the on-demand catch-all for verified custom domains |

### Sign-in, e-mail and the operator

| Variable | Default | What |
| --- | --- | --- |
| `SUPERADMIN_EMAIL` | — | comma-separated sign-in addresses with super-admin rights over every workspace (the abuse queue, reports) |
| `EMAIL_TRANSPORT` | smtp | how all mail goes out (sign-in codes, invites, module mail): `smtp`, `resend`, or the id of a transport a module in `DROBEK_MODULES` contributes to the `email.transport` slot ([MODULES](MODULES.md#e-mail-transports-from-modules): SES, Postmark, a company relay, …; set the secret env vars the module names). The server refuses to start on an invalid value, an id no active module contributes, or a missing transport secret |
| `EMAIL_TRANSPORT_TIMEOUT_MS` | 10000 | how long one send through a module transport may take before it is aborted (1000–120000) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | — / 587 / 0 / — / — / — | **`SMTP_HOST` required with `smtp`** (production refuses to start without it) — the SMTP server for sign-in codes and module mail (`SMTP_SECURE=1` = implicit TLS); `EMAIL_FROM` is the sender for both transports (`Name <address>`; a bare address is sent under the name `drobek`) |
| `RESEND_API_KEY` | — | **required with `resend`**, a secret (the server refuses to start without it; it is never logged or shown) — mail goes to `POST https://api.resend.com/emails` with a 10 s timeout; `EMAIL_FROM` must be on a domain verified in Resend |
| `OTP_IP_SHORT_LIMIT` / `OTP_IP_DAILY_LIMIT` | 5 per 15 min / 20 per 24 h | dashboard sign-in codes sent per client IP |
| `OTP_EMAIL_HOURLY_LIMIT` / `OTP_EMAIL_COOLDOWN_MS` | 3 per hour / 60000 | codes per address, minimum gap per address |
| `OTP_GLOBAL_HOURLY_MAX` | 100 | codes per hour server-wide, then sending pauses |
| `OTP_VERIFY_IP_LIMIT` / `OTP_VERIFY_IP_WINDOW_S` | 30 / 900 | code checks per client IP per window (the per-code cap of 5 guesses always applies) |
| `OTP_LOGIN_DISABLED` | 0 | `1` = kill switch: no sign-in codes are sent |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | optional Google sign-in for the dashboard (redirect URI `<PUBLIC_ORIGIN>/auth/google/callback`) |
| `GOOGLE_AUTH_URL` / `GOOGLE_TOKEN_URL` / `GOOGLE_USERINFO_URL` | Google's endpoints | dev only: point Google sign-in at the mock provider (`task mock:google`) |
| `OAUTH_DCR_MAX_UNUSED_CLIENTS` | 500 | MCP clients registered by DCR that never got consent, before registration answers 503 |
| `OAUTH_CIMD_DEV_ORIGINS` | — | dev/test only, ignored in production: origins allowed to serve a Client ID Metadata Document over plain http |
| `AUTH_OIDC_DEV_ORIGINS` | — | dev/test only, ignored in production: origins the `oidc` module may reach over plain http from a private address (the mock IdP of `task mock:oidc`) |
| `DASHBOARD_GITHUB_STARS` | on | the dashboard footer shows the source repository's GitHub star count, fetched server-side from `api.github.com` (unauthenticated, 3 s timeout, cached 1 h, never delays a page); `off` = no outbound call, no stars |

### Apps, compiler and serving

| Variable | Default | What |
| --- | --- | --- |
| `COMPILE_MAX_FILES` / `COMPILE_MAX_FILE_BYTES` / `COMPILE_MAX_TOTAL_BYTES` | 200 / 524288 / 5242880 | per app version |
| `COMPILE_MAX_IMPORT_DEPTH` | 50 | depth of a relative import chain |
| `COMPILE_TIMEOUT_MS` / `COMPILE_CONCURRENCY` / `COMPILE_QUEUE_TIMEOUT_MS` | 10000 / 4 / 10000 | per build; builds at once; max queue wait (then `busy`) |
| `MCP_MAX_BODY_BYTES` | 2 × `COMPILE_MAX_TOTAL_BYTES` (10485760) | the largest `/mcp` request body — one `write_files` call as JSON; a bigger one answers 413 with a JSON-RPC error telling the agent to split the write (the briefing states the value) |
| `MCP_SESSION_IDLE_TTL_MS` / `MCP_SESSIONS_PER_USER` | 3600000 / 10 | MCP sessions are held in the server's memory: one with no request open for the idle TTL is closed (an open listen stream keeps it), and a user who opens a session past the cap has their least recently used one closed. The client's next request with a closed session's id answers 404, and the client initializes a new session ([Production compose](#production-compose)) |
| `READINESS_MAX_WARNINGS` | 50 | warnings one publish readiness report lists (write_files, publish, the app page); the rest are counted in `warnings_omitted` |
| `TYPECHECK_WORKERS` / `TYPECHECK_TIMEOUT_MS` / `TYPECHECK_MAX_MEMORY_MB` / `TYPECHECK_MAX_FILES` | 1 / 20000 / 512 / 150 | the background TypeScript check of each stored version (`type_error` readiness warnings): checks at once in worker threads (0 = off), time and heap per check, max .ts/.tsx files per app; a check over a limit gives no type warnings and is logged |
| `BEACON_RATE_LIMIT` / `BEACON_APP_RATE_LIMIT` / `BEACON_RATE_WINDOW_MS` | 60 / 600 / 60000 | browser error reports per app+IP and per app per window |
| `BEACON_MAX_EVENTS_PER_APP` / `BEACON_RETENTION_DAYS` / `BEACON_SAMPLE_RATE` | 500 / 30 / 1 | the per-app error buffer (newest N, max age) and sampling |
| `LOGS_PRUNE_INTERVAL_MS` | 3600000 | how often the server removes `get_logs` rows past their retention for every app (errors past the buffer above, compiles and daily request stats older than 30 days) |
| `DROBEK_MIGRATE_ON_START` | 1 | `0` = the server does not apply migrations on start (tests, tooling) |
| `AUDIT_RETENTION_DAYS` | 365 | audit rows older than this are pruned daily |
| `APPS_MAX_PER_WORKSPACE` | 50 | live apps per workspace (deleted ones do not count); `create_app` beyond it answers `limit_exceeded` *(plan)* |
| `VERSIONS_PER_APP_HOUR` / `VERSIONS_PER_USER_HOUR` | 600 / 1200 | new versions of one app / made by one person (every app and workspace) within the last hour — `write_files`, `create_app`, `restore_version`, `duplicate_app` and the dashboard's Restore and duplicate page together; past either the call answers `rate_limited` with `retry_after_seconds` (the dashboard 429 + `Retry-After`) and nothing is stored *(plan)* |
| `APP_VERSIONS_KEEP` | 200 | the newest versions of each app the hourly history retention keeps; older versions are deleted — never the published one, one whose asset set is kept for a rollback, the one the preview serves or one from the last hour — and the blob GC frees their bytes. `read_file` / `restore_version` of a deleted one answer `not_found` saying so; the dashboard's version history and `get_app` state the number *(plan; while the limits provider does not answer, the retention leaves the workspace alone)* |
| `WORKSPACE_SOURCE_QUOTA` | 1073741824 | bytes of the unique files (sources and build output) the versions of a workspace's live apps may store (1 GiB; deleted apps do not count); a write, `create_app` or gallery copy whose new bytes do not fit answers `limit_exceeded` and nothing is stored; a restore adds no bytes *(plan)* |
| `ASSETS_DIR` | `/data/assets` *(compose)* | app asset storage (the `assets_data` volume) |
| `APP_ASSET_MAX_BYTES` / `APP_ASSETS_QUOTA` | 104857600 / 1073741824 | one app asset (100 MiB) / all assets of one app (1 GiB); `asset_too_large` / `asset_quota_exceeded` *(plan)*. An upload must arrive within Node's 300 s request timeout |
| `APP_ASSET_UPLOADS_PER_HOUR` | 60 | upload URLs (`create_asset_upload`, the Assets tab) per app per hour, then `rate_limited` |
| `APP_FRAME_SRC_EXTRA` | — | extra `https://host[:port]` origins (comma or space separated) every app may show in an `<iframe>`, besides YouTube, Vimeo and Google Drive; an invalid entry stops the server at start |

### Platform modules

| Variable | Default | What |
| --- | --- | --- |
| `DROBEK_MODULES` | none *(compose: `auth,email,forms,data,proxy,files,sync,oidc`)* | the modules this server runs; `x` loads `drobek-module-x` ([`MODULES.md`](./MODULES.md)) |
| `DROBEK_MODULES_ROOT` | the server's directory | where module packages are resolved from when they are not in `DROBEK_MODULES_DIR` |
| `DROBEK_MODULES_DIR` | `/data/modules` *(compose: the `modules_data` volume; dev: `./.modules`)* | modules the operator installed (`task selfhost:module:add`, dev: `task module:add`): `<dir>/<name>/node_modules/<package>` + `modules.lock.json`; looked up BEFORE the server's dependencies; a module there that the lockfile does not list, or whose files changed, refuses the start ([Third-party modules](#third-party-modules)). Change it only for a [derived image](#derived-image) that bakes its modules elsewhere |
| `DROBEK_MODULES_UNLOCKED` | — | `1` = load modules from `DROBEK_MODULES_DIR` without the `modules.lock.json` check — for developing a module locally; ignored (with a warning) when `NODE_ENV=production` |
| `DROBEK_MODULE_<NAME>_DEFAULTS` (e.g. `DROBEK_MODULE_AUTH_DEFAULTS`) | — | server-wide config defaults of the module `<name>`: a JSON merge patch over its defaults (`{"allow":{"domains":["acme.com"]}}`), validated by its schema at start — invalid refuses the start ([`MODULES.md`](./MODULES.md#operator-defaults-drobek_module_name_defaults)) |
| `MODULE_ENABLED_<NAME>` (e.g. `MODULE_ENABLED_CRM`) | 0 | only for an opt-in module (`availability: 'opt-in'`): `1` enables it on every workspace; unset / `0` = a super-admin enables it per workspace in the dashboard (Workspace → Modules). A limits provider may answer it per workspace (`1` on, `0` off — also over the dashboard switch) ([`MODULES.md`](./MODULES.md#per-workspace-enabling-opt-in-modules)) *(plan)* |
| `MODULE_JOBS_ENABLED` | 1 | `0` = this process runs no module jobs (e.g. every replica but one); modules declare their scheduled `jobs` ([`MODULES.md`](./MODULES.md#scheduled-jobs-jobs)) |
| `MODULE_JOBS_CONCURRENCY` | 4 | module job runs in flight per process; a due run past it waits for a later check |
| `MODULE_JOBS_TIMEOUT_MS` | 300000 | the longest one module job run may take: then it is aborted, counted as failed and retried with backoff |
| `ERROR_REPORTER` | — | where server errors go besides the log: the id of an error reporter a module in `DROBEK_MODULES` contributes to the `errors.reporter` slot ([MODULES](MODULES.md#error-reporters-from-modules): an incident webhook, a log service, …; set the secret env vars the module names). Empty = log only. The server refuses to start on an invalid value, an id no active module contributes, or a missing reporter secret |
| `ERROR_REPORTER_TIMEOUT_MS` | 5000 | how long one delivery to the error reporter may take before it is aborted and dropped (100–60000) |
| `ERROR_REPORTER_MAX_PER_MINUTE` | 60 | reports sent per minute (1–10000); the rest are only logged (one warning per minute), an identical error goes out once per minute |
| `DROBEK_SKILLS_DIR` | `./skills` (image: `/app/skills`) | the general skills `skill_info` lists |
| `LIMITS_PROVIDER_URL` / `LIMITS_PROVIDER_SECRET` | — | per-workspace limits from your own HMAC-signed endpoint (secret ≥ 32 characters) |
| `AUTH_CODES_PER_IP_15MIN` / `AUTH_CODES_PER_IP_DAY` | 5 / 20 | `auth`: sign-in codes per client IP *(plan)* |
| `AUTH_CODES_PER_EMAIL_HOUR` / `AUTH_CODES_PER_APP_HOUR` | 3 / 100 | `auth`: codes per address, per app *(plan)* |
| `AUTH_ATTEMPTS_PER_IP_15MIN` / `END_USERS_MAX_PER_APP` | 30 / 1000 | `auth`: send-code, verify and provider begin/complete calls per IP; end users per app *(plan)* |
| `AUTH_OIDC_ISSUER` / `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` | — | `oidc`: one company IdP for every app whose `providers.oidc` has no `issuer` (the issuer's host may be private and on any port); the secret is also the fallback of every app's `OIDC_CLIENT_SECRET`. Redirect URI at the IdP: `<PUBLIC_APP_URL>/__drobek/auth/callback/oidc` |
| `OIDC_DISCOVERY_CACHE_SEC` | 3600 | `oidc`: seconds an IdP's discovery document is cached, server-wide (its keys: 1 hour, an unknown key id refetches them at most once a minute) |
| `AUTH_PROVIDER_CALLBACKS_PER_IP_15MIN` | 60 | `auth`: sign-in provider callbacks (`/__drobek/auth/callback/<provider>` on the dashboard host) per client IP per 15 min — server-wide, never a plan value (the app is not known yet) |
| `EMAIL_PER_APP_PER_DAY` / `EMAIL_NOTIFY_ADMINS_PER_DAY` | 50 / 20 | `email`: notification mails per app per day; `notifyAdmins()` per user per day *(plan)* |
| `EMAIL_GLOBAL_HOURLY_MAX` / `EMAIL_GLOBAL_PAUSE_MINUTES` | 500 / 15 | the operator-wide cap on all module mail (recipients per hour) and the pause length (a fixed window: the class budget restarts after it) |
| `EMAIL_SIGNIN_HOURLY_MAX` / `EMAIL_SIGNIN_APP_HOURLY_SHARE` | 20 % of the cap (at least 50, at most half) / 25 % | the sign-in part of the cap; one app's share of it |
| `EMAIL_APP_HOURLY_SHARE` | 25 % | one app's share of the notification part |
| `EMAIL_WORKSPACE_HOURLY_SHARE` | 50 % | one workspace's share (all its apps) of the notification and of the sign-in part; never below one app's share |
| `FORMS_SUBMITS_PER_IP_HOUR` / `FORMS_PER_APP_PER_DAY` | 10 / 200 | `forms` *(plan)* |
| `DATA_MAX_DOCS_PER_APP` / `DATA_MAX_DOC_BYTES` / `DATA_MAX_BYTES_PER_APP` | 10000 / 102400 / 52428800 | `data`: records, bytes per record, bytes per app *(plan)* |
| `DATA_WRITE_RATE_LIMIT` / `DATA_WRITE_RATE_WINDOW_MS` | 120 / 60000 | `data`: writes per app per window *(plan)* |
| `DATA_WRITES_PER_PRINCIPAL_PER_MIN` | 60 | `data`: writes per minute of one signed-in user (or one visitor IP), checked before the per-app limit *(plan)* |
| `FILES_DIR` | `/data/files` | `files`: upload storage (the `files_data` volume) |
| `FILES_MAX_BYTES` / `FILES_QUOTA_PER_APP` / `FILES_UPLOAD_RATE_LIMIT` | 10 MiB / 500 MiB / 60 per min | `files` *(plan)* |
| `FILES_UPLOADS_PER_PRINCIPAL_PER_MIN` | 20 | `files`: uploads per minute of one signed-in user (or one visitor IP), checked before the per-app limit *(plan)* |
| `FILES_SWEEP_INTERVAL_MS` / `FILES_SWEEP_RETENTION_MS` | 3600000 / 86400000 | `files`: how often the sweep runs; it removes the uploads of apps deleted that long ago, temp uploads untouched that long and blobs that old no app references |
| `PROXY_ALLOWED_PORTS` / `PROXY_ALLOWED_HOSTS` | 80,443 / empty | `proxy`: upstream ports; hostnames whose private IPs may be reached (keep empty) |
| `PROXY_CONNECT_TIMEOUT_MS` / `PROXY_MAX_RESPONSE_BYTES` | 8000 / 5242880 | `proxy`: per upstream request (the size cap also holds for a decoded gzip/br body) |
| `PROXY_MAX_CONCURRENT` / `PROXY_MAX_CONCURRENT_PER_APP` | 32 / 8 | `proxy`: upstream calls in flight on the whole server / per app; over either → `429 proxy_busy` |
| `UPSTREAMS_MAX_PER_WORKSPACE` | 20 | `proxy`: upstreams one workspace may hold (existing ones over a lowered cap stay, deleting always works); `register_upstream` and the Upstreams page beyond it answer `limit_exceeded` *(plan)* |
| `UPSTREAM_REGISTRATIONS_PER_HOUR` | 20 | `proxy`: upstream registrations per workspace within the last hour, MCP and dashboard together; then `rate_limited` with `retry_after_seconds` |
| `PROXY_CALLS_PER_MIN` / `PROXY_PUBLIC_CALLS_PER_MIN_PER_IP` | 60 / 10 | `proxy`: calls per app, per IP to `public` upstreams *(plan)* |
| `SYNC_MIN_INTERVAL_MIN` / `SYNC_MAX_SOURCES_PER_APP` | 5 / 10 | `sync`: the shortest interval of a source (minutes); sources per app — `configure_module` refuses more *(plan)* |
| `SYNC_MAX_RESPONSE_BYTES` / `SYNC_MAX_RECORDS_PER_RUN` | 5242880 / 1000 | `sync`: bytes of one upstream answer a run reads (`PROXY_MAX_RESPONSE_BYTES` caps it too); records one run imports — more fails the run *(plan)* |
| `SYNC_RUNS_PER_HOUR_PER_APP` / `SYNC_NOW_PER_MINUTE` | 60 / 2 | `sync`: runs per app per hour (scheduled and by hand); runs by hand (Run now, `sync_now`) of one source per minute *(plan)* |
| `SYNC_PAUSE_AFTER_FAILURES` | 5 | `sync`: failed runs in a row after which a source pauses until the owner resumes it *(plan)* |
| `HELLO_WAVES_PER_MINUTE` | 30 | the example module `drobek-module-hello` |

### Custom domains, abuse and the gallery

| Variable | Default | What |
| --- | --- | --- |
| `DOMAINS_MAX_PER_APP` | 3 | custom domains per app, pending + verified; `0` = custom domains off *(plan)* |
| `DOMAINS_DNS_SERVERS` | the system resolver | comma-separated resolver IPs for verification |
| `DOMAINS_RECHECK_INTERVAL_MS` | 3600000 | how often the re-check sweep runs |
| `DOMAINS_DNS_MOCK` | — | dev/test only, ignored in production: `redis` answers lookups from Redis keys |
| `TERMS_URL` | `<PUBLIC_APP_URL>/terms` | linked from the 451 page of a taken-down app |
| `LANDING_URL` | — (the built-in landing page) | `<PUBLIC_APP_URL>/` answers 301 to this URL — for an operator whose website lives elsewhere |
| `DOCS_URL` | — (the Markdown files in the GitHub repository) | the base of a website with the drobek docs, each page at `<DOCS_URL>/<slug>` (`overview`, `agent`, `modules`, `self-hosting`, `architecture`, `security`, `licensing`) with a Markdown twin at `<DOCS_URL>/<slug>.md`: `/llms.txt` links the `.md` pages, `/llms-full.txt` the agent guide's `.md`, `/build-with-your-agent` and the landing page the agent guide. Not an http(s) URL (or one with a query or fragment) stops the server at start |
| `ABUSE_REPORTS_PER_IP_HOUR` | 5 | valid abuse reports per client IP per hour |
| `ABUSE_BRAND_WORDS` | a built-in list | the publish heuristic's brand words (comma-separated) |
| `GALLERY_ENABLED` | off | `true` = the [public gallery](#public-gallery): owners (and, on their explicit yes, their agents) may list published apps; `GET /api/public/gallery` answers. Off = no switch in the dashboard, the endpoint answers 404 |
| `GALLERY_API_PER_IP_MINUTE` | 60 | requests to `GET /api/public/gallery` per client IP per minute (429 over it) |
| `GALLERY_OPENS_PER_IP_HOUR` | 60 | visits through a gallery `openUrl` counted per client IP per hour (more still redirect, uncounted) |
| `GALLERY_LIKES_PER_USER_HOUR` | 30 | likes and unlikes per account per hour on `/gallery/like/<slug>` (429 over it) |
| `GALLERY_FRAME_ANCESTORS` | — (no embedding) | space-separated bare `http(s)://host[:port]` origins (at most 10) of your gallery website that may show a listed app in an `<iframe>` — added to `frame-ancestors` only on the production host (and custom domains) of an app the gallery shows, only while `GALLERY_ENABLED`; a wildcard, a path or a quote stops the server at start (see [Public gallery](#public-gallery)) |
| `DUPLICATES_PER_USER_HOUR` | 10 | copies of gallery apps one person may make per hour, from the dashboard's `/duplicate/<slug>` and the MCP tool `duplicate_app` together (see [Public gallery](#public-gallery)) |
| `PUBLISH_APPROVAL` | `open` | `open` = every workspace may publish unless a super-admin blocked it; `approval` = a workspace publishes only after a super-admin allowed it (or when a super-admin is its member) — see [Publish approval](#publish-approval). Any other value, or `approval` without `SUPERADMIN_EMAIL`, stops the server at start |
| `OPERATOR_EMAIL` | the `SUPERADMIN_EMAIL` addresses | one address: the contact a refused publish names, the recipient of approval requests and publish notifications (without it every super-admin is e-mailed and the first one is shown), and an extra recipient of abuse reports; not one e-mail address = no start |
| `PUBLISH_NOTIFY` | `off` | e-mail the operator (`OPERATOR_EMAIL`, else every super-admin) about publishes: `first` = the first publish of each app, `every` = every publish, at most one e-mail per app per hour; a super-admin's own publishes are never e-mailed. Any other value stops the server at start |

### Development and tests only

| Variable | Default | What |
| --- | --- | --- |
| `WEB_PUBLISH` / `POSTGRES_PUBLISH` / `REDIS_PUBLISH` / `MAILPIT_PUBLISH` | 3041 / 5441 / 6391 / 8025 | host ports of the dev stack |
| `WEB_PORT` | 3000 | drobek's listen port inside the dev container |
| `DATABASE_URL` / `REDIS_URL` | the dev stack on localhost *(compose: the bundled services)* | datastores; host-side for tools and tests |
| `GIT_SHA` | `dev` | the commit in `/api/version` and the footer (`task dev` and image builds set it) |
| `BASE_URL_WEB` / `BASE_URL_MCP` | `http://localhost:3041` | e2e targets |
| `TEST_ENV` | — | `local` = the e2e may use the local datastores |
| `ALLOW_DESTRUCTIVE` | — | `1` (+ a local `DATABASE_URL` host) lets the e2e global setup truncate tables |

## Backup and restore

```sh
task backup
# ✓ backups/drobek-20260923T201500Z.tar.gz — 1234567 bytes in 4 s
#   apps 12 · files 40 · assets 3 · core migrations 20 · image ghcr.io/freema/drobek:v1.2.0 (v1.2.0 abc1234)
```

One archive (mode 600, in `backups/`, override with `BACKUP_DIR=`):
`db.dump` (`pg_dump -Fc` of the whole database — one consistent snapshot),
`files.tar` (the `files_data` volume), `assets.tar` (the `assets_data`
volume), `modules.tar` (the `modules_data` volume), `caddy_data.tar`, `SHA256SUMS` and a
`manifest.json` with the image tag / id / version / commit, the checkout's
commit, a fingerprint of `DROBEK_MASTER_KEY`, row counts and the size + sha256
of every part. It runs online: postgres is started if it is not running,
nothing else is touched; the uploads and assets are archived **after** the
dump, so every file and asset row in the dump finds its bytes (only one
deleted or replaced in between can be missing — stop drobek first for a
quiesced backup). Schedule it with cron and
copy the archives off the machine:

```cron
15 3 * * * cd /opt/drobek && task backup >> /var/log/drobek-backup.log 2>&1
```

**Not in the archive:** `.env.production` — it holds `DROBEK_MASTER_KEY`,
without which the restored upstream secrets (proxy module) cannot be
decrypted. Keep a copy of it somewhere safe, separately from the backups.
Redis is not backed up (sessions, caches, rate-limit counters).

**Restore** into a stack whose database is empty — a new machine, or this one
after `docker compose … down -v`:

```sh
# on the new machine: steps 1–2 of the quickstart (the same or a newer release), then
scp old-server:/opt/drobek/.env.production /opt/drobek/.env.production   # the SAME secrets
task selfhost:init                                     # renders the Caddyfile, keeps every secret
task restore BACKUP=backups/drobek-20260923T201500Z.tar.gz
# ✓ …verified — created 2026-09-23T20:15:00Z, image ghcr.io/freema/drobek:v1.2.0 (v1.2.0 abc1234)
# ✓ restored in 25 s — /healthz {"ok":true,"db":"up","redis":"up"}
#   apps 12 · files 40 (backup: apps 12 · files 40)
```

`task restore` verifies the checksums, refuses a `DROBEK_MASTER_KEY` that does
not match the backup's fingerprint (`ALLOW_KEY_MISMATCH=1` restores anyway,
without usable upstream secrets), refuses a **non-empty database** (`FORCE=1`
drops and recreates it — back it up first), stops drobek and caddy, restores
the database, replaces `files_data`, `assets_data` (left empty when the
archive has no `assets.tar`) and `caddy_data`, and starts the stack
(`up -d --wait`). Restore with the backup's image version or a newer one
(`image_version` in `manifest.json`) — a newer image migrates the restored
database forward on start; an older one does not know its migrations. Point
the DNS records at the new machine; the restored `caddy_data` carries the
certificates over. Sessions (dashboard users and apps' end users) live in
Redis, which is not in the backup: after a restore on a new machine everyone
signs in again; API keys and OAuth clients are in the database and keep
working. A `FORCE=1` restore on the same machine leaves Redis as it is.

## Upgrades and rollback

The server applies pending migrations itself on every start (the core journal
`drizzle.__drizzle_migrations_core`, then one `__drizzle_migrations_mod_<name>`
per module). An upgrade still runs them as their own step first, so a failing
migration stops the upgrade while nothing new is serving:

```sh
cd /opt/drobek
git fetch --tags && git checkout vX.Y.Z      # the compose file + scripts of the new release
sed -i 's/^DROBEK_IMAGE_TAG=.*/DROBEK_IMAGE_TAG=vX.Y.Z/' .env.production   # pin it (or keep latest)
task selfhost:upgrade
```

`task selfhost:upgrade` is exactly:

```sh
task backup                                                   # the rollback point
docker compose --env-file .env.production -f docker-compose.production.yaml pull --ignore-buildable
docker compose --env-file .env.production -f docker-compose.production.yaml pull caddy     # (DNS-01 Caddy: build --pull caddy)
docker compose --env-file .env.production -f docker-compose.production.yaml up -d --wait postgres redis
docker compose --env-file .env.production -f docker-compose.production.yaml stop drobek
task selfhost:migrate     # the new image: applies the release's migrations, exits
task selfhost:migrate     # again: "migrations: nothing to apply (up to date)"
docker compose --env-file .env.production -f docker-compose.production.yaml up -d --wait
```

`task selfhost:migrate` is `docker compose … run --rm --no-deps -T drobek node
dist/server/migrate.js`: the server's start-up checks, then every migration,
without listening. **Running migrations twice (and every later start) is
safe:** drizzle records each applied migration in its journal table inside the
same transaction as the migration itself, so a second run finds everything
recorded and applies nothing — the second `migrate` is the proof that the
first one completed, and the `up -d` that follows migrates nothing. A
migration that fails rolls back its transaction and leaves the journal as it
was; the old container is already stopped, so fix the cause (or roll back)
before starting.

The `stop drobek` step lets the old container finish the requests in flight
first (up to `SHUTDOWN_GRACE_MS`, see [Production compose](#production-compose)).
Connected MCP clients lose their session with the old process and open a new
one once the new release serves.

**Rollback.** `previous` is the release that was `latest` before the newest
one — but it moves with the next release, so roll back to the exact version:

```sh
sed -i 's/^DROBEK_IMAGE_TAG=.*/DROBEK_IMAGE_TAG=vX.Y.W/' .env.production    # the release you came from
# the new release migrated the database? (the migrate output said "applied N")
task restore FORCE=1 BACKUP=backups/<the backup task selfhost:upgrade just took>
# it did not ("nothing to apply" on the first run too):
docker compose --env-file .env.production -f docker-compose.production.yaml up -d --wait
```

Migrations only go forward; an older image on a database migrated by a newer
one is not supported, which is why the upgrade takes a backup first.

**Check a live server end to end.** The @smoke suite drives the whole MCP loop
against a running server over public HTTP only: `list_apps`, `create_app` (or
re-use), `write_files`, the preview host, `publish` and the production host.
Give it a service identity that needs no mailbox; `--create-user` creates the
user when that e-mail never signed in:

```sh
docker compose --env-file .env.production -f docker-compose.production.yaml exec -T drobek \
  node node_modules/@drobek/oauth/dist/cli/api-key-create.js \
  --email smoke@drobek.example.com --name smoke --scopes read,write,publish --create-user
# on the operator's machine, from a checkout of the same release:
BASE_URL_WEB=https://drobek.example.com SMOKE_API_KEY=drk_… task e2e:smoke
```

The smoke key always works on one app, `smoke-<12 hex>`, derived from the key,
and publishes a new version of it on every run, so nothing piles up.

## Third-party modules

A platform module that does not ship in the image (your company's, one from
npm) is installed into the `modules_data` volume (`/data/modules` =
`DROBEK_MODULES_DIR`) — no image build, no package manager in the running
server:

```sh
task selfhost:module:add -- drobek-module-acme-erp@1.2.0
# · npm install drobek-module-acme-erp@1.2.0 → drobek-prod_modules_data:/data/modules/.staging-1a2b3c4d (node:22-alpine, --ignore-scripts)
# ✓ drobek-module-acme-erp@1.2.0 installed as the module "acmeerp" (contract ^1.1) → /data/modules/acmeerp
#   modules.lock.json: sha512-…
#
# Next: enable it in .env.production and restart drobek (it applies the module's migrations on start):
#   DROBEK_MODULES=auth,email,forms,data,proxy,files,sync,oidc,drobek-module-acme-erp
#   ./scripts/selfhost-compose.sh up -d --wait drobek
```

The spec is anything `npm install` accepts: a registry version
(`drobek-module-acme-erp@1.2.0`, `@acme/drobek-module-erp@^1`), a tarball URL
or a local `.tgz` path (`npm pack` output; mounted read-only into the npm
container), a git URL (`git+https://…/x.git#v1.2.0` — the package must have
its `dist/` committed). `add` runs in two steps:

1. **npm in a throwaway container** — `docker run --rm node:22-alpine` over
   the volume: `npm install --prefix /data/modules/.staging-<id> --omit=dev
   --omit=peer --legacy-peer-deps --ignore-scripts <spec>`;
2. **the image's own installer** — `./scripts/selfhost-compose.sh run --rm
   --no-deps drobek node node_modules/@drobek/modules/dist/cli/module-lock.js
   add …`: the package must declare `@drobek/modules` as a peer dependency
   in a range this server satisfies; nested copies of `@drobek/*`, `zod` and
   `drizzle-orm` are deleted (the server provides them); the module is
   imported once for its `name` and checked like at start (its `contract`
   against the server's module contract); it moves to `/data/modules/<name>`
   and is recorded in `modules.lock.json` with the server's
   `hashModuleTree()` — the same function checks it at every start — then
   loaded the way the server will load it, the migration lint included.
   Anything failing leaves the previous install and lockfile in place.

Then put the printed `DROBEK_MODULES` line into `.env.production` (the short
name for a `drobek-module-<name>` package, else the full package name) and
restart drobek; the start applies the module's migrations and `/api/version`
lists it with `"source":"dir"` (plus `"operatorOnly":true` for a module
without a skill, e.g. an error reporter: agents and app owners never see it,
the workspace Modules page shows it to super-admins). The script prints this
and stops: it never edits `.env.production` and never restarts anything.

```sh
task selfhost:module:list
# NAME     PACKAGE                 VERSION  CONTRACT  INTEGRITY           IN DROBEK_MODULES  STATUS
# acmeerp  drobek-module-acme-erp  1.2.0    ^1.1      sha512-q8vN0Lr2Xc…  yes                ok
task selfhost:module:remove -- acmeerp
```

`list` reads the lockfile and hashes every module again: `changed` (files
edited after the install), `missing` (a lock entry without its directory) and
`unrecorded` (a directory the lockfile does not list) refuse the start when
`DROBEK_MODULES` names them — add the module again or remove it. `remove`
deletes `/data/modules/<name>` and its lock entry and warns when
`DROBEK_MODULES` still names it (take it out before drobek restarts). **It
never touches the database:** the module's tables (`mod_<name>`,
`mod_<name>_*`) and its journal `drizzle.__drizzle_migrations_mod_<name>`
stay, so adding the module again finds its data. To drop them for good, take
a `task backup` first, list them with the query `remove` prints and `DROP
TABLE` each in `psql` (`./scripts/selfhost-compose.sh exec postgres psql -U
drobek -d drobek`).

**Upgrade** = `add` with the new version (it replaces the directory and the
lock entry; the output names the version it replaced), then restart drobek.
**Rollback** = `add` of the old version, or `task restore` of the backup taken
before (`modules_data` is part of every `task backup`, the lockfile with it).
What the script never does: run a package's install scripts, change the image,
edit `.env.production` or restart drobek. A module runs inside the server
with the whole database — install only modules you trust
([`MODULES.md` → Installing an external module](./MODULES.md#installing-an-external-module)).

### Derived image

An operator with their own CI can bake the modules into an image instead —
the same layout, lockfile and start-time checks, built by the image's own
installer:

```dockerfile
# Dockerfile.drobek — drobek + your modules
ARG DROBEK_TAG=vX.Y.Z
FROM node:22-alpine AS modules
RUN npm install --prefix /modules/.staging-erp --omit=dev --omit=peer --legacy-peer-deps \
      --ignore-scripts --no-audit --no-fund @acme/drobek-module-erp@1.2.0

FROM ghcr.io/freema/drobek:${DROBEK_TAG}
COPY --from=modules --chown=node:node /modules/ /opt/drobek-modules/
RUN node node_modules/@drobek/modules/dist/cli/module-lock.js add \
      --dir /opt/drobek-modules --staging .staging-erp --spec @acme/drobek-module-erp@1.2.0
```

One `RUN npm install` + `module-lock.js add` pair per module (the build
fails on anything `add` refuses). Build it where the stack runs (or `docker
load` it from your CI) under a local tag — `docker build -f Dockerfile.drobek
--build-arg DROBEK_TAG=vX.Y.Z -t ghcr.io/freema/drobek:vX.Y.Z-acme .` — and
set in `.env.production`: `DROBEK_IMAGE_TAG=vX.Y.Z-acme`,
`DROBEK_MODULES_DIR=/opt/drobek-modules` and the `DROBEK_MODULES` entries.
The directory is outside `/data/modules` on purpose: the compose file mounts
the `modules_data` volume there, which would hide the image's copy. A local
tag cannot be pulled, so an upgrade is a rebuild with the new `DROBEK_TAG`
followed by the `task selfhost:upgrade` steps without `pull`.
`task selfhost:module:*` refuse to run with such a `DROBEK_MODULES_DIR`: the
image is the source of its modules.

## Image tags

`ghcr.io/freema/drobek` (linux/amd64 only in v1 — no ARM image):

| Tag | What | Moves? |
| --- | --- | --- |
| `vX.Y.Z` | one release, built from the git tag `vX.Y.Z` | never |
| `latest` | the newest release (the compose default) | on every release |
| `previous` | the release `latest` pointed at before the newest one | on every release |
| `edge` | the newest `main` commit that passed CI | on every `main` push |
| `<sha>` | one commit that passed CI (`main` or a release tag) | never |

A release is a pushed `vX.Y.Z` tag: CI runs the quality gate and the e2e suite
against the image it builds from that tag (`GIT_SHA` = the tag's commit,
`VERSION` = the tag, `COMMIT_TIME` = that commit's time, all in
`/api/version`), pushes that exact image as
`vX.Y.Z`, then retags in the registry: the former `latest` → `previous`,
`vX.Y.Z` → `latest`. A pre-release tag (`vX.Y.Z-rc.1`) gets only its own tag.
To rebuild a release image yourself: `git checkout vX.Y.Z && task build` (same
sources and lockfile; the build args come from the checkout).

The same tag publishes the npm packages for module authors at its version:
`@freema/drobek-modules`, `@freema/drobek-sdk` and `create-drobek-module`
([`MODULES.md`](./MODULES.md) → Writing a module; module code imports the
first two as `@drobek/modules` / `@drobek/sdk` through npm aliases) —
`@freema/drobek-modules@X.Y.Z` is the module contract of the image `vX.Y.Z`.
`node scripts/npm-packages.mjs pack` (after `pnpm build:packages`) writes
the same tarballs into `dist-npm/`.

## TLS

The dashboard host always gets a normal ACME certificate (Let's Encrypt via
HTTP-01/TLS-ALPN — ports 80 and 443 must be reachable). The app hosts
`*.<APPS_DOMAIN>` use **exactly one** of three paths; the Caddyfile generator
picks it from the environment and refuses combinations. `task selfhost:init
TLS_MODE=<mode>` sets the variables below in `.env.production` and renders
`deployments/Caddyfile` (gitignored) with the image's generator; after editing
them by hand, re-run `task selfhost:init` and `task tls:reload`:

| `TLS_MODE=` | Set in `.env.production` | Path |
| --- | --- | --- |
| `wildcard-file` | `TLS_WILDCARD_CERT_FILE` + `TLS_WILDCARD_KEY_FILE` | (a) your wildcard certificate files |
| `dns` | `TLS_DNS_PROVIDER` (+ `TLS_DNS_PROVIDER_ARGS`, `TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN`) | (b) wildcard via ACME DNS-01 |
| `on-demand` (default for a real domain) | none of them (+ `TLS_ASK_TOKEN`) | (c) on-demand, one certificate per app host |
| `internal` (default for `localhost`) | `TLS_INTERNAL=1` | a test box: Caddy's local CA for everything |

`TLS_ACME_EMAIL` (optional) is the ACME account e-mail for expiry notices.

The generator reads `.env.production`, refuses ambiguous or invalid settings
instead of guessing, and writes a Caddyfile that contains **no secrets**: the
ask token is referenced as `{$TLS_ASK_TOKEN}` and DNS credentials as
`{env.NAME}` placeholders, both resolved from Caddy's own environment. In a
development checkout `task caddy:config` runs the same generator on the host
(Node 22 + the built `@drobek/core`) from `.env`.

### (a) Wildcard certificate files

You obtain a `*.<APPS_DOMAIN>` certificate yourself (any ACME client with
DNS-01, or a commercial CA) and renew it yourself.

```sh
task selfhost:init TLS_MODE=wildcard-file
# .env.production now has (paths INSIDE the caddy container):
#   TLS_WILDCARD_CERT_FILE=/certs/wildcard.crt
#   TLS_WILDCARD_KEY_FILE=/certs/wildcard.key
#   TLS_CERTS_DIR=./certs      (host directory mounted read-only at /certs)
```

Put the full chain in `certs/wildcard.crt` and the key in
`certs/wildcard.key`. After every renewal:

```sh
task tls:reload   # caddy reload --force: re-reads the config AND the certificate files
```

A plain `caddy reload` skips an unchanged config, so it would keep serving the
old certificate — the task passes `--force`. Hook `task tls:reload` into your
renewal tool's deploy hook. Generated app block:

```caddyfile
*.apps.example.com {
	tls /certs/wildcard.crt /certs/wildcard.key
	import drobek
}
```

### (b) DNS-01 with a Caddy DNS module

Caddy obtains and renews the wildcard itself over ACME DNS-01. That needs a
Caddy binary with a DNS provider module, which
[`deployments/Dockerfile.caddy`](../deployments/Dockerfile.caddy) builds with
`xcaddy`:

```sh
task selfhost:init TLS_MODE=dns TLS_DNS_PROVIDER=<provider> \
  CADDY_DNS_MODULE=github.com/caddy-dns/<provider>
# .env.production now has CADDY_IMAGE=drobek-caddy:dns, CADDY_BUILD_TARGET=dns,
# CADDY_DNS_MODULE, TLS_DNS_PROVIDER and TLS_DNS_PROVIDER_ARGS={env.DNS_API_TOKEN}
# (provider-specific, placeholders only)

# .env.caddy — credentials for Caddy ONLY (drobek never sees them)
DNS_API_TOKEN=…

docker compose --env-file .env.production -f docker-compose.production.yaml build caddy
```

Modules exist only for some DNS hosts — check
[github.com/caddy-dns](https://github.com/caddy-dns) first. **There is no
Hostinger DNS module**: Caddy DNS modules are built on libdns, and
`github.com/libdns/hostinger` does not exist — a zone hosted at Hostinger
cannot answer DNS-01 through Caddy directly. Use the CNAME delegation below
(or path (a)).

**Delegating `_acme-challenge` with a CNAME.** When your zone's DNS host has no
module, point the challenge name at a zone you keep at a provider that has
one, and tell Caddy to write the TXT record there:

```dns
; in the APPS_DOMAIN zone (at the provider without a module)
_acme-challenge.apps.example.com.  CNAME  _acme-challenge.acme-delegate.example.net.
```

```sh
# .env.production — the delegate zone acme-delegate.example.net is hosted at <provider>
TLS_DNS_PROVIDER=<provider>
TLS_DNS_PROVIDER_ARGS={env.DNS_API_TOKEN}
TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN=_acme-challenge.acme-delegate.example.net
```

The ACME CA follows the CNAME and finds the TXT record in the delegate zone;
the credentials only ever touch that small zone. Generated app block:

```caddyfile
*.apps.example.com {
	tls {
		dns <provider> {env.DNS_API_TOKEN}
		dns_challenge_override_domain _acme-challenge.acme-delegate.example.net
	}
	import drobek
}
```

### (c) On-demand, one certificate per app host

With no wildcard, Caddy issues a certificate for each app host at its first
TLS handshake. That is **always gated**: before every new certificate Caddy
asks drobek, and drobek says yes only for a host of an existing app (a
`--v<N>` host: only for a version the app has).
`task selfhost:init` generates `TLS_ASK_TOKEN` (for every mode) and the
compose file hands the same value to drobek and to Caddy.

```caddyfile
{
	on_demand_tls {
		ask http://drobek:3000/api/internal/tls/ask?token={$TLS_ASK_TOKEN}
	}
}
*.apps.example.com {
	tls {
		on_demand
	}
	import drobek
}
```

`GET /api/internal/tls/ask?domain=<host>&token=<TLS_ASK_TOKEN>`:

| Answer | When |
| --- | --- |
| 200 | `<slug>` or `<slug>--preview` directly under `APPS_DOMAIN`, and a live, non-deleted app owns `<slug>` |
| 200 | `<slug>--v<N>` directly under `APPS_DOMAIN`, and version N of that live app exists and compiled |
| 200 | a **verified** custom domain of a live, non-deleted app (M3-01, [Custom domains](#custom-domains)) |
| 401 | missing or wrong token (compared in constant time; also accepted as the `X-Drobek-Tls-Ask-Token` header) |
| 404 | everything else: other hosts outside `APPS_DOMAIN` (unknown or not yet verified custom domains), the dashboard host, deeper names, unknown slugs, version numbers the app does not have — and **every** request while `TLS_ASK_TOKEN` is unset (fail closed), or one that arrives on the public dashboard host |
| 503 | the database lookup failed (no certificate) |

The endpoint is internal: Caddy refuses `/api/internal/*` with 404 on every
public site, drobek answers it only on the internal address
(`drobek:3000`, never the public dashboard host), and only with the token. A
set-but-weak `TLS_ASK_TOKEN` (shorter than 32 characters or not URL-safe)
stops drobek from starting; the generator refuses on-demand mode without a
valid one.

Caveats: the first request to a new app host waits for issuance (seconds);
Let's Encrypt limits certificates per registered domain per week (see its
rate-limit documentation), and each app has up to three kinds of hosts plus
one per version URL you open — fine for a self-host with a handful of apps,
not for a busy multi-tenant instance (use (a) or (b) there). Certificates stay
cached in `caddy_data` after an app is deleted until they expire.

## Custom domains

An app can also answer on a host name its owner controls (M3-01). The owner
adds it on the app's **Domains** tab in the dashboard (editor or
workspace-admin), creates two DNS records and clicks **Verify**:

| Record | Name | Value |
| --- | --- | --- |
| `CNAME` | `shop.example.org` | `<slug>.<APPS_DOMAIN>` (e.g. `shop.apps.example.com`) |
| `TXT` | `_drobek.shop.example.org` | `drobek-verify=<token>` (shown on the Domains tab) |

- **Apex domains** (`example.org`) cannot carry a CNAME. Use the DNS
  provider's `ALIAS` / `ANAME` / CNAME flattening to `<slug>.<APPS_DOMAIN>`, or
  plain `A`/`AAAA` records with the server's addresses — verification accepts
  a name whose addresses are all addresses of `<slug>.<APPS_DOMAIN>`.
- **Refused names**: anything under `APPS_DOMAIN`, the dashboard host or
  `drobek.app`; IP literals; names that are not a registrable domain or below
  one per the Public Suffix List (`co.uk`, `github.io`); special-use TLDs
  (`.localhost`, `.local`, `.internal`, …). Names are stored in lower-case
  ASCII (IDN → punycode).
- **Limits**: `DOMAINS_MAX_PER_APP` (default 3) per app, pending and verified
  together; the next add fails with `limit_exceeded`. `0` turns custom
  domains off: the Domains tab says so and offers no add form. The limits
  provider may set it per workspace (e.g. a plan without custom domains). One host name is
  verified for at most one app on the instance — an unverified claim never
  blocks the real owner.
- **Serving**: a verified domain serves the app's published version (indexable,
  like `<slug>.<APPS_DOMAIN>`). Marking one domain **primary** makes
  `<slug>.<APPS_DOMAIN>` answer `302` to it (GET/HEAD, outside
  `/__drobek/`); preview and version hosts never redirect. A registered but
  unverified name answers `404` on the apps side; an unknown name stays the
  dashboard's.
- **Re-check**: verified domains are re-checked once every 24 h (a sweep runs
  every `DOMAINS_RECHECK_INTERVAL_MS`, default 1 h, under a Redis lease so only
  one replica does it). A definitive failure — the TXT record gone or wrong,
  the name no longer pointing at the app — drops the verification (audit
  `domain.unverify`) and e-mails the app's workspace editors and admins. A
  timeout or `SERVFAIL` never drops anything. Lookups use the system
  resolver, or `DOMAINS_DNS_SERVERS` (comma-separated IPs), 5 s per lookup.
- **Audit**: `domain.add`, `domain.verify`, `domain.unverify`,
  `domain.primary`, `domain.remove`.
- **Over MCP** an agent does the same as the Domains tab (see
  [`AGENT.md`](AGENT.md)): `list_domains`, `add_domain` (returns both
  records), `verify_domain`, `set_primary_domain` and `remove_domain` — same
  checks, limits and audit rows (actor kind `agent`). Setting or clearing the
  primary domain and removing a verified one need the user's explicit yes
  (`user_confirmed: true`). The `publish` result lists the app's verified
  domains in `domains`.

### TLS for custom domains

The generated Caddyfile carries a catch-all site for every other host name,
issued on demand behind the same ask endpoint:

```caddyfile
https:// {
	tls {
		on_demand
	}
	import drobek
}
```

drobek's ask answers `200` only for a verified domain of a live app, so an
unknown SNI never triggers an ACME order. The catch-all is **on by default in
mode (c)**; in modes (a) and (b) set `TLS_CUSTOM_DOMAINS=1` (then
`TLS_ASK_TOKEN` is required as well — the generator refuses otherwise);
`TLS_CUSTOM_DOMAINS=0` turns it off. Re-run `task selfhost:init` + `task
tls:reload` after changing it (`task caddy:config` in a development checkout).

Certificate lifecycle: Caddy obtains the certificate at the first HTTPS
request after verification (HTTP-01 on port 80 or TLS-ALPN-01 on 443 — both
must reach Caddy; the first request waits a few seconds) and renews it
itself. Removing a domain or losing its verification stops serving it and
refuses new certificates, but does **not** revoke the one already issued — it
stays in `caddy_data` until it expires. Let's Encrypt's per-domain rate
limits apply per customer domain.

Development: the dev compose file sets `DOMAINS_DNS_MOCK=redis`, which
answers the lookups from Redis keys `drobek:dns-mock:<txt|cname|a|aaaa>:<name>`
(a JSON string array; `"SERVFAIL"` simulates a transient failure) and admits
the `.test` TLD. It is ignored, with a warning, when `NODE_ENV=production`.

## Abuse and takedowns

Anyone can publish on a public drobek, so the operator (every address in
`SUPERADMIN_EMAIL`) gets a moderation queue. Nothing is blocked automatically.

- **Report pointer.** Every app host answers `GET /.well-known/drobek-report`
  with `{ report_url, app, terms_url }` — `report_url` is the public form on
  the dashboard origin, `<PUBLIC_APP_URL>/report?host=<host>`. Every app-host
  response also carries `X-Drobek-App: <slug>`, so a URL or a header in an
  abuse complaint maps to one app.
- **Report form** (`/report`, no login): host, reason (phishing, malware,
  spam, copyright, illegal, other), details (≤ 2 000 characters), an optional
  reporter e-mail and a honeypot. `ABUSE_REPORTS_PER_IP_HOUR` (default 5)
  valid reports per client IP per hour. A report is stored in
  `abuse_reports` (the reporter's IP only as a keyed hash), audited
  `abuse.report` in the app's workspace, and e-mailed to the super-admins
  and `OPERATOR_EMAIL` (each address once) — at most once per app per hour.
- **Queue** (`/admin/abuse`, super-admins only, 403 for everyone else): the
  open reports with the app and workspace behind each host.
  - **Take down** (pick a reason category): the app is unpublished and
    locked (`apps.locked_reason`). Its production, preview, version and
    custom-domain hosts answer **451** with a link to `TERMS_URL` (default
    `<PUBLIC_APP_URL>/terms`; set it when your dashboard origin has no terms
    page); module routes answer JSON 451. The agent's `write_files`,
    `restore_version`, `publish` and `configure_module` fail with
    `app_locked_by_admin` (naming the category only); new versions, publish
    and restore are refused for the dashboard too (the module-confirm API
    answers 423). The owners (editors and workspace-admins of the workspace) get an
    e-mail. Audited `admin.takedown`; the app's open reports are resolved.
  - **Restore**: the lock is lifted — the app is NOT republished, its owner
    publishes again. Owners get an e-mail; audited `admin.restore`.
  - **Mark resolved**: closes a report without acting.
- **Publish heuristic.** Every publish scans the published version (HTML +
  JS): a password field AND a word from `ABUSE_BRAND_WORDS` (comma-separated;
  unset = a built-in list of ~25 bank / payment / e-mail / social / crypto
  names plus "bank") in the `<title>`, an `<h1>`, the page text or a JS string
  files a `heuristic` report into the queue and logs
  `event: abuse_heuristic_flag` at warn. The publish itself goes through; one
  open heuristic report per app at a time.

DMCA notices and the legal side of abuse handling belong to your terms of
service, not to drobek.

## Public gallery

With `GALLERY_ENABLED=true` the server keeps a public list of apps whose
owners chose to show them. Off by default: a fresh server publishes no app
list.

- **Listing.** On an app's Overview tab (Gallery section; the Settings tab,
  where visibility and embedding live, links to it) an editor or workspace-admin of a
  **published** app ticks "Show in the gallery" and writes a public
  description (plain text, one or two sentences, at most 160 characters).
  An agent can do the same with the MCP tool `set_gallery_listing` (scope
  `publish`), but only with `user_confirmed: true` — its instructions allow
  that only after the user explicitly said yes. Viewers cannot list (403).
  Audited `app.gallery_listed` / `app.gallery_unlisted`.
- **Leaving the gallery.** Unlisting takes effect at once. Unpublishing the
  app or a takedown also ends the listing (the owner lists again after the
  next publish), and a deleted app is gone with it. The public list filters
  at query time: only apps that are listed, published, public (no password
  gate), not taken down, not deleted and not hidden appear.
- **Hiding.** A super-admin sees every listed app in the Gallery section of
  `/admin/abuse` and can **hide** an entry (or show it again). A hidden app
  is off the list and neither its owner nor an agent can list it. Audited
  `app.gallery_hidden` / `app.gallery_unhidden`.
- **Duplicates.** With "Allow duplicates" on (next to "Show in the gallery";
  off by default), your gallery website can show a Duplicate button linking
  to the item's `duplicateUrl`. A visitor signs in (and comes back), picks a
  workspace where they are an editor or higher and a name, and gets a new,
  unpublished app with the published files as version 1 — the MCP tool
  `duplicate_app` does the same. The source's module settings are proposed
  to the copy, and those that need a confirmation wait on its Modules page;
  e-mail addresses in them and proxy upstreams are dropped. Secrets, data,
  end users, uploads, app assets, domains and the listing are never copied.
  Audited `app.duplicate` (the new app) and `app.duplicated` (the source,
  without the copier). `DUPLICATES_PER_USER_HOUR` (default 10) caps copies
  per person per hour.
- **`GET /api/public/gallery`** on the dashboard host, no login. Each item
  is `{ name, description, url, publishedAt, modules, duplicable,
  duplicateUrl, duplicates, likes, opens, openUrl, likeUrl }` — `url` is the
  production host `https://<slug>.<APPS_DOMAIN>`, `modules` the names of the
  modules the app has settings for, `duplicable` whether the owner allows
  duplicates, `duplicateUrl` the dashboard page that duplicates it
  (`<PUBLIC_APP_URL>/duplicate/<slug>`, `null` when not duplicable),
  `duplicates` how many live copies were made, `likes` the number of accounts
  that like the app and `opens` the visits through `openUrl` in the last 30
  days (UTC). No owner data (no e-mail, workspace or id) and nothing about who
  liked or opened.
  Parameters:
  - `?limit=` 1–48 (default 24);
  - `?q=` a case- and accent-insensitive substring of the name or the
    description (café matches cafe; trimmed, at most 100 characters; `%`, `_`
    and `\` match themselves);
  - `?sort=new` (default: newest publish first), `?sort=name` (A→Z,
    case-insensitive) or `?sort=popular` (5 × likes + opens in the last
    30 days, highest first; ties newest first);
  - `?cursor=` the previous page's `next` (cursor mode), or `?page=` a
    1-based page number (page mode).

  Two response shapes:
  - **cursor mode** (the default; `sort=new` without `page`, or with a
    `cursor`): `{ items, next? }` — `next` is there while more entries
    follow;
  - **page mode** (`?page=` without a cursor, and always with `sort=name`
    or `sort=popular`, which ignore a cursor): `{ items, page, pages, total }` — `total` and
    `pages` count the filtered list (`pages` is 0 when nothing matches); a
    page that is not a whole number ≥ 1 is page 1, a page past the last has
    no items; `previews` is `true` when `GALLERY_FRAME_ANCESTORS` is set (the
    gallery may frame the listed apps).

  For example `?q=shift&sort=name&page=2&limit=12` →
  `{ "items": [ … ], "page": 2, "pages": 3, "total": 29 }`, and `?q=shift` →
  `{ "items": [ … ], "next": "MTc1…" }`. `Cache-Control: public,
  max-age=60`, `Access-Control-Allow-Origin: *`, `GALLERY_API_PER_IP_MINUTE`
  requests per client IP per minute. Render it on your own website — a
  server-side fetch or a reverse proxy works as well as the browser.
- **Opens.** Link a card to its `openUrl` (`/gallery/open/<slug>` on the
  dashboard host): it adds one to the app's count for the day and redirects
  to `url`. Only a `GET` counts — not `HEAD`, not a browser prefetch or
  prerender (`Sec-Purpose` / `Purpose`) and not more than
  `GALLERY_OPENS_PER_IP_HOUR` visits per client IP per hour (the redirect
  still works). The server stores a count per app and day, never who opened
  it.
- **Likes.** Link a like button to `likeUrl` (`/gallery/like/<slug>`), with
  `?back=<your gallery URL>` to return there. The page asks the visitor to
  sign in to drobek (any account), then shows the count and a "Like this
  app" / "Remove my like" button. One like per account; the public list
  shows only the count. `back` is followed only when its origin is one of
  `GALLERY_FRAME_ANCESTORS`, otherwise the page stays on drobek. At most
  `GALLERY_LIKES_PER_USER_HOUR` changes per account per hour (429 over it).
  A deleted account or app takes its likes with it.
- **Live previews.** Apps refuse to be framed by other sites
  (`frame-ancestors`). To show each listed app as a live preview (a scaled,
  sandboxed, non-interactive `<iframe>` of its `url`), set
  `GALLERY_FRAME_ANCESTORS` to your gallery website's origin(s), e.g.
  `https://www.example.com`. Those origins may then frame the **production
  host** (and custom domains) of an app the gallery shows right now —
  listed, published, public, not taken down, not deleted, not hidden. The
  preview and version hosts never allow it, and other apps keep refusing.
  Unlisting, hiding, unpublishing, a password gate or a takedown withdraws
  the permission with the next request (at the latest after the app hosts'
  60 s cache). Only while
  `GALLERY_ENABLED` is on; an invalid origin stops the server at start.
  Frame the app non-interactively (e.g. `sandbox="allow-scripts
  allow-same-origin"`, `pointer-events: none`, `loading="lazy"`): each
  preview load runs the app like any visit and counts in its request
  stats.

There are no screenshots: drobek never runs an app's code on the server.

## Publish approval

Anyone can sign up on a drobek server, create workspaces, and build and
preview apps. What goes on an app's public production host is decided in
two places:

- **The server mode**, `PUBLISH_APPROVAL`:
  - `open` (the default) — every workspace may publish.
  - `approval` — a workspace publishes only after a super-admin allowed it,
    or when a super-admin is one of its members. Needs `SUPERADMIN_EMAIL`;
    the server refuses to start without it, and on any other value.
- **Each workspace's state**, set by a super-admin: `default` (the mode
  decides), `allowed` (may publish in both modes) or `blocked` (may not
  publish in either mode). Setting one clears the other.

For one publish: a super-admin publishing is always allowed; a `blocked`
workspace is refused; an `allowed` workspace, or one with a super-admin
member, may publish; otherwise `open` allows and `approval` refuses. The
check sits in `publish()` itself, so the dashboard's Publish, an agent's
`publish` and a rollback (a publish too) share it. Previews, versions,
restore, data, secrets, domains and everything else are never gated.

**Blocking** is the switch for an `open` server: people publish without
waiting for you, and you turn a workspace off when it misuses that.

- A blocked publish changes nothing and answers `publish_blocked`:
  "Publishing from this workspace was turned off by the operator of this
  server (`<contact>`). Previews, versions and everything else keep working;
  live apps keep serving unless taken down." No approval request is sent;
  the dashboard shows "Publishing from this workspace was turned off by the
  operator (`<contact>`)." and disables the Publish buttons.
- Blocking does not unpublish anything. To remove an app, take it down (the
  publishing page lists each workspace's live apps with the takedown form of
  the [moderation queue](#abuse-and-takedowns)).
- Blocking and unblocking e-mail the workspace's editors and admins what
  happened and whom to contact (delivery errors are logged, never fatal).

**Approval** (`PUBLISH_APPROVAL=approval`):

- An unapproved publish changes nothing and answers `publish_not_approved`:
  "Publishing on this server needs approval from `<contact>` … An approval
  request was sent to `<contact>` …".
- **The approval request** is e-mailed to `OPERATOR_EMAIL` (else every
  super-admin) on the first refused publish or when a member clicks
  **Request approval** — the workspace, the requester's e-mail (also the
  Reply-To), the app and a link to `/admin/publishing`. At most one e-mail
  per workspace per 24 hours until a super-admin decides; the request is
  stored on the workspace and audited (`workspace.publish_approval_request`).
- **Owners see it**: the workspace's apps list and every app page say
  "Publishing on this server needs approval from `<contact>`" with a
  Request approval button (editor+); the Publish buttons are disabled.

The contact is `OPERATOR_EMAIL`, else the first `SUPERADMIN_EMAIL` address.
Agents see `can_publish`, `publish_contact` and the workspace's `publishing`
state in `list_apps` and `get_app`.

**Decide** at `/admin/publishing` (super-admins only; linked from
`/workspaces` and the moderation queue): every workspace with its state,
admins, apps and live apps; filters for waiting requests, default, allowed
and blocked; `?workspace=<slug>` shows one. In `open` mode **Block
publishing** / **Unblock** come first; in `approval` mode **Approve** /
**Revoke approval** / **Block publishing**. Audited
`workspace.publish_approve`, `workspace.publish_revoke`,
`workspace.publish_block` and `workspace.publish_unblock`. A super-admin's
agent can do the same with the MCP tool
`set_workspace_publishing({ workspace, publishing: default | allowed | blocked, user_confirmed })`
(`user_confirmed: true` after the super-admin's explicit yes); other users
never see that tool.

**Publish notifications** (`PUBLISH_NOTIFY`, `off` by default): `first`
e-mails `OPERATOR_EMAIL` (else every super-admin) about the first publish of
each app, `every` about every publish — at most one e-mail per app per hour.
The e-mail names the app, its live URL and custom domains, the workspace,
who published it from the dashboard or over MCP, the version and whether it
was the first publish, a republish or a rollback, with links to the app, its
dashboard page and `/admin/publishing?workspace=<slug>` (take the app down,
block the workspace). A super-admin's own publishes are not e-mailed. The
e-mail is sent after the publish and never delays or fails it.

**Abuse reports** go to every super-admin and to `OPERATOR_EMAIL` (each
address once).

Upgrading approves every workspace that already had a published app
(migration 0026), so switching to `approval` never blocks the next publish
of an app that was live then; migration 0027 adds the block.

## The rehearsal (`task selfhost:rehearsal`)

[`scripts/selfhost-rehearsal.sh`](../scripts/selfhost-rehearsal.sh) runs this
guide end to end on throwaway stacks (unique `COMPOSE_PROJECT_NAME`s, every
port on 127.0.0.1, a throwaway Mailpit as the SMTP server): it builds the
image, copies only the self-host files into a fresh directory ("machine A"),
runs `task selfhost:init` twice (idempotency) and `docker compose config`
(no warnings), starts the stack, signs a user in over the e-mail code flow,
mints an API key with the container CLI, creates + writes + publishes an app
over MCP (the official SDK client) and uploads a file through the files
module; installs a packed module with `task selfhost:module:add`, enables it
and checks `/api/version` loads it from the modules directory; then `task backup`, `down -v`, a second fresh directory ("machine B")
with only machine A's `.env.production`, `task selfhost:init`, `task
restore`, and asserts the app serves on its host, the file downloads byte for
byte, the same API key works, Caddy's restored CA still validates and the
server starts with the same `modules.lock.json` and the module; a
second restore must be refused and a second `task selfhost:migrate` must
apply nothing. It prints the wall-clock time of every phase. Not part of
`task check` or CI (it takes minutes). Knobs: `REHEARSAL_HTTPS_PORT` (9443),
`REHEARSAL_SKIP_BUILD=1`, `REHEARSAL_KEEP=1` (see the script header).

## Development: `task dev:tls`

The dev stack normally runs on plain HTTP (`task up`, `http://localhost:3041`,
`http://<slug>--preview.apps.localhost:3041`). To run it behind Caddy with its
local CA:

```sh
task dev:tls        # generates .caddy/Caddyfile.dev (TLS_INTERNAL=1), starts caddy on :443,
                    # copies Caddy's root CA to .caddy/root.crt
curl --cacert .caddy/root.crt https://localhost/healthz
curl --cacert .caddy/root.crt \
  --resolve x--preview.apps.localhost:443:127.0.0.1 https://x--preview.apps.localhost/
task dev:tls:down   # remove caddy, back to the plain HTTP dev stack
```

It layers [`docker-compose.tls.yaml`](../docker-compose.tls.yaml) over the dev
compose file: drobek switches to `PUBLIC_APP_URL=https://localhost`,
`APPS_DOMAIN=apps.localhost`, `APPS_URL_SCHEME=https` and
`TRUST_PROXY=x-real-ip`. If port 443 is taken on your machine, use
`task dev:tls DEV_TLS_PORT=8443` — every URL then carries `:8443`.

The root CA stays in the `caddy_dev_data` volume; drobek never installs it
anywhere (`skip_install_trust`). To make browsers trust it, import
`.caddy/root.crt` into your OS or browser trust store yourself — or keep using
`curl --cacert` / `NODE_EXTRA_CA_CERTS=.caddy/root.crt`.
