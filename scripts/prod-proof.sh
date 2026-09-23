#!/usr/bin/env bash
# Prove the production image (M0-01) locally, without touching any server:
#   1. size < 250 MB, no devDependencies, runs as non-root
#   2. a placeholder KEK makes the process exit 1 with a clear message
#   3. against throwaway postgres + redis it migrates itself, serves the
#      dashboard + OAuth AS + MCP RS from ONE process, and /healthz is green
# Usage: IMAGE=ghcr.io/freema/drobek:<sha> scripts/prod-proof.sh
set -euo pipefail

IMAGE="${IMAGE:?IMAGE must be set (task prod:proof sets it)}"
PORT="${PROOF_PORT:-3048}"
NAME="drobek-proof-$$"
NET="$NAME-net"
BASE="http://localhost:$PORT"
MAX_MB=250

cleanup() {
  docker rm -f "$NAME" "$NAME-pg" "$NAME-redis" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "✗ $*" >&2; exit 1; }
ok() { echo "✓ $*"; }

# --- 1. image shape -----------------------------------------------------------
# Uncompressed root filesystem (the registry/containerd `.Size` is compressed).
mb=$(docker run --rm --entrypoint sh "$IMAGE" -c 'du -sxm / 2>/dev/null | cut -f1')
[ "$mb" -lt "$MAX_MB" ] || fail "image is ${mb} MB unpacked (limit ${MAX_MB} MB)"
ok "image size ${mb} MB unpacked < ${MAX_MB} MB"

# pnpm store dir names encode scoped packages as `@scope+name@version`.
for dev in vite vitest @react-router+dev drizzle-kit eslint tsx; do
  if docker run --rm --entrypoint sh "$IMAGE" -c "ls node_modules/.pnpm | grep -q '^${dev}@'"; then
    fail "devDependency $dev is present in the image"
  fi
done
ok "no devDependencies in node_modules"

uid=$(docker run --rm --entrypoint id "$IMAGE" -u)
[ "$uid" != "0" ] || fail "image runs as root"
ok "runs as non-root (uid $uid)"

# --- 2. fail-closed secrets -----------------------------------------------------
set +e
out=$(docker run --rm -e NODE_ENV=production \
  -e DROBEK_MASTER_KEY=change-me-generate-with-openssl-rand-hex-32 "$IMAGE" 2>&1)
code=$?
set -e
[ "$code" -eq 1 ] || fail "placeholder KEK: expected exit 1, got $code"
echo "$out" | grep -q 'DROBEK_MASTER_KEY still has its placeholder value' \
  || fail "placeholder KEK: missing clear error message (got: $out)"
ok "placeholder KEK → exit 1 with a clear message"

# --- 3. live boot against throwaway datastores ---------------------------------
docker network create "$NET" >/dev/null
docker run -d --name "$NAME-pg" --network "$NET" -e POSTGRES_USER=drobek \
  -e POSTGRES_PASSWORD=drobek -e POSTGRES_DB=drobek postgres:17-alpine >/dev/null
docker run -d --name "$NAME-redis" --network "$NET" redis:7-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "$NAME-pg" pg_isready -U drobek -d drobek >/dev/null 2>&1 && break
  sleep 1
done

docker run -d --name "$NAME" --network "$NET" -p "$PORT:3000" \
  -e DATABASE_URL="postgresql://drobek:drobek@$NAME-pg:5432/drobek" \
  -e REDIS_URL="redis://$NAME-redis:6379" \
  -e DROBEK_MASTER_KEY="$(openssl rand -hex 32)" \
  -e PUBLIC_APP_URL="$BASE" \
  "$IMAGE" >/dev/null

healthy=""
for _ in $(seq 1 60); do
  if body=$(curl -sf "$BASE/healthz"); then healthy=1; break; fi
  sleep 1
done
[ -n "$healthy" ] || { docker logs "$NAME" 2>&1 | tail -40; fail "/healthz never went green"; }
echo "$body" | grep -q '"ok":true' || fail "/healthz body: $body"
ok "/healthz → $body"

docker exec "$NAME-pg" psql -U drobek -d drobek -tAc \
  "select count(*) from information_schema.tables where table_name in ('app_versions','version_files','blobs')" \
  | grep -qx 3 || fail "core migrations did not create the version tables"
ok "server migrated the database on start (app_versions, version_files, blobs)"

hdr=$(curl -s -o /dev/null -D - -X POST "$BASE/mcp" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}')
echo "$hdr" | head -1 | grep -q ' 401' || fail "/mcp without token: $(echo "$hdr" | head -1)"
echo "$hdr" | grep -qi "www-authenticate: Bearer resource_metadata=\"$BASE/.well-known/oauth-protected-resource/mcp\"" \
  || fail "/mcp 401 lacks the resource_metadata pointer"
ok "/mcp without token → 401 + WWW-Authenticate resource_metadata"

prm=$(curl -sf "$BASE/.well-known/oauth-protected-resource/mcp")
echo "$prm" | grep -q "\"resource\":\"$BASE/mcp\"" || fail "protected-resource metadata: $prm"
curl -sf "$BASE/.well-known/oauth-authorization-server" | grep -q "\"issuer\":\"$BASE\"" \
  || fail "authorization-server metadata"
ok "RFC 9728 + RFC 8414 metadata served by the same process"

login=$(curl -sf "$BASE/login") || fail "dashboard /login"
asset=$(echo "$login" | grep -o '/assets/[^"]*\.js' | head -1)
[ -n "$asset" ] || fail "no /assets/*.js referenced from /login"
curl -sf -o /dev/null -D - "$BASE$asset" | grep -qi 'cache-control: public, max-age=31536000, immutable' \
  || fail "asset $asset not served immutable"
ok "dashboard SSR + immutable assets ($asset)"

echo "prod proof: all green ($IMAGE)"
