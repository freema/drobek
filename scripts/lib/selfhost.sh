# shellcheck shell=bash
# Shared helpers of the self-host scripts: selfhost-init.sh,
# selfhost-backup.sh, selfhost-backup-verify.sh, selfhost-restore.sh,
# selfhost-rehearsal.sh. Sourced, never run. Plain bash 3.2 (macOS)
# compatible: no associative arrays, no mapfile.
#
#   ENV_FILE               the production env file   (default .env.production)
#   SELFHOST_COMPOSE_FILE  the compose file          (default docker-compose.production.yaml)
#   COMPOSE_PROJECT_NAME   honoured by docker compose (default: the file's `name:`)

ENV_FILE="${ENV_FILE:-.env.production}"
SELFHOST_COMPOSE_FILE="${SELFHOST_COMPOSE_FILE:-docker-compose.production.yaml}"
DROBEK_IMAGE_REPO="${DROBEK_IMAGE_REPO:-ghcr.io/freema/drobek}"

say() { printf '%s\n' "$*" >&2; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# The keys ENV_FILE assigns.
env_keys() { sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$ENV_FILE" 2>/dev/null | sort -u; }

# docker compose against the production stack, with ENV_FILE as the ONLY source
# of its variables: compose lets the shell environment override --env-file,
# so every key the file defines is removed from the environment first (an
# exported APPS_DOMAIN, Task's dotenv of a dev `.env`, or a script's own
# inputs could otherwise silently replace production values). stdin is passed
# through only where a caller redirects it explicitly (restore) — everything
# else runs with </dev/null so a compose call can never swallow a script's stdin.
dc() {
  local unset_args="" k
  for k in $(env_keys); do unset_args="$unset_args -u $k"; done
  # shellcheck disable=SC2086
  env $unset_args docker compose --env-file "$ENV_FILE" -f "$SELFHOST_COMPOSE_FILE" "$@"
}

require_env_file() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found — run \`task selfhost:init\` first"
}

# The value of KEY in ENV_FILE (the last assignment wins, surrounding quotes
# stripped); empty when absent or commented out.
env_get() {
  local line value
  line="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)"
  value="${line#*=}"
  case "$value" in
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
  esac
  printf '%s' "$value"
}

# Set KEY=VALUE in ENV_FILE: replace the active assignment, else activate the
# first commented `# KEY=` line, else append. The value is passed through the
# environment (never interpolated into a program text). Keeps the file mode.
env_set() {
  local tmp
  tmp="$(mktemp)"
  K="$1" V="$2" awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    { lines[NR] = $0; if (!active && index($0, k "=") == 1) active = NR
      if (!commented && ($0 ~ "^# ?" k "=")) commented = NR }
    END {
      target = active ? active : commented
      for (i = 1; i <= NR; i++) print (i == target ? k "=" v : lines[i])
      if (!target) print k "=" v
    }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

# Comment out every active KEY= line (the value stays visible).
env_unset() {
  local tmp
  tmp="$(mktemp)"
  K="$1" awk 'BEGIN { k = ENVIRON["K"] } { if (index($0, k "=") == 1) print "# " $0; else print }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

# A value that must be replaced before production (empty or a placeholder).
is_placeholder() {
  case "$1" in
    '' | change-me* | changeme* | replace-me* | placeholder* | xxx*) return 0 ;;
    *) return 1 ;;
  esac
}

# The drobek image ENV_FILE selects.
drobek_image() {
  local tag
  tag="$(env_get DROBEK_IMAGE_TAG)"
  printf '%s:%s' "$DROBEK_IMAGE_REPO" "${tag:-latest}"
}

sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else shasum -a 256 | awk '{print $1}'; fi
}

sha256_of() { sha256_stdin < "$1"; }

sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --quiet "$1"
  else shasum -a 256 -c --quiet "$1"; fi
}

bytes_of() { wc -c < "$1" | tr -d ' '; }

# $1 bytes for people: 512 B, 40.0 KiB, 1.2 GiB.
human_bytes() {
  LC_ALL=C awk -v b="$1" 'BEGIN {
    split("B KiB MiB GiB TiB", u, " "); i = 1
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    if (i == 1) printf "%d %s\n", b, u[i]; else printf "%.1f %s\n", b, u[i]
  }'
}

# KiB available to this user on the filesystem of directory $1.
free_kib() { df -Pk "$1" | awk 'NR == 2 { print $4 }'; }

# A setting of the self-host scripts: the environment (`BACKUP_KEEP=30 task
# backup`), else ENV_FILE, else $2.
setting() {
  local value="${!1:-}"
  [ -n "$value" ] || value="$(env_get "$1")"
  printf '%s' "${value:-$2}"
}

# $2 as a whole number (leading zeros are not octal), or die naming setting $1.
whole_number() {
  case "$2" in
    '' | *[!0-9]* | ?????????????*) die "$1 must be a whole number of at most 12 digits, not \"$2\"" ;;
  esac
  printf '%s' "$((10#$2))"
}

# The archives `task backup` wrote into directory $1, oldest first (the UTC
# timestamp in drobek-<timestamp>.tar.gz sorts). Other files are not listed.
backup_archives() {
  local f
  for f in "$1"/drobek-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.tar.gz; do
    if [ -f "$f" ]; then printf '%s\n' "$f"; fi
  done | LC_ALL=C sort
}

# A top-level string field of a backup's manifest.json $1.
manifest_field() { sed -n "s/^  \"$2\": \"\\(.*\\)\",\$/\\1/p" "$1" | head -n 1; }

# The parts manifest.json $1 lists, one "name bytes sha256" line each.
manifest_parts() {
  sed -n 's/^ *"\([A-Za-z0-9_.-]*\)": { "bytes": \([0-9][0-9]*\), "sha256": "\([0-9a-f]*\)" },\{0,1\}$/\1 \2 \3/p' "$1"
}

# Check a `task backup` archive without restoring it or unpacking it to disk:
# manifest.json (format drobek-backup/1) and SHA256SUMS list the same parts
# with the same sha256, the parts a restore needs are there, and every part,
# streamed out of the archive, has the size and sha256 of the manifest. $2 is
# an empty scratch directory (manifest.json and SHA256SUMS land there). Dies on
# the first finding; on success VERIFIED names the parts and their sizes.
VERIFIED=""
verify_backup() {
  local archive="$1" dir="$2" name want_bytes want_sum got_bytes got_sum count=0 list=""
  tar -xzf "$archive" -C "$dir" manifest.json SHA256SUMS 2>"$dir/tar.log" \
    || die "$archive is damaged or not a drobek backup — tar could not read manifest.json and SHA256SUMS: $(head -n 1 "$dir/tar.log")"
  grep -q '"format": "drobek-backup/1"' "$dir/manifest.json" || die "$archive: unknown backup format (manifest.json)"
  manifest_parts "$dir/manifest.json" > "$dir/parts"
  for name in db.dump files.tar caddy_data.tar; do
    grep -q "^$name " "$dir/parts" || die "$archive: manifest.json lists no $name, which a restore needs"
  done
  [ "$(awk '{ print $1, $3 }' "$dir/parts" | LC_ALL=C sort)" = "$(awk '{ print $2, $1 }' "$dir/SHA256SUMS" | LC_ALL=C sort)" ] \
    || die "$archive: manifest.json and SHA256SUMS do not list the same parts with the same sha256"
  while read -r name want_bytes want_sum; do
    got_bytes="$( { tar -xzOf "$archive" "$name" 2>"$dir/tar.log" | tee /dev/fd/3 | sha256_stdin > "$dir/sum"; } 3>&1 | wc -c | tr -d ' ')" \
      || die "$archive: could not read $name from the archive — it is damaged: $(head -n 1 "$dir/tar.log")"
    got_sum="$(cat "$dir/sum")"
    [ "$got_bytes" = "$want_bytes" ] && [ "$got_sum" = "$want_sum" ] \
      || die "$archive: $name is damaged — $got_bytes bytes, sha256 ${got_sum:0:12}…; manifest.json says $want_bytes bytes, sha256 ${want_sum:0:12}…"
    count=$((count + 1))
    list="$list${list:+ · }$name $(human_bytes "$got_bytes")"
  done < "$dir/parts"
  VERIFIED="$count parts ($list)"
}

# A non-reversible fingerprint of DROBEK_MASTER_KEY, or of the key variable $1
# names (restore compares it with the backup's): the first 16 hex chars of
# sha256("drobek-backup-fp\0" + key).
master_key_fingerprint() {
  local key
  key="$(env_get "${1:-DROBEK_MASTER_KEY}")"
  [ -n "$key" ] || { printf 'unset'; return; }
  printf 'drobek-backup-fp\0%s' "$key" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -c1-16
}

# psql inside the postgres container; prints the bare result.
pg_query() { dc exec -T postgres psql -U drobek -d drobek -v ON_ERROR_STOP=1 -tAc "$1" </dev/null; }
