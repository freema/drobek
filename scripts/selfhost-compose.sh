#!/usr/bin/env bash
# `docker compose --env-file .env.production -f docker-compose.production.yaml "$@"`
# with .env.production as the only source of the compose variables (the shell
# environment would otherwise override it — see dc() in lib/selfhost.sh). The
# Taskfile's self-host tasks run compose through this (M4-03).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/lib/selfhost.sh
. "$ROOT/scripts/lib/selfhost.sh"
require_env_file
dc "$@"
