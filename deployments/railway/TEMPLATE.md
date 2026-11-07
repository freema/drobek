# Railway template: drobek

Source of truth for the Railway template (Open Source Partner Program). The
composer settings below are entered by hand in Railway; the "Overview" section
is pasted into the publish form verbatim. User-facing guide:
[`docs/RAILWAY.md`](../../docs/RAILWAY.md).

## Template metadata

- **Name:** drobek
- **Short description:** Cloud workspace for agent-built web apps: your agent connects over MCP, drobek compiles, versions and publishes the apps.
- **Category:** AI/ML
- **Icon:** `docs/assets/drobek.svg` (1:1, transparent background; export a 512×512 PNG if the form refuses SVG)
- **Workspace (author):** Tomáš Grasl

## Services

### drobek

- Source: Docker image `ghcr.io/freema/drobek:latest`
- Public networking: HTTP, target port `3000` (generate a Railway domain)
- Healthcheck path: `/healthz`
- Volume: mount path `/data`
- Variables (description in brackets is what the composer shows):

```
PUBLIC_APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}      [Dashboard origin (OAuth issuer, MCP at /mcp). Change it if you add your own dashboard domain.]
APPS_DOMAIN=                                          [Required. Apps are served on *.<APPS_DOMAIN>, e.g. apps.example.com (no scheme). Add *.<APPS_DOMAIN> as a custom domain of this service after deploy.]
DROBEK_MASTER_KEY=${{secret(64, "abcdef0123456789")}} [Encryption key for app secrets. Generated; back it up.]
DATABASE_URL=${{Postgres.DATABASE_URL}}               [Private Postgres connection string.]
REDIS_URL=${{Redis.REDIS_URL}}                        [Private Redis connection string.]
SUPERADMIN_EMAIL=                                     [Required. Your sign-in e-mail; super-admin over every workspace.]
EMAIL_TRANSPORT=resend                                [How sign-in codes are sent: resend or smtp.]
RESEND_API_KEY=                                       [Resend API key (with EMAIL_TRANSPORT=resend). Get it at resend.com/api-keys.]
EMAIL_FROM=                                           [Required. Sender of sign-in codes, on a domain verified with your mail provider, e.g. drobek <no-reply@example.com>.]
APPS_URL_SCHEME=https                                 [Apps are served over HTTPS by Railway's edge.]
FILES_DIR=/data/files                                 [Uploads of the files module, on the /data volume.]
ASSETS_DIR=/data/assets                               [App assets, on the /data volume.]
DROBEK_MODULES_DIR=/data/modules                      [Installed platform modules, on the /data volume.]
RAILWAY_RUN_UID=0                                     [Run as root so drobek can write to the volume.]
DROBEK_MODULES=auth,email,forms,data,proxy,files,sync,oidc,webhooks [Built-in platform modules this server runs.]
PORT=3000                                             [Port Railway routes to.]
NODE_ENV=production                                   [Production mode.]
```

Optional variables (add only with a description, leave empty): `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` for `EMAIL_TRANSPORT=smtp`.

### Postgres

Railway's Postgres database service (default settings, it brings its own volume).

### Redis

Railway's Redis database service (default settings).

## Overview (paste into the publish form)

```markdown
# Deploy and Host drobek with Railway

drobek is an open-source (AGPL-3.0) cloud workspace for agent-built web apps. Your AI agent connects over MCP, writes the files, and drobek compiles them, keeps every write as a version with its own preview URL, and publishes the app when you ask. A dashboard covers secrets, domains, data and users.

## About Hosting drobek

drobek is one Node.js process plus Postgres and Redis. The template runs the official image `ghcr.io/freema/drobek` with Railway's managed Postgres and Redis on the private network, and a volume at `/data` for uploads, assets and installed modules. Railway's edge terminates TLS. Every app lives on its own subdomain of `APPS_DOMAIN`, so after the deploy you add the wildcard domain `*.<APPS_DOMAIN>` to the drobek service. Sign-in works with e-mailed codes, so you also need a Resend API key or an SMTP server. The database migrates itself on the first start.

## Common Use Cases

- Let Claude, Codex or any MCP client build and host small web apps for you and your team
- Prototype internal tools with a backend (login, stored data, forms, file uploads) without writing infrastructure
- Run a private, self-hosted alternative to hosted app builders, with your data in your own Postgres

## Dependencies for drobek Hosting

- Postgres (included in the template)
- Redis (included in the template)
- A domain with a wildcard DNS record for the apps
- A Resend API key or an SMTP server for sign-in e-mails

### Deployment Dependencies

- Image: https://github.com/freema/drobek/pkgs/container/drobek
- Self-hosting reference: https://github.com/freema/drobek/blob/main/docs/SELF-HOSTING.md
- Railway guide: https://github.com/freema/drobek/blob/main/docs/RAILWAY.md

### Implementation Details

The drobek service uses one volume at `/data` (`FILES_DIR`, `ASSETS_DIR`, `DROBEK_MODULES_DIR`), the healthcheck `/healthz`, and a generated `DROBEK_MASTER_KEY` that encrypts app secrets. `DATABASE_URL` and `REDIS_URL` are reference variables to the Postgres and Redis services.

### Why Deploy drobek on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying drobek on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
```

## Open points before publishing

- Confirm on the test deploy: the `/data` volume is writable with `RAILWAY_RUN_UID=0`, `/healthz` turns green, and a wildcard custom domain on the service serves `<slug>.<APPS_DOMAIN>`.
- Client IP: drobek's default `TRUST_PROXY` (unset) trusts `X-Real-IP`, else the rightmost `X-Forwarded-For` hop. Check on the test deploy that rate limits see the real client IP.
- After publishing, replace `TEMPLATE_CODE` in `docs/RAILWAY.md` with the template's code.
