# Deploy drobek on Railway

The Railway template runs the same image as the
[production compose](SELF-HOSTING.md#production-compose)
(`ghcr.io/freema/drobek`) with Railway's managed Postgres and Redis. Railway
terminates TLS at its edge, so the template has no Caddy service.

It is a **personal instance**: one owner, no domain of your own, no DNS. The
dashboard and MCP live on one generated Railway URL, every app under a second
one ([path routing](SELF-HOSTING.md#path-routing-no-domain-of-your-own)):

| URL | What |
| --- | --- |
| `https://drobek-….up.railway.app` | dashboard, OAuth, MCP at `/mcp` |
| `https://apps-….up.railway.app/apps/<slug>/` | an app's published version |
| `https://apps-….up.railway.app/apps/<slug>--preview/` | the working copy |
| `https://apps-….up.railway.app/apps/<slug>--v<N>/` | exactly version N |

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/TEMPLATE_CODE?utm_medium=integration&utm_source=button&utm_campaign=drobek)

## What the template creates

| Service | Source | Notes |
| --- | --- | --- |
| `drobek` | `ghcr.io/freema/drobek:latest` | port 3000, healthcheck `/healthz`, one volume at `/data`, generated domain = the dashboard |
| `apps` | `ghcr.io/freema/drobek:latest`, start command `node dist/server/apps-proxy.js` | port 3000, healthcheck `/healthz`, generated domain = the apps origin; no volume, no secrets |
| `Postgres` | Railway Postgres | reached over the private network |
| `Redis` | Railway Redis | reached over the private network |

Railway gives each service exactly one generated hostname, so the second
hostname for the apps belongs to the small `apps` service. It forwards every
request to drobek over the private network with `Host` forced to the apps
host, so drobek treats it as the apps side and never as the dashboard; it
drops `X-Forwarded-Host` and `Forwarded`, passes the client IP on and runs no
app code.

The three data directories of drobek (`FILES_DIR=/data/files`,
`ASSETS_DIR=/data/assets`, `DROBEK_MODULES_DIR=/data/modules`) sit on the one
`/data` volume. Railway mounts volumes as root, so the template sets
`RAILWAY_RUN_UID=0`.

## Before you deploy

**A mail transport.** drobek signs you in with e-mailed codes and does not
start without one: a Resend API key (`EMAIL_TRANSPORT=resend`) or an SMTP
server (`EMAIL_TRANSPORT=smtp`, `SMTP_*`). `EMAIL_FROM` must be on a domain
verified with your provider.

## Deploy

1. Click **Deploy on Railway** and fill in the variables the template asks
   for: `SUPERADMIN_EMAIL` (your address — the only account of the
   instance), `EMAIL_FROM` and either `RESEND_API_KEY` or the `SMTP_*` values.
2. Wait until all four services are healthy. The first start of drobek
   applies every database migration.
3. Open the `drobek` service's URL, sign in with `SUPERADMIN_EMAIL` and the
   6-digit code from the e-mail, then create an API key or connect your agent
   over MCP at `<dashboard URL>/mcp` (see [First sign-in](SELF-HOSTING.md)).

## Variables

`drobek` service:

| Variable | Template value | What |
| --- | --- | --- |
| `PUBLIC_APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | the dashboard origin (OAuth issuer, MCP at `/mcp`) |
| `APPS_ROUTING_MODE` | `path` | apps under `APPS_BASE_URL/apps/<slug>/` |
| `APPS_BASE_URL` | `https://${{apps.RAILWAY_PUBLIC_DOMAIN}}` | the apps origin = the `apps` service's domain |
| `DROBEK_MASTER_KEY` | `${{secret(64, "abcdef0123456789")}}` | envelope-encryption key for app secrets; generated once, keep it with your backups |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | private connection string of the Postgres service |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | private connection string of the Redis service |
| `SUPERADMIN_EMAIL` | *you enter it* | your sign-in e-mail — exactly one address |
| `EMAIL_TRANSPORT` | `resend` | `resend` or `smtp` |
| `RESEND_API_KEY` | *you enter it* | with `resend` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | with `smtp` |
| `EMAIL_FROM` | *you enter it* | sender of sign-in codes and module mail |
| `FILES_DIR` / `ASSETS_DIR` / `DROBEK_MODULES_DIR` | `/data/files` / `/data/assets` / `/data/modules` | on the `/data` volume |
| `RAILWAY_RUN_UID` | `0` | lets drobek write to the root-owned volume |
| `DROBEK_MODULES` | `auth,email,forms,data,proxy,files,sync,oidc,webhooks` | the built-in platform modules, as in the compose stack |
| `PORT` | `3000` | the port Railway routes to |
| `NODE_ENV` | `production` | production mode |

`APPS_DOMAIN` and `APPS_URL_SCHEME` are not set: they belong to subdomain
routing and stop the server in path mode.

`apps` service:

| Variable | Template value | What |
| --- | --- | --- |
| `APPS_PROXY_TARGET` | `http://${{drobek.RAILWAY_PRIVATE_DOMAIN}}:3000` | drobek over the private network |
| `APPS_BASE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | this service's own public origin |
| `PORT` | `3000` | the port Railway routes to |

Every other variable of the [environment reference](SELF-HOSTING.md#environment-reference)
works on the `drobek` service as well; add it in the service's **Variables** tab.

## Limits of this setup

- **One owner.** All apps share the apps origin, so the browser does not
  isolate them from each other (one app's script can call another app's
  endpoints with that app's cookie and read its `localStorage`). drobek
  therefore allows exactly one account: only `SUPERADMIN_EMAIL` can sign in,
  invites are refused. The dashboard, MCP and OAuth stay on their own origin
  and are out of the apps' reach. Details:
  [SECURITY.md](SECURITY.md#known-limitations).
- No custom domains for apps and no Google / OIDC sign-in for app users
  (e-mail codes work); service workers are refused.
- Apps should use relative URLs (`./api`, `img/logo.png`) or
  `document.baseURI`; a client-side router reads its basename from
  `<meta name="drobek-base">`. The agent's briefing explains this.
- For a team, or apps on your own domain, deploy with subdomain routing
  instead (`APPS_DOMAIN` and a wildcard DNS record, see
  [Hosts](SELF-HOSTING.md#hosts)).
- `task backup` and `task restore` target the compose stack. On Railway use
  Railway's volume and Postgres backups.

## Upgrades

The template follows `ghcr.io/freema/drobek:latest`. Redeploy the `drobek`
and `apps` services to pull a new release, or pin a release tag (`vX.Y.Z`)
in both services' source image and change it when you upgrade
([Image tags](SELF-HOSTING.md#image-tags)).
