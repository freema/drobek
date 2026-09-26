#!/usr/bin/env bash
# `task restore BACKUP=backups/drobek-<ts>.tar.gz` (M4-03) — put a `task backup`
# archive back into this stack (the same machine or a new one) and start it:
#
#   1. unpack + verify (format, SHA256SUMS)
#   2. DROBEK_MASTER_KEY of .env.production must match the backup's
#      fingerprint (else the restored proxy secrets / password-app cookies are
#      unreadable) — ALLOW_KEY_MISMATCH=1 restores anyway
#   3. postgres up; the database must be EMPTY — FORCE=1 drops and recreates it
#   4. drobek + caddy stopped (no writer while the data is replaced)
#   5. pg_restore; files_data, assets_data, modules_data and caddy_data
#      replaced by the archive's copies (a backup without assets.tar leaves
#      assets_data empty; an archive without modules.tar — made before
#      DROBEK_MODULES_DIR existed — leaves modules_data as it is)
#   6. docker compose up -d --wait (a newer image migrates the restored
#      database forward on start) + /healthz + the restored row counts
#
# On a new machine: clone the same (or a newer) release, copy .env.production
# from the old one, `task selfhost:init` (renders the Caddyfile, keeps the
# secrets), then this. Restore with the backup's image version or a newer one
# (manifest.json `image_version`), never an older one.
#
#   BACKUP=… (required)  FORCE=1  ALLOW_KEY_MISMATCH=1  ENV_FILE=.env.production
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/selfhost.sh
. "$ROOT/scripts/lib/selfhost.sh"
require_env_file

backup="${BACKUP:-${1:-}}"
[ -n "$backup" ] || die "usage: task restore BACKUP=backups/drobek-<timestamp>.tar.gz [FORCE=1]"
[ -f "$backup" ] || die "no such backup: $backup"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
started=$(date +%s)

# ── 1. unpack + verify ───────────────────────────────────────────────────────
tar -xzf "$backup" -C "$work"
for f in manifest.json SHA256SUMS db.dump files.tar caddy_data.tar; do
  [ -f "$work/$f" ] || die "$backup is not a drobek backup (missing $f)"
done
grep -q '"format": "drobek-backup/1"' "$work/manifest.json" || die "unknown backup format (manifest.json)"
(cd "$work" && sha256_check SHA256SUMS) || die "checksum mismatch — the archive is damaged"
field() { sed -n "s/^  \"$1\": \"\\(.*\\)\",\$/\\1/p" "$work/manifest.json" | head -n 1; }
say "✓ $backup verified — created $(field created_at), image $(field image) ($(field image_version) $(field image_git_sha))"

# ── 2. master key ────────────────────────────────────────────────────────────
want="$(field master_key_fingerprint)"
have="$(master_key_fingerprint)"
if [ "$want" != "$have" ]; then
  if [ "${ALLOW_KEY_MISMATCH:-}" = 1 ]; then
    say "! DROBEK_MASTER_KEY differs from the backup's — restoring anyway (ALLOW_KEY_MISMATCH=1):"
    say "  stored proxy upstream secrets cannot be decrypted and must be set again."
  else
    die "DROBEK_MASTER_KEY in $ENV_FILE is not the one this backup was made with.
  Copy the original .env.production (or at least its DROBEK_MASTER_KEY) here, or pass
  ALLOW_KEY_MISMATCH=1 to restore without the encrypted secrets."
  fi
fi

# ── 3. an empty database (or FORCE=1) ────────────────────────────────────────
dc up -d --wait postgres redis </dev/null 2>&1 | sed 's/^/    /' >&2
tables="$(pg_query "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")"
if [ "$tables" != 0 ] && [ "${FORCE:-}" != 1 ]; then
  die "the database is not empty ($tables tables) — refusing to overwrite it.
  Take a backup of it first (task backup), then re-run with FORCE=1."
fi

# ── 4. no writers ────────────────────────────────────────────────────────────
say "· stopping drobek + caddy"
dc stop drobek caddy </dev/null 2>&1 | sed 's/^/    /' >&2

if [ "$tables" != 0 ]; then
  say "· FORCE=1 — dropping and recreating the database ($tables tables)"
  dc exec -T postgres dropdb -U drobek --force --if-exists drobek </dev/null
  dc exec -T postgres createdb -U drobek -O drobek drobek </dev/null
fi

# ── 5. data ──────────────────────────────────────────────────────────────────
say "· pg_restore"
dc exec -T postgres pg_restore -U drobek -d drobek --no-owner --exit-on-error < "$work/db.dump"

say "· files_data (/data/files)"
dc run --rm --no-deps -T --entrypoint sh drobek -c \
  'find /data/files -mindepth 1 -delete && tar -C /data/files -xf -' < "$work/files.tar" 2>"$work/run.log" \
  || { cat "$work/run.log" >&2; die "could not restore the files_data volume"; }

say "· assets_data (/data/assets)"
[ -f "$work/assets.tar" ] || tar -cf "$work/assets.tar" -T /dev/null
dc run --rm --no-deps -T --entrypoint sh drobek -c \
  'find /data/assets -mindepth 1 -delete && tar -C /data/assets -xf -' < "$work/assets.tar" 2>"$work/run.log" \
  || { cat "$work/run.log" >&2; die "could not restore the assets_data volume"; }

if [ -f "$work/modules.tar" ]; then
  say "· modules_data (/data/modules)"
  dc run --rm --no-deps -T --entrypoint sh drobek -c \
    'find /data/modules -mindepth 1 -delete && tar -C /data/modules -xf -' < "$work/modules.tar" 2>"$work/run.log" \
    || { cat "$work/run.log" >&2; die "could not restore the modules_data volume"; }
else
  say "· no modules.tar in this backup — modules_data left as it is"
fi

say "· caddy_data (/data)"
dc run --rm --no-deps -T --entrypoint sh caddy -c \
  'find /data -mindepth 1 -delete && tar -C /data -xf -' < "$work/caddy_data.tar" 2>"$work/run.log" \
  || { cat "$work/run.log" >&2; die "could not restore the caddy_data volume"; }

# ── 6. start + check ─────────────────────────────────────────────────────────
say "· docker compose up -d --wait"
dc up -d --wait --wait-timeout 300 </dev/null 2>&1 | sed 's/^/    /' >&2
health="$(dc exec -T drobek wget -q -T 5 -O - http://127.0.0.1:3000/healthz </dev/null)"
apps="$(pg_query "SELECT count(*) FROM apps")"
files_rows="$(pg_query "SELECT CASE WHEN to_regclass('public.mod_files') IS NULL THEN 0 ELSE (SELECT count(*) FROM mod_files) END")"
say "✓ restored in $(( $(date +%s) - started )) s — /healthz $health"
say "  apps $apps · files $files_rows (backup: $(sed -n 's/.*"counts": { "apps": \([0-9]*\), "files": \([0-9]*\).*/apps \1 · files \2/p' "$work/manifest.json"))"
