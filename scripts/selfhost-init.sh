#!/usr/bin/env bash
# `task selfhost:init` (M4-03) — prepare a self-host checkout, non-interactively
# and idempotently:
#
#   1. .env.production from .env.production.example when absent (mode 600)
#   2. every EMPTY secret (POSTGRES_PASSWORD, DROBEK_MASTER_KEY, TLS_ASK_TOKEN)
#      ← `openssl rand -hex 32`; an existing value is never touched
#   3. hosts + TLS mode — on the first run, or when passed explicitly:
#        DOMAIN=drobek.example.com   dashboard host        (default: localhost)
#        APPS_DOMAIN=apps.example.net  app hosts *.<APPS_DOMAIN> (default: apps.<DOMAIN>)
#        TLS_MODE=on-demand|internal|wildcard-file|dns
#                     (default: internal for localhost / *.localhost, else on-demand)
#        HTTPS_PORT=443  HTTP_PORT=80  PUBLISH_IP=
#      plus, when set, SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS
#      EMAIL_FROM SUPERADMIN_EMAIL TLS_ACME_EMAIL DROBEK_IMAGE_TAG and the
#      dns/wildcard-file mode variables (CADDY_DNS_MODULE, TLS_DNS_PROVIDER, …)
#   4. deployments/Caddyfile from .env.production with the image's own
#      generator (@drobek/core caddy-config — no Node needed on the host)
#   5. `docker compose config` as a check + the next steps
#
# Re-run it after editing the TLS variables by hand (then `task tls:reload`).
# Nothing is ever printed from a secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/selfhost.sh
. "$ROOT/scripts/lib/selfhost.sh"

EXAMPLE="${ENV_EXAMPLE:-.env.production.example}"
command -v openssl >/dev/null 2>&1 || die "openssl is required (apt-get install -y openssl)"
command -v docker >/dev/null 2>&1 || die "docker is required (docs/SELF-HOSTING.md, step 1)"

created=0
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$EXAMPLE" ] || die "$EXAMPLE not found — run this from a drobek checkout"
  (umask 077 && cp "$EXAMPLE" "$ENV_FILE")
  chmod 600 "$ENV_FILE"
  created=1
  say "✓ created $ENV_FILE from $EXAMPLE (mode 600)"
  # A new env file next to an existing database volume = a password mismatch.
  project="${COMPOSE_PROJECT_NAME:-drobek-prod}"
  if docker volume inspect "${project}_pg_data" >/dev/null 2>&1; then
    say "! the volume ${project}_pg_data already exists: its postgres password is the one from the"
    say "  env file that created it — restore that .env.production instead of generating a new one."
  fi
fi

# ── 2. secrets ──────────────────────────────────────────────────────────────
for name in POSTGRES_PASSWORD DROBEK_MASTER_KEY TLS_ASK_TOKEN; do
  if is_placeholder "$(env_get "$name")"; then
    env_set "$name" "$(openssl rand -hex 32)"
    say "✓ generated $name"
  else
    say "· kept $name (already set)"
  fi
done

# ── 3. hosts + TLS mode ───────────────────────────────────────────────────────
is_local_host() { case "$1" in localhost | *.localhost) return 0 ;; *) return 1 ;; esac; }

apply_hosts=0
if [ "$created" = 1 ] || [ -n "${DOMAIN:-}" ] || [ -n "${APPS_DOMAIN:-}" ] || [ -n "${HTTPS_PORT:-}" ]; then
  apply_hosts=1
fi
if [ "$apply_hosts" = 1 ]; then
  domain="${DOMAIN:-}"
  if [ -z "$domain" ]; then
    # Keep the current dashboard host when only APPS_DOMAIN / HTTPS_PORT change.
    current="$(env_get PUBLIC_APP_URL)"
    current="${current#https://}"; current="${current%%/*}"; current="${current%%:*}"
    if [ "$created" = 1 ] || [ -z "$current" ]; then domain=localhost; else domain="$current"; fi
  fi
  case "$domain" in
    *://* | */* | *:*) die "DOMAIN must be a bare host name (drobek.example.com), got: $domain" ;;
  esac
  apps="${APPS_DOMAIN:-apps.$domain}"
  apps="${apps%%:*}"
  port="${HTTPS_PORT:-$(env_get HTTPS_PORT)}"
  port="${port:-443}"
  suffix=""
  [ "$port" = 443 ] || suffix=":$port"
  env_set PUBLIC_APP_URL "https://$domain$suffix"
  env_set APPS_DOMAIN "$apps$suffix"
  env_unset PUBLIC_ORIGIN
  if [ "$port" = 443 ]; then env_unset HTTPS_PORT; else env_set HTTPS_PORT "$port"; fi
  say "✓ dashboard https://$domain$suffix · apps https://<slug>.$apps$suffix"
fi
[ -n "${HTTP_PORT:-}" ] && env_set HTTP_PORT "$HTTP_PORT"
[ -n "${PUBLISH_IP:-}" ] && env_set PUBLISH_IP "$PUBLISH_IP"

MODE_VARS="TLS_INTERNAL TLS_WILDCARD_CERT_FILE TLS_WILDCARD_KEY_FILE TLS_CERTS_DIR CADDY_IMAGE CADDY_BUILD_TARGET CADDY_DNS_MODULE TLS_DNS_PROVIDER TLS_DNS_PROVIDER_ARGS TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN"
mode="${TLS_MODE:-}"
if [ -z "$mode" ] && [ "$created" = 1 ]; then
  host="$(env_get PUBLIC_APP_URL)"; host="${host#https://}"; host="${host%%:*}"
  if is_local_host "$host"; then mode=internal; else mode=on-demand; fi
fi
if [ -n "$mode" ]; then
  for v in $MODE_VARS; do env_unset "$v"; done
  case "$mode" in
    internal)
      env_set TLS_INTERNAL 1
      # No ACME with the local CA (the generator refuses the combination).
      env_unset TLS_ACME_EMAIL
      ;;
    on-demand) ;;
    wildcard-file)
      env_set TLS_WILDCARD_CERT_FILE "${TLS_WILDCARD_CERT_FILE:-/certs/wildcard.crt}"
      env_set TLS_WILDCARD_KEY_FILE "${TLS_WILDCARD_KEY_FILE:-/certs/wildcard.key}"
      env_set TLS_CERTS_DIR "${TLS_CERTS_DIR:-./certs}"
      ;;
    dns)
      [ -n "${TLS_DNS_PROVIDER:-}" ] || die "TLS_MODE=dns needs TLS_DNS_PROVIDER=<provider> (and CADDY_DNS_MODULE=github.com/caddy-dns/<provider>)"
      [ -n "${CADDY_DNS_MODULE:-}" ] || die "TLS_MODE=dns needs CADDY_DNS_MODULE=github.com/caddy-dns/<provider>"
      env_set CADDY_IMAGE drobek-caddy:dns
      env_set CADDY_BUILD_TARGET dns
      env_set CADDY_DNS_MODULE "$CADDY_DNS_MODULE"
      env_set TLS_DNS_PROVIDER "$TLS_DNS_PROVIDER"
      default_args='{env.DNS_API_TOKEN}'
      env_set TLS_DNS_PROVIDER_ARGS "${TLS_DNS_PROVIDER_ARGS:-$default_args}"
      [ -n "${TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN:-}" ] && env_set TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN "$TLS_DNS_CHALLENGE_OVERRIDE_DOMAIN"
      ;;
    *) die "TLS_MODE must be internal, on-demand, wildcard-file or dns (got: $mode)" ;;
  esac
  say "✓ TLS mode for the app hosts: $mode"
fi

for v in SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS EMAIL_FROM SUPERADMIN_EMAIL DROBEK_IMAGE_TAG; do
  eval "val=\${$v:-}"
  # shellcheck disable=SC2154
  [ -n "$val" ] && env_set "$v" "$val"
done
if [ -n "${TLS_ACME_EMAIL:-}" ]; then
  if [ "$(env_get TLS_INTERNAL)" = 1 ]; then say "! TLS_ACME_EMAIL ignored: TLS_INTERNAL=1 uses no ACME"
  else env_set TLS_ACME_EMAIL "$TLS_ACME_EMAIL"; fi
fi

# ── 4. Caddyfile (the image's own generator) ─────────────────────────────────
image="$(drobek_image)"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  say "· pulling $image"
  docker pull -q "$image" >/dev/null </dev/null
fi
mkdir -p deployments
tmp="$(mktemp)"
if ! docker run --rm --env-file "$ENV_FILE" "$image" \
  node node_modules/@drobek/core/dist/cli/caddy-config.js > "$tmp" </dev/null; then
  rm -f "$tmp"
  die "the Caddyfile generator refused $ENV_FILE (see above) — fix it and re-run task selfhost:init"
fi
mv "$tmp" deployments/Caddyfile
chmod 644 deployments/Caddyfile
say "✓ rendered deployments/Caddyfile ($(sed -n 's/^# TLS mode: \([a-z-]*\).*/\1/p' deployments/Caddyfile))"

# ── 5. check + next steps ────────────────────────────────────────────────────
url="$(env_get PUBLIC_APP_URL)"
apps_domain="$(env_get APPS_DOMAIN)"
if err="$(dc config -q 2>&1)" && [ -z "$err" ]; then
  ready=1
  say "✓ docker compose config: OK"
else
  ready=0
  say "! not ready to start yet — docker compose says:"
  printf '%s\n' "$err" | sed 's/^/    /' >&2
fi
missing=""
[ -n "$(env_get SMTP_HOST)" ] || missing="$missing SMTP_HOST"
[ -n "$(env_get SUPERADMIN_EMAIL)" ] || missing="$missing SUPERADMIN_EMAIL"

say ""
say "Next steps:"
n=1
if [ -n "$missing" ]; then
  say "  $n. edit $ENV_FILE:$missing (+ SMTP_USER / SMTP_PASS / EMAIL_FROM)"; n=$((n + 1))
fi
if [ "$(env_get TLS_INTERNAL)" != 1 ]; then
  say "  $n. DNS: ${url#https://} and *.$apps_domain → this server; ports 80 + 443 open"; n=$((n + 1))
fi
if [ "$(env_get CADDY_BUILD_TARGET)" = dns ]; then
  say "  $n. DNS credentials → .env.caddy, then: docker compose --env-file $ENV_FILE -f $SELFHOST_COMPOSE_FILE build caddy"; n=$((n + 1))
fi
say "  $n. docker compose --env-file $ENV_FILE -f $SELFHOST_COMPOSE_FILE up -d --wait"; n=$((n + 1))
say "  $n. open $url, sign in with your SUPERADMIN_EMAIL, connect an agent to $url/mcp"
[ "$ready" = 1 ] || exit 0
