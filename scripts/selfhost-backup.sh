#!/usr/bin/env bash
# `task backup` — one archive with everything a drobek instance needs
# to come back on another machine:
#
#   backups/drobek-<UTC timestamp>.tar.gz   (mode 600)
#     manifest.json    format, image (tag, id, version, sha), checkout sha,
#                      master-key fingerprint, row counts, size + sha256 per part
#     SHA256SUMS       the same checksums, for `sha256sum -c`
#     db.dump          pg_dump -Fc of the whole database (apps, versions,
#                      blobs, users, keys, module data — every migration journal)
#     files.tar        the files_data volume (/data/files, end-user uploads)
#     assets.tar       the assets_data volume (/data/assets, app assets — video,
#                      audio, images, fonts)
#     modules.tar      the modules_data volume (/data/modules, installed modules
#                      + modules.lock.json — DROBEK_MODULES_DIR)
#     caddy_data.tar   the caddy_data volume (ACME account, certificates, local CA)
#
# Online: postgres is started if it is not running (nothing else is touched)
# and dumped in one consistent snapshot; the files and assets volumes are
# archived AFTER the dump, so every file / asset row in the dump finds its
# bytes (one deleted or replaced in between is the only race — stop drobek
# first for a quiesced backup).
# NOT in the archive: .env.production (DROBEK_MASTER_KEY — keep it separately,
# the restore checks the fingerprint) and Redis (sessions, caches, rate
# limits — after a restore everyone signs in again).
#
# Disk: the parts are written next to the archive (a hidden work directory in
# BACKUP_DIR, not /tmp), and the parts and the archive exist side by side until
# the archive is complete. Before anything is written the backup estimates the
# parts (the database's tables + the four volumes) and refuses to start unless
# BACKUP_DIR has twice that free plus BACKUP_MIN_FREE_MB to spare.
# Retention: the new archive is verified (selfhost-backup-verify.sh's check),
# then every archive beyond the newest BACKUP_KEEP drobek-<timestamp>.tar.gz in
# BACKUP_DIR is deleted (0 = keep all). A failed backup deletes nothing and
# leaves nothing behind.
#
# Settings come from the environment, else ENV_FILE, else the default:
#   BACKUP_DIR=backups  BACKUP_KEEP=14  BACKUP_MIN_FREE_MB=1024
#   ENV_FILE=.env.production  COMPOSE_PROJECT_NAME=…
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/selfhost.sh
. "$ROOT/scripts/lib/selfhost.sh"
require_env_file

out_dir="$(setting BACKUP_DIR backups)"
keep="$(whole_number BACKUP_KEEP "$(setting BACKUP_KEEP 14)")"
min_free_mb="$(whole_number BACKUP_MIN_FREE_MB "$(setting BACKUP_MIN_FREE_MB 1024)")"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$out_dir/drobek-$stamp.tar.gz"
tmp_archive="$archive.partial"
mkdir -p "$out_dir"
chmod 700 "$out_dir"
started=$(date +%s)

say "· postgres up (a no-op when it already runs)"
dc up -d --wait postgres </dev/null 2>&1 | sed 's/^/    /' >&2

say "· free space in $out_dir"
db_bytes="$(pg_query "SELECT coalesce(sum(pg_table_size(c.oid)), 0) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')")"
volumes_kib="$( { dc run --rm --no-deps -T --entrypoint du drobek -sk /data/files /data/assets /data/modules </dev/null 2>/dev/null || true; } | awk '{ s += $1 } END { print s + 0 }')"
caddy_kib="$( { dc run --rm --no-deps -T --entrypoint du caddy -sk /data </dev/null 2>/dev/null || true; } | awk '{ s += $1 } END { print s + 0 }')"
data_kib=$(( db_bytes / 1024 + volumes_kib + caddy_kib ))
need_kib=$(( 2 * data_kib + min_free_mb * 1024 ))
have_kib="$(free_kib "$out_dir")"
if [ "$have_kib" -lt "$need_kib" ]; then
  held_bytes=0
  held_count=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    held_bytes=$(( held_bytes + $(bytes_of "$f") ))
    held_count=$(( held_count + 1 ))
  done <<< "$(backup_archives "$out_dir")"
  if [ "$held_count" -gt 0 ]; then
    remedy="The $held_count archive(s) in $out_dir hold $(human_bytes "$held_bytes"): copy older ones off the machine and
  delete them, or set BACKUP_DIR to a bigger disk. A lower BACKUP_KEEP (now $keep) keeps fewer from then on."
  else
    remedy="Free space on that disk or set BACKUP_DIR to a bigger one."
  fi
  die "not enough free space in $out_dir for a backup: $(human_bytes $(( have_kib * 1024 ))) free, $(human_bytes $(( need_kib * 1024 ))) needed — nothing was written.
  The backup writes its parts (about $(human_bytes $(( data_kib * 1024 ))): database tables $(human_bytes "$db_bytes"), volumes $(human_bytes $(( (volumes_kib + caddy_kib) * 1024 ))))
  and then the archive next to them, so it needs twice that, and leaves BACKUP_MIN_FREE_MB ($min_free_mb) free.
  $remedy"
fi
say "  $(human_bytes $(( have_kib * 1024 ))) free, $(human_bytes $(( need_kib * 1024 ))) needed (twice the data + BACKUP_MIN_FREE_MB)"

work="$(mktemp -d "$out_dir/.drobek-backup.XXXXXX")"
trap 'rm -rf "$work" "$tmp_archive"' EXIT

say "· pg_dump -Fc"
dc exec -T postgres pg_dump -U drobek -d drobek -Fc > "$work/db.dump" </dev/null
apps="$(pg_query "SELECT CASE WHEN to_regclass('public.apps') IS NULL THEN 0 ELSE (SELECT count(*) FROM apps) END")"
files_rows="$(pg_query "SELECT CASE WHEN to_regclass('public.mod_files') IS NULL THEN 0 ELSE (SELECT count(*) FROM mod_files) END")"
asset_rows="$(pg_query "SELECT CASE WHEN to_regclass('public.app_assets') IS NULL THEN 0 ELSE (SELECT count(*) FROM app_assets) END")"
core_migrations="$(pg_query "SELECT CASE WHEN to_regclass('drizzle.__drizzle_migrations_core') IS NULL THEN 0 ELSE (SELECT count(*) FROM drizzle.__drizzle_migrations_core) END")"

say "· files_data (/data/files)"
dc run --rm --no-deps -T --entrypoint tar drobek -C /data/files -cf - . > "$work/files.tar" </dev/null 2>"$work/run.log" \
  || { cat "$work/run.log" >&2; die "could not archive the files_data volume"; }

say "· assets_data (/data/assets)"
dc run --rm --no-deps -T --entrypoint tar drobek -C /data/assets -cf - . > "$work/assets.tar" </dev/null 2>"$work/run.log" \
  || { cat "$work/run.log" >&2; die "could not archive the assets_data volume"; }

say "· modules_data (/data/modules)"
dc run --rm --no-deps -T --entrypoint tar drobek -C /data/modules -cf - . > "$work/modules.tar" </dev/null 2>"$work/run.log" \
  || { cat "$work/run.log" >&2; die "could not archive the modules_data volume"; }

say "· caddy_data (/data)"
dc run --rm --no-deps -T --entrypoint tar caddy -C /data -cf - . > "$work/caddy_data.tar" </dev/null 2>"$work/run.log" \
  || { cat "$work/run.log" >&2; die "could not archive the caddy_data volume"; }

image="$(drobek_image)"
image_env="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" 2>/dev/null || true)"
image_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || echo unknown)"
image_sha="$(printf '%s\n' "$image_env" | sed -n 's/^GIT_SHA=//p')"
image_version="$(printf '%s\n' "$image_env" | sed -n 's/^DROBEK_VERSION=//p')"
checkout_sha="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"

(cd "$work" && for f in db.dump files.tar assets.tar modules.tar caddy_data.tar; do printf '%s  %s\n' "$(sha256_of "$f")" "$f"; done > SHA256SUMS)
part() { printf '"%s": { "bytes": %s, "sha256": "%s" }' "$1" "$(bytes_of "$work/$1")" "$(sha256_of "$work/$1")"; }
{
  printf '{\n'
  printf '  "format": "drobek-backup/1",\n'
  printf '  "created_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "compose_project": "%s",\n' "${COMPOSE_PROJECT_NAME:-drobek-prod}"
  printf '  "image": "%s",\n' "$image"
  printf '  "image_tag": "%s",\n' "${image##*:}"
  printf '  "image_id": "%s",\n' "$image_id"
  printf '  "image_version": "%s",\n' "${image_version:-unknown}"
  printf '  "image_git_sha": "%s",\n' "${image_sha:-unknown}"
  printf '  "checkout_git_sha": "%s",\n' "$checkout_sha"
  printf '  "master_key_fingerprint": "%s",\n' "$(master_key_fingerprint)"
  printf '  "counts": { "apps": %s, "files": %s, "assets": %s, "core_migrations": %s },\n' "$apps" "$files_rows" "$asset_rows" "$core_migrations"
  printf '  "parts": {\n    %s,\n    %s,\n    %s,\n    %s,\n    %s\n  }\n' "$(part db.dump)" "$(part files.tar)" "$(part assets.tar)" "$(part modules.tar)" "$(part caddy_data.tar)"
  printf '}\n'
} > "$work/manifest.json"

(umask 077 && tar -C "$work" -czf "$tmp_archive" manifest.json SHA256SUMS db.dump files.tar assets.tar modules.tar caddy_data.tar)
chmod 600 "$tmp_archive"
rm -f "$work/db.dump" "$work"/*.tar

say "· verify the archive"
mkdir "$work/verify"
verify_backup "$tmp_archive" "$work/verify"
say "  $VERIFIED — every size and sha256 matches manifest.json"
mv "$tmp_archive" "$archive"

say "✓ $archive — $(bytes_of "$archive") bytes in $(( $(date +%s) - started )) s"
say "  apps $apps · files $files_rows · assets $asset_rows · core migrations $core_migrations · image $image (${image_version:-?} ${image_sha:-?})"

if [ "$keep" -gt 0 ]; then
  archives="$(backup_archives "$out_dir")"
  total="$(printf '%s\n' "$archives" | grep -c . || true)"
  excess=$(( total - keep ))
  if [ "$excess" -gt 0 ]; then
    freed=0
    deleted=0
    while IFS= read -r f; do
      [ "$deleted" -lt "$excess" ] || break
      [ "$f" != "$archive" ] || continue
      freed=$(( freed + $(bytes_of "$f") ))
      rm -f "$f"
      say "  deleted $f"
      deleted=$(( deleted + 1 ))
    done <<< "$archives"
    say "  BACKUP_KEEP=$keep: $deleted older archive(s) deleted, $(human_bytes "$freed") freed"
  fi
fi
say "  Keep .env.production (DROBEK_MASTER_KEY) next to it — the archive does not contain it."
printf '%s\n' "$archive"
