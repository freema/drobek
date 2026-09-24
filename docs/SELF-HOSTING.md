# Self-hosting drobek

drobek is one image (`ghcr.io/freema/drobek`) plus Postgres, Redis and Caddy.
Caddy terminates TLS for the dashboard and for every app host, and proxies
everything to drobek on the internal network. This guide takes a clean
server to a working instance — dashboard over TLS, an agent connected over
MCP, a published app — and covers backups, upgrades and every setting.

**Measured:** the whole quickstart below (init → TLS dashboard → user → MCP →
published app with an uploaded file) took **33 s** in the
local rehearsal (`task selfhost:rehearsal`, `tls internal`, image already
built), a backup 7 s, a restore on a second "machine"
(fresh checkout + `task selfhost:init` + `task restore`) 33 s; the image build
itself 145 s (a VPS pulls it instead). Local = macOS, Docker Desktop, arm64,
2026-09-23. **The clean-VPS measurement (Ubuntu 24.04, Let's Encrypt)
is pending — Tomáš.**

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
- an SMTP account (host, port, user, password, a sender address) — sign-in
  codes go out by e-mail.

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
`env_file` for drobek). A missing secret, host or `SMTP_HOST` stops
`docker compose` before anything starts (`${VAR:?}`), and
`docker compose --env-file .env.production -f docker-compose.production.yaml config`
prints no warnings. The compose project is **`drobek-prod`** (not `drobek`,
the dev stack's name in a checkout — a `down -v` here can never reach the dev
volumes).

[`.env.production.example`](../.env.production.example) documents every
variable (what it is, how it is generated, which ones are secrets). The
compose file fixes, for drobek: `NODE_ENV=production`,
`TRUST_PROXY=x-real-ip`, `APPS_URL_SCHEME=https`, `FILES_DIR=/data/files`,
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
| `SMTP_HOST` | yes | SMTP server; `SMTP_PORT` (587), `SMTP_SECURE` (0 / 1 = implicit TLS), `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| `SUPERADMIN_EMAIL` | recommended | your sign-in e-mail(s), super-admin over every workspace |
| `TLS_*`, `CADDY_*` | per TLS path | see [TLS](#tls) |
| `HTTP_PORT`, `HTTPS_PORT`, `PUBLISH_IP` | — | published ports / bind address |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | optional Google sign-in |
| `TLS_CUSTOM_DOMAINS`, `DOMAINS_MAX_PER_APP`, `DOMAINS_DNS_SERVERS`, `DOMAINS_RECHECK_INTERVAL_MS` | — | [custom domains](#custom-domains) (catch-all certificate on by default in on-demand mode; 3 per app) |
| `TERMS_URL`, `ABUSE_REPORTS_PER_IP_HOUR`, `ABUSE_BRAND_WORDS` | — | [abuse handling](#abuse-and-takedowns) (terms link of the 451 page; 5 reports / IP / hour; publish-heuristic brand words) |
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

Platform modules (the backends apps use through `import { drobek } from
'drobek'`) are enabled with `DROBEK_MODULES` (comma-separated; a
short name `x` loads the package `drobek-module-x` from the server's
dependencies). The server applies each module's migrations on start and
refuses to start on a module it cannot load. Limits come from their env vars
or, with `LIMITS_PROVIDER_URL` + `LIMITS_PROVIDER_SECRET`, from your own
signed limits endpoint. The image ships the built-in `auth`, `email`,
`forms`, `data`, `proxy` and `files`
(`DROBEK_MODULES=auth,email,forms,data,proxy,files`, the compose default;
`forms` requires `email`). Proxy upstreams may only use ports 80 and 443
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
class pauses for `EMAIL_GLOBAL_PAUSE_MINUTES` — notifications pausing never
blocks sign-in — and the log gets an `email_global_pause` ALERT line (with
`class`) — alert on it. The contract and the
provider protocol are in [`MODULES.md`](./MODULES.md).

Volumes (named `drobek-prod_<name>`):

| Volume | Holds | In `task backup` |
| --- | --- | --- |
| `pg_data` | the database: apps, every version's files (content-addressed blobs), users, keys, module data | yes (`pg_dump -Fc`) |
| `files_data` | the files module's uploads (`/data/files`; `mod_files` rows point at them) | yes (tar) |
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
| `DROBEK_IMAGE_TAG` | `latest` | image tag of the production compose ([Image tags](#image-tags)) |
| `HTTP_PORT` / `HTTPS_PORT` / `PUBLISH_IP` | 80 / 443 / all | ports and bind address Caddy publishes |
| `TRUST_PROXY` | auto *(compose: `x-real-ip`)* | which client-IP header is trusted: `x-real-ip` = only Caddy's `X-Real-IP`; unset = `X-Real-IP`, else the rightmost `X-Forwarded-For` hop |
| `NODE_ENV` | *(compose: production)* | `production` turns on `__Host-` cookies and the fail-closed secret checks, and ignores the dev-only switches below |
| `PORT` | 3000 | the port drobek listens on inside the container (the dev compose maps `WEB_PORT` to it) |

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
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | — / 587 / 0 / — / — / — | **`SMTP_HOST` required** — the SMTP server for sign-in codes and module mail (`SMTP_SECURE=1` = implicit TLS) |
| `OTP_IP_SHORT_LIMIT` / `OTP_IP_DAILY_LIMIT` | 5 per 15 min / 20 per 24 h | dashboard sign-in codes sent per client IP |
| `OTP_EMAIL_HOURLY_LIMIT` / `OTP_EMAIL_COOLDOWN_MS` | 3 per hour / 60000 | codes per address, minimum gap per address |
| `OTP_GLOBAL_HOURLY_MAX` | 100 | codes per hour server-wide, then sending pauses |
| `OTP_VERIFY_IP_LIMIT` / `OTP_VERIFY_IP_WINDOW_S` | 30 / 900 | code checks per client IP per window (the per-code cap of 5 guesses always applies) |
| `OTP_LOGIN_DISABLED` | 0 | `1` = kill switch: no sign-in codes are sent |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | optional Google sign-in for the dashboard (redirect URI `<PUBLIC_ORIGIN>/auth/google/callback`) |
| `GOOGLE_AUTH_URL` / `GOOGLE_TOKEN_URL` / `GOOGLE_USERINFO_URL` | Google's endpoints | dev only: point Google sign-in at the mock provider (`task mock:google`) |
| `OAUTH_DCR_MAX_UNUSED_CLIENTS` | 500 | MCP clients registered by DCR that never got consent, before registration answers 503 |
| `OAUTH_CIMD_DEV_ORIGINS` | — | dev/test only, ignored in production: origins allowed to serve a Client ID Metadata Document over plain http |

### Apps, compiler and serving

| Variable | Default | What |
| --- | --- | --- |
| `COMPILE_MAX_FILES` / `COMPILE_MAX_FILE_BYTES` / `COMPILE_MAX_TOTAL_BYTES` | 200 / 524288 / 5242880 | per app version |
| `COMPILE_MAX_IMPORT_DEPTH` | 50 | depth of a relative import chain |
| `COMPILE_TIMEOUT_MS` / `COMPILE_CONCURRENCY` / `COMPILE_QUEUE_TIMEOUT_MS` | 10000 / 4 / 10000 | per build; builds at once; max queue wait (then `busy`) |
| `BEACON_RATE_LIMIT` / `BEACON_APP_RATE_LIMIT` / `BEACON_RATE_WINDOW_MS` | 60 / 600 / 60000 | browser error reports per app+IP and per app per window |
| `BEACON_MAX_EVENTS_PER_APP` / `BEACON_RETENTION_DAYS` / `BEACON_SAMPLE_RATE` | 500 / 14 / 1 | the per-app error buffer (newest N, max age) and sampling |
| `DROBEK_MIGRATE_ON_START` | 1 | `0` = the server does not apply migrations on start (tests, tooling) |
| `AUDIT_RETENTION_DAYS` | 365 | audit rows older than this are pruned daily |
| `APPS_MAX_PER_WORKSPACE` | 50 | live apps per workspace (deleted ones do not count); `create_app` beyond it answers `limit_exceeded` *(plan)* |

### Platform modules

| Variable | Default | What |
| --- | --- | --- |
| `DROBEK_MODULES` | none *(compose: `auth,email,forms,data,proxy,files`)* | the modules this server runs; `x` loads `drobek-module-x` ([`MODULES.md`](./MODULES.md)) |
| `DROBEK_MODULES_ROOT` | the server's directory | where module packages are resolved from |
| `DROBEK_SKILLS_DIR` | `./skills` (image: `/app/skills`) | the general skills `skill_info` lists |
| `LIMITS_PROVIDER_URL` / `LIMITS_PROVIDER_SECRET` | — | per-workspace limits from your own HMAC-signed endpoint (secret ≥ 32 characters) |
| `AUTH_CODES_PER_IP_15MIN` / `AUTH_CODES_PER_IP_DAY` | 5 / 20 | `auth`: sign-in codes per client IP *(plan)* |
| `AUTH_CODES_PER_EMAIL_HOUR` / `AUTH_CODES_PER_APP_HOUR` | 3 / 100 | `auth`: codes per address, per app *(plan)* |
| `AUTH_ATTEMPTS_PER_IP_15MIN` / `END_USERS_MAX_PER_APP` | 30 / 1000 | `auth`: send + verify calls per IP; end users per app *(plan)* |
| `EMAIL_PER_APP_PER_DAY` / `EMAIL_NOTIFY_ADMINS_PER_DAY` | 50 / 20 | `email`: notification mails per app per day; `notifyAdmins()` per user per day *(plan)* |
| `EMAIL_GLOBAL_HOURLY_MAX` / `EMAIL_GLOBAL_PAUSE_MINUTES` | 500 / 15 | the operator-wide cap on all module mail (recipients per hour) and the pause length |
| `EMAIL_SIGNIN_HOURLY_MAX` / `EMAIL_SIGNIN_APP_HOURLY_SHARE` | 20 % of the cap (at least 50, at most half) / 25 % | the sign-in part of the cap; one app's share of it |
| `EMAIL_APP_HOURLY_SHARE` | 25 % | one app's share of the notification part |
| `EMAIL_WORKSPACE_HOURLY_SHARE` | 50 % | one workspace's share (all its apps) of the notification and of the sign-in part; never below one app's share |
| `FORMS_SUBMITS_PER_IP_HOUR` / `FORMS_PER_APP_PER_DAY` | 10 / 200 | `forms` *(plan)* |
| `DATA_MAX_DOCS_PER_APP` / `DATA_MAX_DOC_BYTES` / `DATA_MAX_BYTES_PER_APP` | 10000 / 102400 / 52428800 | `data`: records, bytes per record, bytes per app *(plan)* |
| `DATA_WRITE_RATE_LIMIT` / `DATA_WRITE_RATE_WINDOW_MS` | 120 / 60000 | `data`: writes per app per window *(plan)* |
| `FILES_DIR` | `/data/files` | `files`: upload storage (the `files_data` volume) |
| `FILES_MAX_BYTES` / `FILES_QUOTA_PER_APP` / `FILES_UPLOAD_RATE_LIMIT` | 10 MiB / 500 MiB / 60 per min | `files` *(plan)* |
| `FILES_SWEEP_INTERVAL_MS` / `FILES_SWEEP_RETENTION_MS` | 3600000 / 86400000 | `files`: how often the sweep runs; it removes the uploads of apps deleted that long ago, temp uploads untouched that long and blobs that old no app references |
| `PROXY_ALLOWED_PORTS` / `PROXY_ALLOWED_HOSTS` | 80,443 / empty | `proxy`: upstream ports; hostnames whose private IPs may be reached (keep empty) |
| `PROXY_CONNECT_TIMEOUT_MS` / `PROXY_MAX_RESPONSE_BYTES` | 8000 / 5242880 | `proxy`: per upstream request (the size cap also holds for a decoded gzip/br body) |
| `PROXY_MAX_CONCURRENT` / `PROXY_MAX_CONCURRENT_PER_APP` | 32 / 8 | `proxy`: upstream calls in flight on the whole server / per app; over either → `429 proxy_busy` |
| `PROXY_CALLS_PER_MIN` / `PROXY_PUBLIC_CALLS_PER_MIN_PER_IP` | 60 / 10 | `proxy`: calls per app, per IP to `public` upstreams *(plan)* |
| `HELLO_WAVES_PER_MINUTE` | 30 | the example module `drobek-module-hello` |

### Custom domains and abuse

| Variable | Default | What |
| --- | --- | --- |
| `DOMAINS_MAX_PER_APP` | 3 | custom domains per app, pending + verified; `0` = custom domains off *(plan)* |
| `DOMAINS_DNS_SERVERS` | the system resolver | comma-separated resolver IPs for verification |
| `DOMAINS_RECHECK_INTERVAL_MS` | 3600000 | how often the re-check sweep runs |
| `DOMAINS_DNS_MOCK` | — | dev/test only, ignored in production: `redis` answers lookups from Redis keys |
| `TERMS_URL` | `<PUBLIC_APP_URL>/terms` | linked from the 451 page of a taken-down app |
| `ABUSE_REPORTS_PER_IP_HOUR` | 5 | valid abuse reports per client IP per hour |
| `ABUSE_BRAND_WORDS` | a built-in list | the publish heuristic's brand words (comma-separated) |

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
#   apps 12 · files 40 · core migrations 20 · image ghcr.io/freema/drobek:v1.2.0 (v1.2.0 abc1234)
```

One archive (mode 600, in `backups/`, override with `BACKUP_DIR=`):
`db.dump` (`pg_dump -Fc` of the whole database — one consistent snapshot),
`files.tar` (the `files_data` volume), `caddy_data.tar`, `SHA256SUMS` and a
`manifest.json` with the image tag / id / version / commit, the checkout's
commit, a fingerprint of `DROBEK_MASTER_KEY`, row counts and the size + sha256
of every part. It runs online: postgres is started if it is not running,
nothing else is touched; the uploads are archived **after** the dump, so every
file row in the dump finds its blob (only a file deleted in between can be
missing — stop drobek first for a quiesced backup). Schedule it with cron and
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
the database, replaces `files_data` and `caddy_data`, and starts the stack
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
`VERSION` = the tag, both in `/api/version`), pushes that exact image as
`vX.Y.Z`, then retags in the registry: the former `latest` → `previous`,
`vX.Y.Z` → `latest`. A pre-release tag (`vX.Y.Z-rc.1`) gets only its own tag.
To rebuild a release image yourself: `git checkout vX.Y.Z && task build` (same
sources and lockfile; the build args come from the checkout).

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
asks drobek, and drobek says yes only for a host of an existing app.
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
| 200 | `<slug>`, `<slug>--preview` or `<slug>--v<N>` directly under `APPS_DOMAIN`, and a live, non-deleted app owns `<slug>` (for `--v<N>` the version itself is not checked) |
| 200 | a **verified** custom domain of a live, non-deleted app (M3-01, [Custom domains](#custom-domains)) |
| 401 | missing or wrong token (compared in constant time; also accepted as the `X-Drobek-Tls-Ask-Token` header) |
| 404 | everything else: other hosts outside `APPS_DOMAIN` (unknown or not yet verified custom domains), the dashboard host, deeper names, unknown slugs — and **every** request while `TLS_ASK_TOKEN` is unset (fail closed), or one that arrives on the public dashboard host |
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
- The MCP `publish` result lists the app's verified domains in `domains`.

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
  `abuse.report` in the app's workspace, and e-mailed to the super-admins —
  at most once per app per hour.
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

## The rehearsal (`task selfhost:rehearsal`)

[`scripts/selfhost-rehearsal.sh`](../scripts/selfhost-rehearsal.sh) runs this
guide end to end on throwaway stacks (unique `COMPOSE_PROJECT_NAME`s, every
port on 127.0.0.1, a throwaway Mailpit as the SMTP server): it builds the
image, copies only the self-host files into a fresh directory ("machine A"),
runs `task selfhost:init` twice (idempotency) and `docker compose config`
(no warnings), starts the stack, signs a user in over the e-mail code flow,
mints an API key with the container CLI, creates + writes + publishes an app
over MCP (the official SDK client) and uploads a file through the files
module; then `task backup`, `down -v`, a second fresh directory ("machine B")
with only machine A's `.env.production`, `task selfhost:init`, `task
restore`, and asserts the app serves on its host, the file downloads byte for
byte, the same API key works and Caddy's restored CA still validates; a
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
