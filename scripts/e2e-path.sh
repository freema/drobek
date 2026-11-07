#!/usr/bin/env bash
# Path routing (APPS_ROUTING_MODE=path) end to end against the PRODUCTION
# image, in the shape of the Railway template — `task e2e:path`:
#
#   - one docker network with Postgres, Redis and Mailpit;
#   - `drobek`: the image with APPS_ROUTING_MODE=path, its dashboard + MCP on
#     https://localhost:$E2E_PATH_WEB_PORT;
#   - `apps`: the SAME image running `node dist/server/apps-proxy.js`, the apps
#     origin https://apps.localhost:$E2E_PATH_APPS_PORT, forwarding to
#     http://drobek:3000 over the private network (Host forced to the apps host);
#   - `edge`: Caddy with `tls internal` in front of both — the platform edge
#     (TLS termination, X-Forwarded-For), so the image runs in production mode
#     with its `__Host-` + Secure cookies;
#   - tests/apps-path-routing.spec.ts with E2E_PATH_ROUTING=1;
#   - everything removed at exit (E2E_KEEP=1 keeps it).
#
# A local rehearsal of the topology — not a verification on Railway itself.
# The master key is generated per run and never printed.
#
# Usage: DROBEK_IMAGE=<image> scripts/e2e-path.sh [playwright args…]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${DROBEK_IMAGE:?DROBEK_IMAGE must be set (task e2e:path sets it)}"
P="${E2E_PATH_PROJECT:-drobek-path-e2e}"
WEB_PORT="${E2E_PATH_WEB_PORT:-8461}"
APPS_PORT="${E2E_PATH_APPS_PORT:-8462}"
PG_PORT="${E2E_PATH_POSTGRES_PORT:-5461}"
REDIS_PORT="${E2E_PATH_REDIS_PORT:-6411}"
MAIL_PORT="${E2E_PATH_MAILPIT_PORT:-8045}"
OWNER="${E2E_OWNER_EMAIL:-owner@drobek.test}"
NET="$P-net"
CADDY_DIR=""

cleanup() {
  if [ "${E2E_KEEP:-}" = "1" ]; then
    echo "E2E_KEEP=1: leaving $P-* running (docker rm -f $P-edge $P-drobek $P-apps $P-postgres $P-redis $P-mailpit; docker network rm $NET)"
    return
  fi
  docker rm -f "$P-edge" "$P-apps" "$P-drobek" "$P-postgres" "$P-redis" "$P-mailpit" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [ -n "${CADDY_DIR:-}" ] && rm -rf "$CADDY_DIR"
  return 0
}
trap cleanup EXIT
cleanup
E2E_KEEP_SAVED="${E2E_KEEP:-}"

docker network create "$NET" >/dev/null
docker run -d --name "$P-postgres" --network "$NET" --network-alias postgres -p "$PG_PORT:5432" \
  -e POSTGRES_USER=drobek -e POSTGRES_PASSWORD=drobek -e POSTGRES_DB=drobek postgres:17-alpine >/dev/null
docker run -d --name "$P-redis" --network "$NET" --network-alias redis -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null
docker run -d --name "$P-mailpit" --network "$NET" --network-alias mailpit -p "$MAIL_PORT:8025" axllent/mailpit >/dev/null

until docker exec "$P-postgres" pg_isready -U drobek -d drobek >/dev/null 2>&1; do sleep 1; done

MASTER_KEY="$(openssl rand -hex 32)"
docker run -d --name "$P-drobek" --network "$NET" --network-alias drobek \
  -e NODE_ENV=production -e PORT=3000 \
  -e PUBLIC_APP_URL="https://localhost:$WEB_PORT" \
  -e APPS_ROUTING_MODE=path \
  -e APPS_BASE_URL="https://apps.localhost:$APPS_PORT" \
  -e DATABASE_URL=postgresql://drobek:drobek@postgres:5432/drobek \
  -e REDIS_URL=redis://redis:6379 \
  -e DROBEK_MASTER_KEY="$MASTER_KEY" \
  -e SUPERADMIN_EMAIL="$OWNER" \
  -e EMAIL_TRANSPORT=smtp -e SMTP_HOST=mailpit -e SMTP_PORT=1025 -e SMTP_SECURE=0 \
  -e EMAIL_FROM='drobek <no-reply@drobek.test>' \
  -e FILES_DIR=/data/files -e ASSETS_DIR=/data/assets -e DROBEK_MODULES_DIR=/data/modules \
  -e DROBEK_MODULES=auth,email,forms,data,proxy,files,sync,oidc,webhooks \
  -e OTP_VERIFY_IP_LIMIT=500 -e OTP_IP_SHORT_LIMIT=300 -e OTP_IP_DAILY_LIMIT=500 \
  -e AUTH_CODES_PER_IP_15MIN=300 -e AUTH_ATTEMPTS_PER_IP_15MIN=500 \
  "$IMAGE" >/dev/null
unset MASTER_KEY

docker run -d --name "$P-apps" --network "$NET" --network-alias apps \
  -e PORT=3000 \
  -e APPS_PROXY_TARGET=http://drobek:3000 \
  -e APPS_BASE_URL="https://apps.localhost:$APPS_PORT" \
  "$IMAGE" node dist/server/apps-proxy.js >/dev/null

CADDY_DIR="$(mktemp -d)"
cat > "$CADDY_DIR/Caddyfile" <<CADDY
{
	local_certs
	skip_install_trust
	auto_https disable_redirects
}
https://localhost:$WEB_PORT {
	tls internal
	reverse_proxy drobek:3000
}
https://apps.localhost:$APPS_PORT {
	tls internal
	reverse_proxy apps:3000
}
CADDY
docker run -d --name "$P-edge" --network "$NET" -p "$WEB_PORT:$WEB_PORT" -p "$APPS_PORT:$APPS_PORT" \
  -v "$CADDY_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine >/dev/null

echo "waiting for drobek (https://localhost:$WEB_PORT/healthz) and the apps proxy (https://apps.localhost:$APPS_PORT/healthz)…"
for i in $(seq 1 120); do
  if curl -kfsS "https://localhost:$WEB_PORT/healthz" >/dev/null 2>&1 && curl -kfsS --resolve "apps.localhost:$APPS_PORT:127.0.0.1" "https://apps.localhost:$APPS_PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" = 120 ]; then
    docker logs --tail 80 "$P-drobek" || true
    docker logs --tail 20 "$P-apps" || true
    echo "drobek did not become healthy" >&2
    exit 1
  fi
  sleep 1
done

E2E_KEEP="$E2E_KEEP_SAVED" \
BASE_URL_WEB="https://localhost:$WEB_PORT" \
BASE_URL_MCP="https://localhost:$WEB_PORT" \
E2E_IGNORE_HTTPS_ERRORS=1 \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
TEST_ENV=local \
DATABASE_URL="postgresql://drobek:drobek@127.0.0.1:$PG_PORT/drobek" \
REDIS_URL="redis://127.0.0.1:$REDIS_PORT" \
MAILPIT_URL="http://localhost:$MAIL_PORT" \
E2E_PATH_ROUTING=1 \
E2E_APPS_BASE_URL="https://apps.localhost:$APPS_PORT" \
E2E_OWNER_EMAIL="$OWNER" \
  pnpm -C tests-e2e exec playwright test tests/apps-path-routing.spec.ts --project legacy "$@"
