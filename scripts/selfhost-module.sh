#!/usr/bin/env bash
# `task selfhost:module:add|remove|list` (NSO-350) — install a third-party
# platform module into DROBEK_MODULES_DIR (the modules_data volume) without
# building an image, remove one, list them. docs/SELF-HOSTING.md → Third-party
# modules.
#
#   selfhost-module.sh add <spec>      npm spec (drobek-module-erp@1.2.0,
#                                      @acme/drobek-module-erp@^1), a tarball
#                                      URL or path, a git URL (git+https://…#tag)
#   selfhost-module.sh remove <name>   the module's name (task selfhost:module:list)
#   selfhost-module.sh list
#
# add, in two steps:
#   1. npm, in a throwaway node:22-alpine container over the volume (the drobek
#      image has no package manager): `npm install --prefix
#      /data/modules/.staging-<id> --omit=dev --omit=peer --legacy-peer-deps
#      --ignore-scripts <spec>` — no install script of the package or its
#      dependencies ever runs;
#   2. the drobek image's own installer (`node node_modules/@drobek/modules/
#      dist/cli/module-lock.js add`, a `run --rm --no-deps` container): checks
#      the package (the @drobek/modules peer, the module contract, the name
#      from its defineModule()), deletes nested copies of the host-provided
#      peers, moves it to /data/modules/<name>, records it in modules.lock.json
#      with the server's hashModuleTree() and loads it the way the server will
#      — a failure restores the previous install. It prints the DROBEK_MODULES
#      line to set and the restart command. The script never edits
#      .env.production, never restarts drobek and never changes the image.
#
# `--dev` (task module:add|remove|list): the same over the dev stack's
# ./.modules (bind-mounted at /data/modules) with the host's npm and node.
#
#   ENV_FILE=.env.production  COMPOSE_PROJECT_NAME=…  (production only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/selfhost.sh
. "$ROOT/scripts/lib/selfhost.sh"

NPM_IMAGE="node:22-alpine"
NPM_FLAGS="--omit=dev --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund --loglevel=error"
LOCK_CLI="node_modules/@drobek/modules/dist/cli/module-lock.js"
DEV_LOCK_CLI="packages/modules/dist/cli/module-lock.js"

usage() { die "usage: $0 [--dev] add <npm spec | tarball URL or path | git URL> | remove <name> | list"; }

dev=0
if [ "${1:-}" = "--dev" ]; then dev=1; shift; fi
cmd="${1:-}"
arg="${2:-}"
case "$cmd" in
  add | remove) [ -n "$arg" ] || usage ;;
  list) ;;
  *) usage ;;
esac

# A git spec needs git in the npm container (node:22-alpine has none).
is_git_spec() {
  case "$1" in
    git+* | git:* | github:* | gitlab:* | bitbucket:* | *.git | *.git#*) return 0 ;;
    *) return 1 ;;
  esac
}

# The compose project of the production stack: COMPOSE_PROJECT_NAME from the
# env file, else from the environment, else the compose file's `name:`.
project_name() {
  local p
  p="$(env_get COMPOSE_PROJECT_NAME)"
  [ -n "$p" ] || p="${COMPOSE_PROJECT_NAME:-}"
  [ -n "$p" ] || p="$(sed -n 's/^name:[[:space:]]*//p' "$SELFHOST_COMPOSE_FILE" | head -n 1 | tr -d "\"' ")"
  printf '%s' "$p"
}

staging=".staging-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

# ── dev stack: ./.modules on the host ────────────────────────────────────────
if [ "$dev" = 1 ]; then
  command -v node >/dev/null 2>&1 || die "node is required"
  [ -f "$DEV_LOCK_CLI" ] || die "$DEV_LOCK_CLI is missing — run pnpm build:packages first"
  dir="$ROOT/.modules"
  mkdir -p "$dir"
  # The DROBEK_MODULES the dev drobek gets: .env (Task loads it), else the compose default.
  modules="${DROBEK_MODULES:-$(sed -n 's/.*DROBEK_MODULES: \${DROBEK_MODULES:-\(.*\)}[[:space:]]*$/\1/p' docker-compose.yml | head -n 1)}"
  lock() { node "$DEV_LOCK_CLI" "$@" --dir "$dir" --root "$ROOT/apps/server" --modules "$modules" --compose "docker compose" --env-name ".env"; }
  case "$cmd" in
    add)
      command -v npm >/dev/null 2>&1 || die "npm is required"
      spec="$arg"
      case "$spec" in file:*) spec="${spec#file:}" ;; esac
      if [ -d "$spec" ]; then die "$spec is a directory — pack it first (npm pack) and add the .tgz"; fi
      [ -f "$spec" ] && spec="$(cd "$(dirname "$spec")" && pwd)/$(basename "$spec")"
      say "· npm install $arg → .modules/$staging (--ignore-scripts)"
      # shellcheck disable=SC2086
      npm install --prefix "$dir/$staging" $NPM_FLAGS "$spec" </dev/null >&2 \
        || { rm -rf "${dir:?}/$staging"; die "npm could not install $arg"; }
      lock add --staging "$staging" --spec "$arg"
      ;;
    remove) lock remove --name "$arg" ;;
    list) lock list ;;
  esac
  exit 0
fi

# ── production stack: the modules_data volume ───────────────────────────────
require_env_file
command -v docker >/dev/null 2>&1 || die "docker is required"
custom_dir="$(env_get DROBEK_MODULES_DIR)"
case "$custom_dir" in
  '' | /data/modules | /data/modules/) ;;
  *) die "DROBEK_MODULES_DIR=$custom_dir in $ENV_FILE: the modules come from your derived image — task selfhost:module:* manage the modules_data volume (/data/modules)" ;;
esac
DC="./scripts/selfhost-compose.sh"
lock() { dc run --rm --no-deps -T drobek node "$LOCK_CLI" "$@" --dir /data/modules --compose "$DC" --env-name "$ENV_FILE" </dev/null; }

case "$cmd" in
  add)
    spec="$arg"
    npm_spec="$spec"
    src_mount=""
    case "$spec" in file:*) spec="${spec#file:}"; npm_spec="$spec" ;; esac
    if [ -d "$spec" ]; then die "$spec is a directory — pack it first (npm pack) and add the .tgz"; fi
    if [ -f "$spec" ]; then
      # A local tarball: mounted read-only into the npm container.
      src_mount="$(cd "$(dirname "$spec")" && pwd):/src:ro"
      npm_spec="/src/$(basename "$spec")"
    fi
    git=0
    if is_git_spec "$spec"; then git=1; fi

    # The drobek image once first: creates the modules_data volume the compose
    # way (a fresh stack) and proves the image has the installer.
    dc run --rm --no-deps -T drobek test -f "$LOCK_CLI" </dev/null 2>/dev/null \
      || die "$(drobek_image) has no $LOCK_CLI — module installation needs a drobek release with NSO-350 (set DROBEK_IMAGE_TAG and pull)"
    volume="$(project_name)_modules_data"
    docker volume inspect "$volume" >/dev/null 2>&1 || die "the volume $volume does not exist (COMPOSE_PROJECT_NAME?)"

    say "· npm install $arg → $volume:/data/modules/$staging ($NPM_IMAGE, --ignore-scripts)"
    set -- run --rm -v "$volume:/data/modules" -e SPEC="$npm_spec" -e STAGING="/data/modules/$staging" -e GIT="$git" -e NPM_FLAGS="$NPM_FLAGS"
    [ -z "$src_mount" ] || set -- "$@" -v "$src_mount"
    # Runs as root (git comes from apk); the result is handed to the image's
    # `node` user (uid 1000), which owns /data/modules.
    docker "$@" "$NPM_IMAGE" sh -c '
      set -e
      if [ "$GIT" = 1 ]; then apk add --no-cache git >/dev/null; fi
      if npm install --prefix "$STAGING" $NPM_FLAGS "$SPEC" >&2; then
        chown -R 1000:1000 "$STAGING"
      else
        rm -rf "$STAGING"
        exit 1
      fi' </dev/null || die "npm could not install $arg"

    lock add --staging "$staging" --spec "$arg"
    ;;
  remove) lock remove --name "$arg" ;;
  list) lock list ;;
esac
