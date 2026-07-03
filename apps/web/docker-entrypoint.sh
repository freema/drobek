#!/bin/sh
set -e
cd /repo
echo "drobek web: syncing workspace deps (bind mounts + anonymous node_modules volumes)..."
# CI=true: non-interactive confirm if pnpm decides to purge/rebuild the
# volume-backed node_modules (no TTY in the container).
CI=true pnpm install --frozen-lockfile
echo "drobek web: building workspace packages..."
pnpm --filter @drobek/db build
pnpm --filter @drobek/core build
pnpm --filter @drobek/auth build
pnpm --filter @drobek/tenancy build
pnpm --filter @drobek/serving build
pnpm --filter @drobek/deploy build
pnpm --filter @drobek/oauth build
pnpm --filter @drobek/sdk build
echo "drobek web: applying core Drizzle migrations (journal __drizzle_migrations_core)..."
pnpm --filter @drobek/db db:migrate
cd /repo/apps/web
echo "drobek web: starting..."
exec "$@"
