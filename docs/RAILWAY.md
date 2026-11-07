# Deploy drobek on Railway

The Railway template runs the same image as the
[production compose](SELF-HOSTING.md#production-compose)
(`ghcr.io/freema/drobek`) with Railway's managed Postgres and Redis. Railway
terminates TLS at its edge, so the template has no Caddy service.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/TEMPLATE_CODE?utm_medium=integration&utm_source=button&utm_campaign=drobek)

## What the template creates

| Service | Source | Notes |
| --- | --- | --- |
| `drobek` | `ghcr.io/freema/drobek:latest` | port 3000, healthcheck `/healthz`, one volume at `/data` |
| `Postgres` | Railway Postgres | reached over the private network |
| `Redis` | Railway Redis | reached over the private network |

The three data directories of drobek (`FILES_DIR=/data/files`,
`ASSETS_DIR=/data/assets`, `DROBEK_MODULES_DIR=/data/modules`) sit on the one
`/data` volume. Railway mounts volumes as root, so the template sets
`RAILWAY_RUN_UID=0`.

## Before you deploy

1. **A domain for the apps.** drobek serves every app on its own subdomain
   (`<slug>.<APPS_DOMAIN>`, `<slug>--preview.<APPS_DOMAIN>`, see
   [Hosts](SELF-HOSTING.md#hosts)). The `*.up.railway.app` domain cannot carry
   them, so you need a domain where you can add DNS records, e.g.
   `apps.example.com`.
2. **A mail transport.** drobek signs people in with e-mailed codes and does
   not start without one: a Resend API key (`EMAIL_TRANSPORT=resend`) or an
   SMTP server (`EMAIL_TRANSPORT=smtp`, `SMTP_*`). `EMAIL_FROM` must be on a
   domain verified with your provider.

## Deploy

1. Click **Deploy on Railway** and fill in the variables the template asks
   for: `APPS_DOMAIN`, `SUPERADMIN_EMAIL`, `EMAIL_FROM` and either
   `RESEND_API_KEY` or the `SMTP_*` values.
2. Wait until all three services are healthy. The first start of drobek
   applies every database migration.
3. In the `drobek` service → **Settings → Networking**, add the custom domain
   `*.<APPS_DOMAIN>` (a wildcard domain) and create the DNS records Railway
   shows for it. Optionally add a custom domain for the dashboard too and set
   `PUBLIC_APP_URL` to it.
4. Open `PUBLIC_APP_URL`, sign in with `SUPERADMIN_EMAIL` and the 6-digit code
   from the e-mail, then create an API key or connect your agent over MCP at
   `<PUBLIC_APP_URL>/mcp` (see [First sign-in](SELF-HOSTING.md)).

## Variables

| Variable | Template value | What |
| --- | --- | --- |
| `PUBLIC_APP_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | the dashboard origin (OAuth issuer, MCP at `/mcp`); change it when you add your own dashboard domain |
| `APPS_DOMAIN` | *you enter it* | apps live on `*.<APPS_DOMAIN>` (no scheme) |
| `DROBEK_MASTER_KEY` | `${{secret(64, "abcdef0123456789")}}` | envelope-encryption key for app secrets; generated once, keep it with your backups |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | private connection string of the Postgres service |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` | private connection string of the Redis service |
| `SUPERADMIN_EMAIL` | *you enter it* | your sign-in e-mail, super-admin over every workspace |
| `EMAIL_TRANSPORT` | `resend` | `resend` or `smtp` |
| `RESEND_API_KEY` | *you enter it* | with `resend` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | — | with `smtp` |
| `EMAIL_FROM` | *you enter it* | sender of sign-in codes and module mail |
| `APPS_URL_SCHEME` | `https` | apps are served over HTTPS by Railway's edge |
| `FILES_DIR` / `ASSETS_DIR` / `DROBEK_MODULES_DIR` | `/data/files` / `/data/assets` / `/data/modules` | on the `/data` volume |
| `RAILWAY_RUN_UID` | `0` | lets drobek write to the root-owned volume |
| `DROBEK_MODULES` | `auth,email,forms,data,proxy,files,sync,oidc,webhooks` | the built-in platform modules, as in the compose stack |
| `PORT` | `3000` | the port Railway routes to |

Every other variable of the [environment reference](SELF-HOSTING.md#environment-reference)
works on Railway as well; add it in the service's **Variables** tab.

## Limits on Railway

- Custom domains of individual apps (the dashboard's Domains tab) need a
  certificate per hostname; on Railway each one is added as a custom domain of
  the `drobek` service by hand.
- `task backup` and `task restore` target the compose stack. On Railway use
  Railway's volume and Postgres backups.

## Upgrades

The template follows `ghcr.io/freema/drobek:latest`. Redeploy the `drobek`
service to pull a new release, or pin a release tag (`vX.Y.Z`) in the
service's source image and change it when you upgrade
([Image tags](SELF-HOSTING.md#image-tags)).
