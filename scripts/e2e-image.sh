#!/usr/bin/env bash
# The whole Playwright suite (@smoke + @local) against the PRODUCTION image
# — what CI runs, reproducible locally with `task e2e:image`:
#
#   1. render the Caddyfile with the image's own caddy-config CLI (tls internal)
#      and add the site of the mock IdP (idp.localhost for the browser,
#      idp.e2e.internal for drobek → the oidc-mock service)
#   2. a fresh docker-compose.e2e.yaml stack, caddy and dns-mock first:
#      Caddy's local root CA goes to .caddy/e2e-root.crt (trusted by drobek and
#      Node), dns-mock's address to drobek's DOMAINS_DNS_SERVERS
#   3. pack examples/drobek-module-acme-crm and the operator-only fixture
#      tests-e2e/fixtures/drobek-module-ops-probe and install both into the
#      fresh modules_data volume with scripts/selfhost-module.sh (task
#      selfhost:module:add); then the rest from that image: postgres, redis,
#      mailpit, proxy-echo, oidc-mock and drobek (migrates itself on start);
#      wait for /healthz through Caddy
#   4. phase 1: playwright test --grep "@smoke|@local" with the guarded
#      TRUNCATE (DATABASE_URL on 127.0.0.1 — inside the global-setup allow-list)
#   5. phase 2: drobek recreated with EMAIL_TRANSPORT=relay and
#      PUBLISH_APPROVAL=approval, then the specs that need that configuration
#      (PHASE2_SPECS below)
#   6. the skip guard (scripts/e2e-skip-guard.mjs): every test of the suite
#      ran in at least one phase, or the run fails
#   7. tear the stack down (E2E_KEEP=1 keeps it for debugging)
#
# Usage: DROBEK_IMAGE=ghcr.io/freema/drobek:<tag> scripts/e2e-image.sh [playwright args…]
# Extra args replace the phases and the guard with ONE run of those args
# (e.g. `tests/mcp-loop.spec.ts`); E2E_PHASE=2 starts drobek in the phase-2
# configuration for it. Reports per phase: tests-e2e/playwright-report/<phase>
# and tests-e2e/test-results/<phase>.
#
# Secrets (DROBEK_MASTER_KEY, TLS_ASK_TOKEN, LIMITS_PROVIDER_SECRET) are
# generated here per run and exported to docker compose only (the module
# installer reads them from a 0600 file in a temp dir removed at exit); they
# are never printed.
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
export E2E_DROBEK_PORT="${E2E_DROBEK_PORT:-3451}"
export E2E_DNS_SERVER=""
unset E2E_EMAIL_TRANSPORT E2E_PUBLISH_APPROVAL

PHASE2_SPECS=(tests/email-transport.spec.ts tests/publish-approval.spec.ts)
phase2_config() {
  export E2E_EMAIL_TRANSPORT=relay E2E_PUBLISH_APPROVAL=approval
}

DROBEK_MASTER_KEY="$(openssl rand -hex 32)"
TLS_ASK_TOKEN="$(openssl rand -hex 32)"
LIMITS_PROVIDER_SECRET="$(openssl rand -hex 32)"
export DROBEK_MASTER_KEY TLS_ASK_TOKEN LIMITS_PROVIDER_SECRET

WEB="https://localhost:${E2E_TLS_PORT}"
APPS_DOMAIN="apps.localhost:${E2E_TLS_PORT}"
CA="$ROOT/.caddy/e2e-root.crt"
WORK="$(mktemp -d)"

teardown() {
  local code=$?
  rm -rf "$WORK"
  if [ "$code" -ne 0 ]; then
    echo "── e2e-image failed (exit $code) — last drobek, caddy and e2e helper logs ──" >&2
    docker compose logs --no-color --tail 150 drobek caddy >&2 || true
    docker compose logs --no-color --tail 30 oidc-mock dns-mock >&2 || true
  fi
  if [ "${E2E_KEEP:-}" = "1" ]; then
    echo "E2E_KEEP=1 — stack left running (COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME COMPOSE_FILE=$COMPOSE_FILE)" >&2
  else
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap teardown EXIT

wait_healthz() {
  local body=""
  for _ in $(seq 1 90); do
    if body="$(curl -sf --cacert "$CA" "$WEB/healthz")"; then
      echo "✓ $WEB/healthz → $body  (image $DROBEK_IMAGE)"
      return 0
    fi
    sleep 1
  done
  echo "✗ $WEB/healthz never went green" >&2
  return 1
}

# One Playwright run: its own JSON report (for the guard), HTML report and output dir.
run_phase() {
  local name="$1" start=$SECONDS code=0
  shift
  echo "── $name: playwright test $* ──"
  PLAYWRIGHT_JSON_OUTPUT_FILE="$WORK/$name.json" \
    PLAYWRIGHT_HTML_OUTPUT_DIR="$ROOT/tests-e2e/playwright-report/$name" \
    pnpm -C tests-e2e exec playwright test --output "$ROOT/tests-e2e/test-results/$name" "$@" || code=$?
  echo "── $name: exit $code after $((SECONDS - start)) s ──"
  return "$code"
}

# 0. The guard checks itself, and lists every test of the suite (no stack needed).
if [ "$#" -eq 0 ]; then
  node scripts/e2e-skip-guard.mjs --self-check
  PLAYWRIGHT_JSON_OUTPUT_FILE="$WORK/listed.json" pnpm -C tests-e2e exec playwright test --list --reporter=json >/dev/null
fi

# 1. Caddyfile from the image's own generator (proves the CLI ships in it),
#    plus the e2e-only site of the mock IdP.
mkdir -p .caddy
docker run --rm \
  -e PUBLIC_APP_URL="$WEB" -e APPS_DOMAIN="$APPS_DOMAIN" -e TLS_INTERNAL=1 \
  "$DROBEK_IMAGE" node node_modules/@drobek/core/dist/cli/caddy-config.js > .caddy/Caddyfile.e2e
cat >> .caddy/Caddyfile.e2e <<EOF

# e2e only: the mock OpenID Connect provider (tests-e2e/mock-oidc.mjs) over https.
idp.localhost:${E2E_TLS_PORT}, idp.e2e.internal:${E2E_TLS_PORT} {
	tls internal
	reverse_proxy oidc-mock:3050
}
EOF

# 2. A fresh stack, Caddy and dns-mock first: every drobek container (the
#    module installer's too) starts with Caddy's local root CA in its trust
#    store (the IdP is https behind Caddy) and dns-mock's address as its
#    nameserver. The same CA goes to Node's trust store for this run only.
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --wait --wait-timeout 120 caddy dns-mock
for _ in $(seq 1 30); do
  docker compose exec -T caddy test -f /data/caddy/pki/authorities/local/root.crt && break
  sleep 1
done
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$CA" >/dev/null
chmod 644 "$CA"
E2E_DNS_SERVER="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$(docker compose ps -q dns-mock)")"
[ -n "$E2E_DNS_SERVER" ] || { echo "✗ dns-mock has no address" >&2; exit 1; }

# 3. The rest from the image (a clean DB → every migration runs on boot), with
#    the external example module and the operator-only fixture installed the
#    way an operator installs one: packed, then `task selfhost:module:add`
#    over this stack's modules_data volume (DROBEK_MODULES in
#    docker-compose.e2e.yaml lists both).
pnpm --filter drobek-module-acme-crm pack --pack-destination "$WORK" >/dev/null
MODULE_TGZ="$(ls "$WORK"/drobek-module-acme-crm-*.tgz)"
npm pack --loglevel=warn ./tests-e2e/fixtures/drobek-module-ops-probe --pack-destination "$WORK" >/dev/null
FIXTURE_TGZ="$(ls "$WORK"/drobek-module-ops-probe-*.tgz)"
MODULE_ENV="$WORK/module.env"
(umask 077 && printf 'DROBEK_IMAGE=%s\nDROBEK_MASTER_KEY=%s\nTLS_ASK_TOKEN=%s\nLIMITS_PROVIDER_SECRET=%s\n' "$DROBEK_IMAGE" "$DROBEK_MASTER_KEY" "$TLS_ASK_TOKEN" "$LIMITS_PROVIDER_SECRET" > "$MODULE_ENV")
export E2E_MODULE_REINSTALL="ENV_FILE='$MODULE_ENV' SELFHOST_COMPOSE_FILE='$COMPOSE_FILE' ./scripts/selfhost-module.sh add '$MODULE_TGZ'"
sh -c "$E2E_MODULE_REINSTALL"
ENV_FILE="$MODULE_ENV" SELFHOST_COMPOSE_FILE="$COMPOSE_FILE" ./scripts/selfhost-module.sh add "$FIXTURE_TGZ"
if [ "${E2E_PHASE:-1}" = "2" ]; then phase2_config; fi
docker compose up -d --wait --wait-timeout 300
wait_healthz
applied="$(docker compose exec -T postgres psql -U drobek -d drobek -tAc \
  'SELECT count(*) FROM drizzle.__drizzle_migrations_core')"
echo "✓ the image migrated a fresh database on start: ${applied} core migrations applied"

# 4.–6. The suite. TEST_ENV=local + ALLOW_DESTRUCTIVE=1 → global-setup
#    TRUNCATEs the throwaway DB (host 127.0.0.1 is on its allow-list).
export BASE_URL_WEB="$WEB" BASE_URL_MCP="$WEB"
export APPS_DOMAIN APPS_URL_SCHEME=https
export TEST_ENV=local ALLOW_DESTRUCTIVE=1
export E2E_TARGET_PRODUCTION=1 E2E_IGNORE_HTTPS_ERRORS=1
export E2E_DROBEK_URL="http://127.0.0.1:${E2E_DROBEK_PORT}"
export MOCK_OIDC_ISSUER="https://idp.e2e.internal:${E2E_TLS_PORT}" MOCK_OIDC_BROWSER_URL="https://idp.localhost:${E2E_TLS_PORT}"
export NODE_EXTRA_CA_CERTS="$CA"
export DATABASE_URL="postgresql://drobek:drobek@127.0.0.1:${E2E_POSTGRES_PORT}/drobek"
export REDIS_URL="redis://127.0.0.1:${E2E_REDIS_PORT}"
export MAILPIT_URL="http://127.0.0.1:${E2E_MAILPIT_PORT}"
unset SMOKE_API_KEY

if [ "$#" -gt 0 ]; then
  run_phase "phase-${E2E_PHASE:-1}" "$@"
  exit 0
fi

status=0
run_phase phase-1 --grep "@smoke|@local" || status=$?

echo "── phase 2: drobek recreated with EMAIL_TRANSPORT=relay and PUBLISH_APPROVAL=approval ──"
phase2_config
docker compose up -d drobek
wait_healthz
run_phase phase-2 "${PHASE2_SPECS[@]}" || status=$?

[ "$status" -eq 0 ] || exit "$status"
node scripts/e2e-skip-guard.mjs "$WORK/listed.json" "$WORK/phase-1.json" "$WORK/phase-2.json"
