#!/usr/bin/env bash
# The whole Playwright suite (@smoke + @local) against the PRODUCTION image
# (M0-08) — what CI runs, reproducible locally with `task e2e:image`:
#
#   1. render the Caddyfile with the image's own caddy-config CLI (tls internal)
#   2. docker-compose.e2e.yaml up from that image, fresh volumes: postgres,
#      redis, mailpit, proxy-echo, drobek (migrates itself on start), caddy
#   3. wait for /healthz through Caddy, trust Caddy's local root CA for Node
#   4. playwright test --grep "@smoke|@local" with the guarded TRUNCATE
#      (DATABASE_URL on 127.0.0.1 — inside the global-setup allow-list)
#   5. tear the stack down (E2E_KEEP=1 keeps it for debugging)
#
# Usage: DROBEK_IMAGE=ghcr.io/freema/drobek:<tag> scripts/e2e-image.sh [playwright args…]
# Extra args replace the default --grep (e.g. `tests/mcp-loop.spec.ts`).
#
# Secrets (DROBEK_MASTER_KEY, TLS_ASK_TOKEN) are generated here per run and
# exported to docker compose only; they are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export DROBEK_IMAGE="${DROBEK_IMAGE:?DROBEK_IMAGE must be set (task e2e:image / CI set it)}"
export COMPOSE_FILE="$ROOT/docker-compose.e2e.yaml"
export COMPOSE_PROJECT_NAME="${E2E_PROJECT:-drobek-e2e}"
export E2E_TLS_PORT="${E2E_TLS_PORT:-8443}"
export E2E_POSTGRES_PORT="${E2E_POSTGRES_PORT:-5451}"
export E2E_REDIS_PORT="${E2E_REDIS_PORT:-6401}"
export E2E_MAILPIT_PORT="${E2E_MAILPIT_PORT:-8035}"

DROBEK_MASTER_KEY="$(openssl rand -hex 32)"
TLS_ASK_TOKEN="$(openssl rand -hex 32)"
export DROBEK_MASTER_KEY TLS_ASK_TOKEN

WEB="https://localhost:${E2E_TLS_PORT}"
APPS_DOMAIN="apps.localhost:${E2E_TLS_PORT}"
CA="$ROOT/.caddy/e2e-root.crt"

teardown() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "── e2e-image failed (exit $code) — last drobek + caddy logs ──" >&2
    docker compose logs --no-color --tail 150 drobek caddy >&2 || true
  fi
  if [ "${E2E_KEEP:-}" = "1" ]; then
    echo "E2E_KEEP=1 — stack left running (COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME COMPOSE_FILE=$COMPOSE_FILE)" >&2
  else
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap teardown EXIT

# 1. Caddyfile from the image's own generator (proves the CLI ships in it).
mkdir -p .caddy
docker run --rm \
  -e PUBLIC_APP_URL="$WEB" -e APPS_DOMAIN="$APPS_DOMAIN" -e TLS_INTERNAL=1 \
  "$DROBEK_IMAGE" node node_modules/@drobek/core/dist/cli/caddy-config.js > .caddy/Caddyfile.e2e

# 2. A fresh stack from the image (a clean DB → every migration runs on boot).
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --wait --wait-timeout 300

# 3. Caddy's local root CA → Node's trust store for this run only.
for _ in $(seq 1 30); do
  docker compose exec -T caddy test -f /data/caddy/pki/authorities/local/root.crt && break
  sleep 1
done
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$CA" >/dev/null
healthy=""
for _ in $(seq 1 60); do
  if body="$(curl -sf --cacert "$CA" "$WEB/healthz")"; then healthy=1; break; fi
  sleep 1
done
[ -n "$healthy" ] || { echo "✗ $WEB/healthz never went green" >&2; exit 1; }
echo "✓ $WEB/healthz → $body  (image $DROBEK_IMAGE)"
applied="$(docker compose exec -T postgres psql -U drobek -d drobek -tAc \
  'SELECT count(*) FROM drizzle.__drizzle_migrations_core')"
echo "✓ the image migrated a fresh database on start: ${applied} core migrations applied"

# 4. The suite. TEST_ENV=local + ALLOW_DESTRUCTIVE=1 → global-setup TRUNCATEs
#    the throwaway DB (host 127.0.0.1 is on its allow-list).
export BASE_URL_WEB="$WEB" BASE_URL_MCP="$WEB"
export APPS_DOMAIN APPS_URL_SCHEME=https
export TEST_ENV=local ALLOW_DESTRUCTIVE=1
export E2E_TARGET_PRODUCTION=1 E2E_IGNORE_HTTPS_ERRORS=1
export NODE_EXTRA_CA_CERTS="$CA"
export DATABASE_URL="postgresql://drobek:drobek@127.0.0.1:${E2E_POSTGRES_PORT}/drobek"
export REDIS_URL="redis://127.0.0.1:${E2E_REDIS_PORT}"
export MAILPIT_URL="http://127.0.0.1:${E2E_MAILPIT_PORT}"
unset SMOKE_API_KEY

if [ "$#" -gt 0 ]; then
  pnpm -C tests-e2e exec playwright test "$@"
else
  pnpm -C tests-e2e exec playwright test --grep "@smoke|@local"
fi
