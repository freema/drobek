# Self-hosting drobek

drobek is one image (`ghcr.io/freema/drobek`) plus Postgres, Redis and Caddy.
Caddy terminates TLS for the dashboard and for every app host, and proxies
everything to drobek on the internal network.

> The full self-host guide (backups, upgrades, limits, a clean-VPS
> walkthrough) arrives with M4. This document covers the production compose
> file and **TLS** (M0-07).

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
drobek, postgres, redis and caddy. Only Caddy publishes ports (80, 443,
443/udp); drobek, postgres and redis stay on the internal network. Nothing
secret is written in the file — values come from `.env` next to it.

```sh
cp .env.example .env     # then fill in (at least):
#   POSTGRES_PASSWORD   openssl rand -hex 24
#   DROBEK_MASTER_KEY   openssl rand -hex 32
#   PUBLIC_APP_URL      https://drobek.example.com
#   APPS_DOMAIN         apps.example.com
#   SMTP_*, EMAIL_FROM, SUPERADMIN_EMAIL
#   + the TLS variables of ONE path below
task caddy:config        # → deployments/Caddyfile (gitignored)
docker compose -f docker-compose.production.yaml up -d --wait
```

`task caddy:config` needs Node 22 and the built `@drobek/core` package on the
machine that runs it (`pnpm install && pnpm --filter @drobek/core build` in a
checkout; the task builds it when it is missing). It reads `.env`, refuses
ambiguous or invalid settings instead of guessing, and writes a Caddyfile that
contains **no secrets**: the ask token is referenced as `{$TLS_ASK_TOKEN}`
and DNS credentials as `{env.NAME}` placeholders, both resolved from Caddy's
own environment. Re-run it after every TLS-related `.env` change, then
`task tls:reload`.

The compose file sets `TRUST_PROXY=x-real-ip` for drobek: behind Caddy the
client IP (every per-IP rate limit) comes only from the `X-Real-IP` header
Caddy sets from the TCP peer — a client-sent `X-Real-IP` or
`X-Forwarded-For` is overwritten/ignored. Leave `TRUST_PROXY` unset only when
a different proxy (e.g. nginx with `X-Real-IP $remote_addr`) is in front.

Platform modules (the backends apps use through `import { drobek } from
'drobek'`) are enabled with `DROBEK_MODULES` in `.env` (comma-separated; a
short name `x` loads the package `drobek-module-x` from the server's
dependencies). The server applies each module's migrations on start and
refuses to start on a module it cannot load. Limits come from their env vars
or, with `LIMITS_PROVIDER_URL` + `LIMITS_PROVIDER_SECRET`, from your own
signed limits endpoint. The image ships the built-in `auth`, `email`,
`forms`, `data`, `proxy` and `files`
(`DROBEK_MODULES=auth,email,forms,data,proxy,files`; `forms` requires
`email`). Proxy upstreams may only use ports 80 and 443
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
(default 20 % of the cap, at least 50, at most half — 100 of 500);
notifications (forms, `notifyAdmins`) get the rest, and one app at most
`EMAIL_APP_HOURLY_SHARE` percent of that (default 25). Past its budget a
class pauses for `EMAIL_GLOBAL_PAUSE_MINUTES` — notifications pausing never
blocks sign-in — and the log gets an `email_global_pause` ALERT line (with
`class`) — alert on it. The contract and the
provider protocol are in [`MODULES.md`](./MODULES.md).

Volumes: `postgres_data`, `redis_data`, `caddy_data` (ACME account, issued
certificates, Caddy's local CA — back it up; losing it means re-issuing every
certificate), `caddy_config` and `files_data` (the files module's uploads —
back it up together with the database: `mod_files` rows point at its files).

## TLS

The dashboard host always gets a normal ACME certificate (Let's Encrypt via
HTTP-01/TLS-ALPN — ports 80 and 443 must be reachable). The app hosts
`*.<APPS_DOMAIN>` use **exactly one** of three paths; the Caddyfile generator
picks it from the environment and refuses combinations:

| Set in `.env` | Path |
| --- | --- |
| `TLS_WILDCARD_CERT_FILE` + `TLS_WILDCARD_KEY_FILE` | (a) your wildcard certificate files |
| `TLS_DNS_PROVIDER` (+ `TLS_DNS_PROVIDER_ARGS`, `TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN`) | (b) wildcard via ACME DNS-01 |
| none of them (+ `TLS_ASK_TOKEN`) | (c) on-demand, one certificate per app host |
| `TLS_INTERNAL=1` | development only: Caddy's local CA for everything |

`TLS_ACME_EMAIL` (optional) is the ACME account e-mail for expiry notices.

### (a) Wildcard certificate files

You obtain a `*.<APPS_DOMAIN>` certificate yourself (any ACME client with
DNS-01, or a commercial CA) and renew it yourself.

```sh
# .env
TLS_WILDCARD_CERT_FILE=/certs/wildcard.crt   # paths INSIDE the caddy container
TLS_WILDCARD_KEY_FILE=/certs/wildcard.key
TLS_CERTS_DIR=./certs                        # host directory mounted read-only at /certs
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
# .env
CADDY_BUILD_TARGET=dns
CADDY_DNS_MODULE=github.com/caddy-dns/<provider>
TLS_DNS_PROVIDER=<provider>
TLS_DNS_PROVIDER_ARGS={env.DNS_API_TOKEN}     # provider-specific, placeholders only
TLS_ACME_EMAIL=ops@example.com

# .env.caddy — credentials for Caddy ONLY (drobek never sees them)
DNS_API_TOKEN=…

docker compose -f docker-compose.production.yaml build caddy
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
# .env — the delegate zone acme-delegate.example.net is hosted at <provider>
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

```sh
# .env — the same value reaches drobek (env_file) and caddy (environment)
TLS_ASK_TOKEN=<paste the output of: openssl rand -hex 32>
TLS_ACME_EMAIL=ops@example.com
```

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

### Development: `task dev:tls`

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
  together; the next add fails with `limit_exceeded`. One host name is
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
`TLS_CUSTOM_DOMAINS=0` turns it off. Re-run `task caddy:config` after changing
it.

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
