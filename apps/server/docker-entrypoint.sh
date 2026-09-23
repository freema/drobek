#!/bin/sh
# drobek dev container entrypoint: sync deps into the anonymous node_modules
# volumes and compile the workspace packages. Core migrations run inside the
# server process on start (runCoreMigrations), same as production.
set -e
cd /repo
echo "drobek: syncing workspace deps..."
# CI=true: non-interactive confirm if pnpm decides to purge/rebuild the
# volume-backed node_modules (no TTY in the container).
CI=true pnpm install --frozen-lockfile
echo "drobek: building workspace packages..."
pnpm build:packages
echo "drobek: starting..."
exec "$@"
