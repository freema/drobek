#!/usr/bin/env bash
# `task backup:verify [BACKUP=backups/drobek-<ts>.tar.gz]` — check a `task
# backup` archive without restoring it (default: the newest archive in
# BACKUP_DIR):
#
#   1. it is a gzip'd tar with manifest.json (format drobek-backup/1) and
#      SHA256SUMS, and the manifest lists the parts a restore needs (db.dump,
#      files.tar, caddy_data.tar)
#   2. manifest.json and SHA256SUMS list the same parts with the same sha256
#   3. every part, streamed out of the archive (nothing is unpacked to disk),
#      has the size and sha256 of the manifest
#
# Needs neither docker nor a running stack: an archive copied to another
# machine checks the same way. With ENV_FILE at hand it also says whether its
# DROBEK_MASTER_KEY (or DROBEK_MASTER_KEY_PREVIOUS) is the archive's — a
# restore needs that key. `task backup` runs the same check on every new
# archive before BACKUP_KEEP deletes older ones. Exit 0 = intact, 1 = not.
#
#   BACKUP=…  BACKUP_DIR=backups  ENV_FILE=.env.production
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/selfhost.sh
. "$ROOT/scripts/lib/selfhost.sh"

backup="${BACKUP:-${1:-}}"
if [ -z "$backup" ]; then
  dir="$(setting BACKUP_DIR backups)"
  backup="$(backup_archives "$dir" | tail -n 1)"
  [ -n "$backup" ] || die "no task backup archive (drobek-<timestamp>.tar.gz) in $dir — pass BACKUP=<archive>"
fi
[ -f "$backup" ] || die "no such backup: $backup"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
started=$(date +%s)

say "· verifying $backup ($(human_bytes "$(bytes_of "$backup")"))"
verify_backup "$backup" "$work"
manifest="$work/manifest.json"
say "✓ $backup is intact — $VERIFIED; every size and sha256 matches manifest.json and SHA256SUMS ($(( $(date +%s) - started )) s)"
say "  created $(manifest_field "$manifest" created_at), image $(manifest_field "$manifest" image) ($(manifest_field "$manifest" image_version) $(manifest_field "$manifest" image_git_sha))"
say "  $(sed -n 's/^  "counts": { \(.*\) },$/\1/p' "$manifest" | sed 's/"//g; s/_/ /g; s/: / /g; s/, / · /g')"

if [ -f "$ENV_FILE" ]; then
  want="$(manifest_field "$manifest" master_key_fingerprint)"
  if [ "$want" = "$(master_key_fingerprint)" ]; then
    say "  made under DROBEK_MASTER_KEY of $ENV_FILE"
  elif [ -n "$(env_get DROBEK_MASTER_KEY_PREVIOUS)" ] && [ "$want" = "$(master_key_fingerprint DROBEK_MASTER_KEY_PREVIOUS)" ]; then
    say "  made under DROBEK_MASTER_KEY_PREVIOUS of $ENV_FILE (before a key rotation)"
  else
    say "! made under another DROBEK_MASTER_KEY than the one in $ENV_FILE — a restore here needs that key"
    say "  (or ALLOW_KEY_MISMATCH=1, which restores without the stored secrets)"
  fi
fi
