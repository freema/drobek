# Railway template: drobek

Source of truth for the Railway template (Open Source Partner Program). The
composer settings below are entered by hand in Railway; the "Overview" section
is pasted into the publish form verbatim. User-facing guide:
[`docs/RAILWAY.md`](../../docs/RAILWAY.md).

The template is a personal instance in path routing
(`APPS_ROUTING_MODE=path`): no custom domain, no DNS, no Railway API token.
The dashboard + MCP sit on the `drobek` service's generated domain, the apps
under the `apps` service's generated domain at `/apps/<slug>/`.

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
PUBLIC_APP_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}      [Dashboard origin (OAuth issuer, MCP at /mcp).]
APPS_ROUTING_MODE=path                                [Apps live under APPS_BASE_URL/apps/<slug>/ — no own domain or DNS needed. One owner only.]
APPS_BASE_URL=https://${{apps.RAILWAY_PUBLIC_DOMAIN}}  [Apps origin: the domain of the apps service.]
DROBEK_MASTER_KEY=${{secret(64, "abcdef0123456789")}} [Encryption key for app secrets. Generated; back it up.]
DATABASE_URL=${{Postgres.DATABASE_URL}}               [Private Postgres connection string.]
REDIS_URL=${{Redis.REDIS_URL}}                        [Private Redis connection string.]
SUPERADMIN_EMAIL=                                     [Required. Your sign-in e-mail — exactly one address; the only account of this instance.]
EMAIL_TRANSPORT=resend                                [How sign-in codes are sent: resend or smtp.]
RESEND_API_KEY=                                       [Resend API key (with EMAIL_TRANSPORT=resend). Get it at resend.com/api-keys.]
EMAIL_FROM=                                           [Required. Sender of sign-in codes, on a domain verified with your mail provider, e.g. drobek <no-reply@example.com>.]
FILES_DIR=/data/files                                 [Uploads of the files module, on the /data volume.]
ASSETS_DIR=/data/assets                               [App assets, on the /data volume.]
DROBEK_MODULES_DIR=/data/modules                      [Installed platform modules, on the /data volume.]
RAILWAY_RUN_UID=0                                     [Run as root so drobek can write to the volume.]
DROBEK_MODULES=auth,email,forms,data,proxy,files,sync,oidc,webhooks [Built-in platform modules this server runs.]
PORT=3000                                             [Port Railway routes to.]
NODE_ENV=production                                   [Production mode.]
```

Not set: `APPS_DOMAIN`, `APPS_URL_SCHEME` (subdomain routing only; the server
refuses them in path mode).

Optional variables (add only with a description, leave empty): `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` for `EMAIL_TRANSPORT=smtp`.

### apps

- Source: Docker image `ghcr.io/freema/drobek:latest` (the same image)
- Custom start command: `node dist/server/apps-proxy.js`
- Public networking: HTTP, target port `3000` (generate a Railway domain)
- Healthcheck path: `/healthz` (answered by the proxy itself)
- No volume, no secrets
- Variables:

```
APPS_PROXY_TARGET=http://${{drobek.RAILWAY_PRIVATE_DOMAIN}}:3000 [drobek over the private network.]
APPS_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}                 [This service's public origin (the apps origin).]
PORT=3000                                                        [Port Railway routes to.]
```

### Postgres

Railway's Postgres database service (default settings, it brings its own volume).

### Redis

Railway's Redis database service (default settings).

## Overview (paste into the publish form)

```markdown
# Deploy and Host drobek with Railway

drobek is an open-source (AGPL-3.0) cloud workspace for agent-built web apps. Your AI agent connects over MCP, writes the files, and drobek compiles them, keeps every write as a version with its own preview URL, and publishes the app when you ask. A dashboard covers secrets, data and users.

## About Hosting drobek

drobek is one Node.js process plus Postgres and Redis. The template runs the official image `ghcr.io/freema/drobek` with Railway's managed Postgres and Redis on the private network, and a volume at `/data` for uploads, assets and installed modules. Railway's edge terminates TLS. This template is a personal instance that needs no domain of your own: the dashboard and MCP live on one Railway URL, your apps under a second one at `/apps/<slug>/`, served through a small proxy service from the same image. Sign-in works with e-mailed codes, so you need a Resend API key or an SMTP server. The database migrates itself on the first start.

## Common Use Cases

- Let Claude, Codex or any MCP client build and host small web apps for you
- Prototype personal tools with a backend (login, stored data, forms, file uploads) without writing infrastructure
- Run a private, self-hosted alternative to hosted app builders, with your data in your own Postgres

## Dependencies for drobek Hosting

- Postgres (included in the template)
- Redis (included in the template)
- A Resend API key or an SMTP server for sign-in e-mails

### Deployment Dependencies

- Image: https://github.com/freema/drobek/pkgs/container/drobek
- Self-hosting reference: https://github.com/freema/drobek/blob/main/docs/SELF-HOSTING.md
- Railway guide: https://github.com/freema/drobek/blob/main/docs/RAILWAY.md

### Implementation Details

The drobek service uses one volume at `/data` (`FILES_DIR`, `ASSETS_DIR`, `DROBEK_MODULES_DIR`), the healthcheck `/healthz`, and a generated `DROBEK_MASTER_KEY` that encrypts app secrets. The apps service runs `node dist/server/apps-proxy.js` from the same image and forwards the apps origin to drobek over the private network. `DATABASE_URL` and `REDIS_URL` are reference variables to the Postgres and Redis services. All apps share one browser origin, so the instance is for one owner; teams and own domains use the subdomain setup from the self-hosting guide.

### Why Deploy drobek on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying drobek on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
```

## Open points before publishing

- Rehearsed locally only (`task e2e:path`: same image, drobek + apps proxy + a TLS edge). Confirm on the test deploy: all four services green, the `/data` volume writable with `RAILWAY_RUN_UID=0`, `${{apps.RAILWAY_PUBLIC_DOMAIN}}` and `${{drobek.RAILWAY_PRIVATE_DOMAIN}}` resolve, an app opens at `<apps URL>/apps/<slug>/`, and a request to `<apps URL>/mcp` or `/api/…` answers 404.
- Private network: drobek listens dual-stack (`::`), so the proxy reaches `drobek.railway.internal` over IPv6 or IPv4. Check it on the test deploy.
- Client IP: the proxy passes on Railway's `X-Real-IP` (else the rightmost `X-Forwarded-For` hop); drobek's default `TRUST_PROXY` (unset) trusts it. Check that rate limits see the real client IP.
- After publishing, replace `TEMPLATE_CODE` in `docs/RAILWAY.md` with the template's code.
