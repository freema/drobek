#!/usr/bin/env bash
# Self-host rehearsal — the docs/SELF-HOSTING.md quickstart and the
# backup → restore round trip, end to end, on throwaway stacks. `task
# selfhost:rehearsal`; NOT part of `task check` (it builds the image and runs
# two full stacks). CI runs it on release tags only, against the pushed image
# (selfhost-rehearsal.yml). Every step is what an operator types:
#
#   machine A (a fresh copy of the self-host files, like a clean clone)
#     1. task selfhost:init (tls internal, localhost, SMTP → a throwaway Mailpit)
#        + a second run proving it is idempotent; docker compose config: no warnings
#     2. docker compose … up -d --wait → /healthz + /api/version through Caddy;
#        every container log rotates (json-file, max-size 20m, max-file 5)
#     3. a dashboard user via the e-mail code flow (POST /login → Mailpit →
#        POST /login/verify → GET /me)
#     4. a drk_ API key with the container CLI → MCP: create_app → write_files
#        → publish → the production host serves it; an end user uploads a file
#    4b. task selfhost:module:add -- <a packed module (the guestbook fixture)>
#        → task selfhost:module:list → DROBEK_MODULES → drobek restarts and
#        /api/version lists it with source "dir"
#     5. task backup without room (BACKUP_MIN_FREE_MB) is refused and writes
#        and deletes nothing; task backup BACKUP_KEEP=2 next to three older
#        archives keeps the newest two and a file of another name →
#        docker compose down -v (every volume gone)
#   machine B (another fresh copy + A's .env.production, nothing else)
#     6. task backup:verify of the copied archive (no stack running) passes, a
#        damaged copy fails; task selfhost:init (renders the Caddyfile, keeps
#        every secret)
#     7. task restore BACKUP=… → the app serves on its host, the file downloads,
#        the same API key works, Caddy's restored local CA still validates, the
#        server starts with the same modules.lock.json and loads the module
#     8. a second restore is refused (non-empty database), FORCE=1 replaces
#        it; the upgrade's migrate step twice (the second applies nothing)
#
# Wall-clock times are printed at the end. Knobs: REHEARSAL_HTTPS_PORT (9443),
# REHEARSAL_HTTP_PORT (9080), REHEARSAL_MAILPIT_PORT (8046),
# REHEARSAL_IMAGE_TAG (selfhost-rehearsal), REHEARSAL_SKIP_BUILD=1 (use an
# already built ghcr.io/freema/drobek:<tag>), REHEARSAL_KEEP=1 (leave it all).
# Unique COMPOSE_PROJECT_NAMEs (selfhost-<id>-a / -b); every port binds 127.0.0.1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/selfhost.sh
. "$ROOT/scripts/lib/selfhost.sh"

for tool in docker task node npm curl openssl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required for the rehearsal"
done
[ -d "$ROOT/tests-e2e/node_modules/@modelcontextprotocol/sdk" ] || die "run pnpm install first (tests-e2e needs @modelcontextprotocol/sdk)"

RID="${REHEARSAL_ID:-$(openssl rand -hex 3)}"
PROJECT_A="selfhost-$RID-a"
PROJECT_B="selfhost-$RID-b"
HTTPS_PORT="${REHEARSAL_HTTPS_PORT:-9443}"
HTTP_PORT="${REHEARSAL_HTTP_PORT:-9080}"
MAILPIT_PORT="${REHEARSAL_MAILPIT_PORT:-8046}"
IMAGE_TAG="${REHEARSAL_IMAGE_TAG:-selfhost-rehearsal}"
IMAGE="$DROBEK_IMAGE_REPO:$IMAGE_TAG"
MAILPIT="selfhost-$RID-mailpit"
OWNER="owner-$RID@example.com"
BASE="https://localhost:$HTTPS_PORT"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/drobek-selfhost.XXXXXX")"
A="$SCRATCH/machine-a"
B="$SCRATCH/machine-b"
CA="$SCRATCH/root.crt"
STATE="$SCRATCH/state.json"
ACTIVE=""

now() { date +%s; }
T0=$(now)
step() { printf '\n── %s  (+%ss)\n' "$*" "$(( $(now) - T0 ))" >&2; }
ok() { printf '  ✓ %s\n' "$*" >&2; }

# docker compose of one "machine" (its dir + project).
on() {
  local dir="$1" project="$2"
  shift 2
  (cd "$dir" && COMPOSE_PROJECT_NAME="$project" docker compose --env-file .env.production -f docker-compose.production.yaml "$@")
}

teardown() {
  local code=$?
  set +e
  if [ "$code" -ne 0 ] && [ -n "$ACTIVE" ]; then
    say "── rehearsal failed (exit $code) — last drobek + caddy logs of $ACTIVE ──"
    on "${ACTIVE%%|*}" "${ACTIVE#*|}" logs --no-color --tail 80 drobek caddy >&2
  fi
  if [ "${REHEARSAL_KEEP:-}" = 1 ]; then
    say "REHEARSAL_KEEP=1 — left running: projects $PROJECT_A / $PROJECT_B, $MAILPIT, $SCRATCH"
  else
    docker rm -f "$MAILPIT" >/dev/null 2>&1
    [ -d "$A" ] && on "$A" "$PROJECT_A" down -v --remove-orphans >/dev/null 2>&1
    [ -d "$B" ] && on "$B" "$PROJECT_B" down -v --remove-orphans >/dev/null 2>&1
    rm -rf "$SCRATCH"
  fi
  exit "$code"
}
trap teardown EXIT

# A fresh "clone": only the files a self-hoster uses (no node_modules, no .env).
checkout() {
  mkdir -p "$1/deployments" "$1/scripts/lib"
  cp "$ROOT/Taskfile.yml" "$ROOT/docker-compose.production.yaml" "$ROOT/.env.production.example" "$1/"
  cp "$ROOT/deployments/Dockerfile.caddy" "$1/deployments/"
  cp "$ROOT"/scripts/*.sh "$1/scripts/"
  cp "$ROOT"/scripts/lib/*.sh "$1/scripts/lib/"
}

# ── 0. the image (not part of the quickstart timing: a VPS pulls it) ─────────
if [ "${REHEARSAL_SKIP_BUILD:-}" = 1 ]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "REHEARSAL_SKIP_BUILD=1 but $IMAGE does not exist"
  BUILD_S=0
else
  step "0. docker build $IMAGE (runner target)"
  t=$(now)
  sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
  docker build -q --target runner --build-arg GIT_SHA="$sha" --build-arg VERSION=v0.0.0-rehearsal -t "$IMAGE" "$ROOT" >/dev/null
  BUILD_S=$(( $(now) - t ))
  ok "built in ${BUILD_S}s"
fi
docker run -d --name "$MAILPIT" -p "127.0.0.1:$MAILPIT_PORT:8025" axllent/mailpit >/dev/null
MAILPIT_URL="http://127.0.0.1:$MAILPIT_PORT"

# ── machine A ────────────────────────────────────────────────────────────────
TQ=$(now)
checkout "$A"
ACTIVE="$A|$PROJECT_A"

step "1. task selfhost:init (machine A)"
(cd "$A" && COMPOSE_PROJECT_NAME="$PROJECT_A" DOMAIN=localhost TLS_MODE=internal \
  HTTPS_PORT="$HTTPS_PORT" HTTP_PORT="$HTTP_PORT" PUBLISH_IP=127.0.0.1 DROBEK_IMAGE_TAG="$IMAGE_TAG" \
  SMTP_HOST=mailpit SMTP_PORT=1025 SMTP_SECURE=0 EMAIL_FROM=no-reply@example.com SUPERADMIN_EMAIL="$OWNER" \
  task selfhost:init)
for s in POSTGRES_PASSWORD DROBEK_MASTER_KEY TLS_ASK_TOKEN; do
  v="$(ENV_FILE="$A/.env.production" env_get "$s")"
  [ "${#v}" = 64 ] || die "$s was not generated (64 hex chars)"
done
[ "$(stat -c %a "$A/.env.production" 2>/dev/null || stat -f %Lp "$A/.env.production")" = 600 ] || die ".env.production is not mode 600"
ok "three secrets generated (64 hex chars), .env.production mode 600"
before_env="$(sha256_of "$A/.env.production")"
before_caddy="$(sha256_of "$A/deployments/Caddyfile")"
(cd "$A" && COMPOSE_PROJECT_NAME="$PROJECT_A" task selfhost:init >/dev/null 2>&1)
[ "$(sha256_of "$A/.env.production")" = "$before_env" ] || die "a second task selfhost:init changed .env.production"
[ "$(sha256_of "$A/deployments/Caddyfile")" = "$before_caddy" ] || die "a second task selfhost:init changed the Caddyfile"
ok "a second run changes nothing (idempotent)"
warnings="$(on "$A" "$PROJECT_A" config -q 2>&1)"
[ -z "$warnings" ] || die "docker compose config is not clean: $warnings"
ok "docker compose --env-file .env.production -f docker-compose.production.yaml config: no warnings"

step "2. docker compose up -d --wait (machine A)"
on "$A" "$PROJECT_A" up -d --wait --wait-timeout 300 </dev/null 2>&1 | { grep -E "Healthy|rror|denied" || true; } | sed 's/^/    /' >&2
docker network connect --alias mailpit "${PROJECT_A}_default" "$MAILPIT"
for _ in $(seq 1 30); do
  on "$A" "$PROJECT_A" exec -T caddy test -f /data/caddy/pki/authorities/local/root.crt </dev/null && break
  sleep 1
done
on "$A" "$PROJECT_A" cp caddy:/data/caddy/pki/authorities/local/root.crt "$CA" >/dev/null 2>&1
health=""
for _ in $(seq 1 60); do
  health="$(curl -sf --cacert "$CA" "$BASE/healthz")" && break
  sleep 1
done
[ -n "$health" ] || die "$BASE/healthz never went green through Caddy"
ok "$BASE/healthz → $health"
version="$(curl -sf --cacert "$CA" "$BASE/api/version")"
case "$version" in *'"version":'*) ok "/api/version → $version" ;; *) die "/api/version: $version" ;; esac
[ "$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CA" "$BASE/api/internal/tls/ask?domain=x")" = 404 ] || die "/api/internal/* must be 404 on the public site"
ok "/api/internal/* is refused on the public site"
containers="$(on "$A" "$PROJECT_A" ps -q)"
[ "$(printf '%s\n' "$containers" | grep -c .)" = 4 ] || die "expected 4 containers, got: $containers"
for c in $containers; do
  logcfg="$(docker inspect --format '{{.Name}} {{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}' "$c")"
  case "$logcfg" in *' json-file 20m 5') ;; *) die "a container log does not rotate: $logcfg" ;; esac
done
ok "every container log rotates (json-file, max-size 20m, max-file 5)"

step "3. dashboard sign-in over the e-mail code flow"
login="$(curl -s --cacert "$CA" -o /dev/null -w '%{http_code} %{redirect_url}' -X POST --data-urlencode "email=$OWNER" "$BASE/login")"
case "$login" in 302\ *login/verify*) ok "POST /login → $login" ;; *) die "POST /login: $login" ;; esac
code=""
for _ in $(seq 1 60); do
  code="$(curl -s "$MAILPIT_URL/api/v1/messages?limit=20" | OWNER="$OWNER" MAILPIT="$MAILPIT_URL" node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", async () => {
      const m = (JSON.parse(s).messages || []).find((x) => (x.To || []).some((t) => (t.Address || "").toLowerCase() === process.env.OWNER));
      if (!m) return;
      const d = await (await fetch(process.env.MAILPIT + "/api/v1/message/" + m.ID)).json();
      const c = /\b(\d{6})\b/.exec((d.Subject || "") + "\n" + (d.Text || ""));
      if (c) process.stdout.write(c[1]);
    });' 2>/dev/null || true)"
  [ -n "$code" ] && break
  sleep 0.5
done
[ -n "$code" ] || die "no sign-in code for $OWNER in Mailpit"
ok "sign-in code delivered through SMTP (Mailpit)"
headers="$SCRATCH/verify.headers"
status="$(curl -s --cacert "$CA" -D "$headers" -o /dev/null -w '%{http_code}' -X POST \
  --data-urlencode "email=$OWNER" --data-urlencode "code=$code" "$BASE/login/verify?email=$OWNER")"
[ "$status" = 302 ] || die "POST /login/verify → $status"
session="$(sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-drobek_session=[^;]*\).*/\1/p' "$headers" | head -n 1)"
[ -n "$session" ] || die "no __Host-drobek_session cookie after verify"
me="$(curl -s --cacert "$CA" -o /dev/null -w '%{http_code}' -H "Cookie: $session" "$BASE/me")"
[ "$me" = 200 ] || die "GET /me with the session → $me"
ok "signed in: __Host-drobek_session, GET /me → 200"

step "4. API key (container CLI) → MCP: create_app → write_files → publish, file upload"
KEY="$(on "$A" "$PROJECT_A" exec -T drobek node node_modules/@drobek/oauth/dist/cli/api-key-create.js \
  --email "$OWNER" --name rehearsal --scopes read,write,publish </dev/null 2>/dev/null)"
case "$KEY" in drk_*) ok "drk_ API key minted" ;; *) die "api-key-create printed no drk_ key" ;; esac
BASE_URL="$BASE" APPS_DOMAIN="apps.localhost:$HTTPS_PORT" API_KEY="$KEY" MAILPIT_URL="$MAILPIT_URL" \
  STATE_FILE="$STATE" CA_FILE="$CA" NODE_EXTRA_CA_CERTS="$CA" node "$ROOT/tests-e2e/selfhost-rehearsal.mjs" seed
QUICKSTART_S=$(( $(now) - TQ ))
ok "quickstart done: init → TLS dashboard → user → MCP → published app + file in ${QUICKSTART_S}s"

step "4b. task selfhost:module:add (a packed module) → DROBEK_MODULES → loaded from the volume"
(cd "$SCRATCH" && npm pack --silent "$ROOT/packages/modules/test-fixtures/drobek-module-guestbook" >/dev/null)
tgz="$SCRATCH/drobek-module-guestbook-1.0.0.tgz"
[ -f "$tgz" ] || die "npm pack of the guestbook fixture wrote no $tgz"
(cd "$A" && COMPOSE_PROJECT_NAME="$PROJECT_A" task selfhost:module:add -- "$tgz") >"$SCRATCH/module-add.log" 2>&1 \
  || { cat "$SCRATCH/module-add.log" >&2; die "task selfhost:module:add failed"; }
grep -q 'DROBEK_MODULES=auth,email,forms,data,proxy,files,sync,oidc,guestbook' "$SCRATCH/module-add.log" \
  || { cat "$SCRATCH/module-add.log" >&2; die "selfhost:module:add did not print the DROBEK_MODULES line"; }
ok "installed into ${PROJECT_A}_modules_data, the next-step DROBEK_MODULES line printed"
listed="$(cd "$A" && COMPOSE_PROJECT_NAME="$PROJECT_A" task selfhost:module:list 2>/dev/null)"
printf '%s\n' "$listed" | grep -Eq '^guestbook +drobek-module-guestbook +1\.0\.0 +\^1\.1 +sha512-.* +no +ok$' \
  || { printf '%s\n' "$listed" >&2; die "selfhost:module:list does not show guestbook as ok"; }
ok "task selfhost:module:list: guestbook 1.0.0 ok"
# guestbook contributes to the slot of the example module `hello` (in the image).
ENV_FILE="$A/.env.production" env_set DROBEK_MODULES auth,email,forms,data,proxy,files,sync,oidc,hello,guestbook
on "$A" "$PROJECT_A" up -d --wait --wait-timeout 300 drobek </dev/null >/dev/null 2>&1 || die "drobek did not come back with the module"
version="$(curl -sf --cacert "$CA" "$BASE/api/version")"
case "$version" in
  *'"name":"guestbook","version":"1.0.0","source":"dir"'*) ok "/api/version lists guestbook 1.0.0 from the modules directory" ;;
  *) die "/api/version does not list the installed module: $version" ;;
esac
LOCK_A="$(on "$A" "$PROJECT_A" run --rm --no-deps -T drobek cat /data/modules/modules.lock.json </dev/null 2>/dev/null)"
case "$LOCK_A" in *'"guestbook"'*) ;; *) die "modules.lock.json on machine A does not record guestbook" ;; esac
# machine B gets this .env.production (with DROBEK_MODULES) — the new baseline.
before_env="$(sha256_of "$A/.env.production")"

step "5. task backup: refused without room, BACKUP_KEEP → docker compose down -v (machine A)"
mkdir -p "$A/backups"
for ts in 20200101T000000Z 20200102T000000Z 20200103T000000Z; do
  printf 'an older archive\n' > "$A/backups/drobek-$ts.tar.gz"
done
printf 'kept by hand\n' > "$A/backups/drobek-before-upgrade.tar.gz"
before_backups="$(cd "$A/backups" && ls -A | LC_ALL=C sort | tr '\n' ' ')"
if (cd "$A" && COMPOSE_PROJECT_NAME="$PROJECT_A" task backup BACKUP_MIN_FREE_MB=999999999 >"$SCRATCH/nospace.log" 2>&1); then
  die "task backup ran although the disk cannot keep BACKUP_MIN_FREE_MB free"
fi
grep -q 'not enough free space' "$SCRATCH/nospace.log" || { cat "$SCRATCH/nospace.log" >&2; die "the refusal did not name the free space"; }
[ "$(cd "$A/backups" && ls -A | LC_ALL=C sort | tr '\n' ' ')" = "$before_backups" ] \
  || { ls -lA "$A/backups" >&2; die "the refused backup wrote or deleted something in backups/"; }
ok "a disk without room: refused with the sizes, nothing written, nothing deleted"
TB=$(now)
archive="$(cd "$A" && COMPOSE_PROJECT_NAME="$PROJECT_A" task backup BACKUP_KEEP=2 2>"$SCRATCH/backup.log" | tail -n 1)" \
  || { cat "$SCRATCH/backup.log" >&2; die "task backup failed"; }
sed 's/^/    /' "$SCRATCH/backup.log" | grep -v '^    task:' >&2 || true
[ -f "$A/$archive" ] || die "task backup did not produce an archive ($archive)"
BACKUP_S=$(( $(now) - TB ))
grep -q 'every size and sha256 matches manifest.json' "$SCRATCH/backup.log" || die "task backup did not verify its archive"
kept="$(cd "$A/backups" && ls -A | LC_ALL=C sort | tr '\n' ' ')"
[ "$kept" = "drobek-20200103T000000Z.tar.gz $(basename "$archive") drobek-before-upgrade.tar.gz " ] \
  || die "BACKUP_KEEP=2 left: $kept"
ok "verified, then BACKUP_KEEP=2 deleted the two oldest archives (a file of another name stays)"
tar -tzf "$A/$archive" | sort | tr '\n' ' ' | sed 's/^/  archive: /' >&2; printf '\n' >&2
docker network disconnect "${PROJECT_A}_default" "$MAILPIT"
on "$A" "$PROJECT_A" down -v --remove-orphans </dev/null >/dev/null 2>&1
left="$(docker volume ls -q --filter "name=${PROJECT_A}_" | wc -l | tr -d ' ')"
[ "$left" = 0 ] || die "volumes of $PROJECT_A survived down -v"
ok "machine A is gone (containers + all five volumes)"

# ── machine B ────────────────────────────────────────────────────────────────
step "6. machine B: fresh checkout + A's .env.production + the archive → task backup:verify → task selfhost:init"
checkout "$B"
ACTIVE="$B|$PROJECT_B"
(umask 077 && cp "$A/.env.production" "$B/.env.production")
mkdir -p "$B/backups"
cp "$A/$archive" "$B/backups/"
(cd "$B" && task backup:verify >"$SCRATCH/verify.log" 2>&1) || { cat "$SCRATCH/verify.log" >&2; die "task backup:verify refused the copied archive"; }
grep -q "$(basename "$archive") is intact" "$SCRATCH/verify.log" || { cat "$SCRATCH/verify.log" >&2; die "task backup:verify did not check the newest archive"; }
grep -q 'made under DROBEK_MASTER_KEY of' "$SCRATCH/verify.log" || { cat "$SCRATCH/verify.log" >&2; die "task backup:verify did not match the archive's key"; }
ok "task backup:verify (the newest archive in backups/, no stack running): intact, made under this DROBEK_MASTER_KEY"
cp "$B/backups/$(basename "$archive")" "$SCRATCH/damaged.tar.gz"
printf 'damaged!' | dd of="$SCRATCH/damaged.tar.gz" bs=1 seek=$(( $(bytes_of "$SCRATCH/damaged.tar.gz") / 2 )) conv=notrunc 2>/dev/null
if (cd "$B" && task backup:verify BACKUP="$SCRATCH/damaged.tar.gz" >"$SCRATCH/damaged.log" 2>&1); then
  die "task backup:verify passed an archive with 8 bytes overwritten"
fi
grep -q '^✗ .*damaged' "$SCRATCH/damaged.log" || { cat "$SCRATCH/damaged.log" >&2; die "task backup:verify failed without naming the damage"; }
ok "a copy with 8 bytes overwritten in the middle is refused"
TR=$(now)
(cd "$B" && COMPOSE_PROJECT_NAME="$PROJECT_B" task selfhost:init >/dev/null 2>&1)
[ "$(sha256_of "$B/.env.production")" = "$before_env" ] || die "selfhost:init on machine B changed the copied .env.production"
ok "secrets kept, Caddyfile rendered"

step "7. task restore BACKUP=backups/$(basename "$archive") (machine B)"
(cd "$B" && COMPOSE_PROJECT_NAME="$PROJECT_B" task restore BACKUP="backups/$(basename "$archive")") 2>&1 | { grep -vE "^task:|Creat|Start|Waiting|Running|Stopp" || true; } | sed 's/^/    /' >&2
RESTORE_S=$(( $(now) - TR ))
curl -sf --cacert "$CA" "$BASE/healthz" >/dev/null || die "machine B /healthz (with machine A's CA root) failed"
ok "/healthz through Caddy with machine A's root CA → caddy_data restored"
BASE_URL="$BASE" APPS_DOMAIN="apps.localhost:$HTTPS_PORT" API_KEY="$KEY" MAILPIT_URL="$MAILPIT_URL" \
  STATE_FILE="$STATE" CA_FILE="$CA" NODE_EXTRA_CA_CERTS="$CA" node "$ROOT/tests-e2e/selfhost-rehearsal.mjs" verify
LOCK_B="$(on "$B" "$PROJECT_B" run --rm --no-deps -T drobek cat /data/modules/modules.lock.json </dev/null 2>/dev/null)"
[ "$LOCK_B" = "$LOCK_A" ] || die "modules.lock.json after the restore differs from machine A's"
case "$(curl -sf --cacert "$CA" "$BASE/api/version")" in
  *'"name":"guestbook","version":"1.0.0","source":"dir"'*) ok "modules_data restored: the same modules.lock.json, guestbook loads from the directory" ;;
  *) die "machine B does not load the restored module" ;;
esac

step "8. guard rails: a second restore is refused, FORCE=1 replaces; migrate twice"
if (cd "$B" && COMPOSE_PROJECT_NAME="$PROJECT_B" task restore BACKUP="backups/$(basename "$archive")" >"$SCRATCH/refuse.log" 2>&1); then
  die "a restore into a non-empty database was NOT refused"
fi
grep -q 'not empty' "$SCRATCH/refuse.log" || { cat "$SCRATCH/refuse.log" >&2; die "the refusal did not name the non-empty database"; }
ok "restore into a non-empty database refused"
(cd "$B" && COMPOSE_PROJECT_NAME="$PROJECT_B" task restore FORCE=1 BACKUP="backups/$(basename "$archive")" >"$SCRATCH/force.log" 2>&1) \
  || { cat "$SCRATCH/force.log" >&2; die "task restore FORCE=1 failed"; }
grep -q 'dropping and recreating' "$SCRATCH/force.log" || die "FORCE=1 did not recreate the database"
BASE_URL="$BASE" APPS_DOMAIN="apps.localhost:$HTTPS_PORT" API_KEY="$KEY" MAILPIT_URL="$MAILPIT_URL" \
  STATE_FILE="$STATE" CA_FILE="$CA" NODE_EXTRA_CA_CERTS="$CA" node "$ROOT/tests-e2e/selfhost-rehearsal.mjs" verify
ok "task restore FORCE=1 over the live database: dropped, restored, serving again"
m1="$(cd "$B" && COMPOSE_PROJECT_NAME="$PROJECT_B" task selfhost:migrate 2>&1)"
m2="$(cd "$B" && COMPOSE_PROJECT_NAME="$PROJECT_B" task selfhost:migrate 2>&1)"
printf '%s\n' "$m2" | grep -q 'nothing to apply' || { printf '%s\n%s\n' "$m1" "$m2" >&2; die "the second migrate run was not a no-op"; }
ok "task selfhost:migrate ×2 — the second run: nothing to apply"

TOTAL_S=$(( $(now) - T0 ))
printf '\n══ self-host rehearsal PASSED ══\n' >&2
printf '  image build            %4ss  (not on a VPS: it pulls)\n' "$BUILD_S" >&2
printf '  quickstart A (init → published app + file)  %4ss\n' "$QUICKSTART_S" >&2
printf '  task backup            %4ss\n' "$BACKUP_S" >&2
printf '  machine B (init + restore)  %4ss\n' "$RESTORE_S" >&2
printf '  total wall clock       %4ss\n' "$TOTAL_S" >&2
