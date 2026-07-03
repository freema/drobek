#!/bin/sh
set -e
cd /repo
echo "drobek mcp: syncing workspace deps (bind mounts + anonymous node_modules volumes)..."
# CI=true: non-interactive confirm if pnpm decides to purge/rebuild the
# volume-backed node_modules (no TTY in the container).
CI=true pnpm install --frozen-lockfile
echo "drobek mcp: building workspace packages..."
pnpm --filter @drobek/db build
pnpm --filter @drobek/core build
pnpm --filter @drobek/auth build
pnpm --filter @drobek/tenancy build
pnpm --filter @drobek/deploy build
pnpm --filter @drobek/oauth build
pnpm --filter @drobek/sdk build
cd /repo/apps/mcp-server
echo "drobek mcp: starting..."
exec "$@"
