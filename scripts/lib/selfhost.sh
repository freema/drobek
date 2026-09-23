# shellcheck shell=bash
# Shared helpers of the self-host scripts (M4-03): selfhost-init.sh,
# selfhost-backup.sh, selfhost-restore.sh, selfhost-rehearsal.sh. Sourced, never
# run. Plain bash 3.2 (macOS) compatible: no associative arrays, no mapfile.
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

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

sha256_check() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c --quiet "$1"
  else shasum -a 256 -c --quiet "$1"; fi
}

bytes_of() { wc -c < "$1" | tr -d ' '; }

# A non-reversible fingerprint of DROBEK_MASTER_KEY (restore compares it with
# the backup's): the first 16 hex chars of sha256("drobek-backup-fp\0" + key).
master_key_fingerprint() {
  local key
  key="$(env_get DROBEK_MASTER_KEY)"
  [ -n "$key" ] || { printf 'unset'; return; }
  printf 'drobek-backup-fp\0%s' "$key" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; } | cut -c1-16
}

# psql inside the postgres container; prints the bare result.
pg_query() { dc exec -T postgres psql -U drobek -d drobek -v ON_ERROR_STOP=1 -tAc "$1" </dev/null; }
