# syntax=docker/dockerfile:1.7
# ============================================================================
# drobek — the ONE image (M0-01): dashboard + OAuth AS + MCP RS in one Node
# process (apps/server). Published as ghcr.io/freema/drobek.
#
#   dev     — compose dev target (repo bind-mounted over /repo, Vite HMR)
#   runner  — production image; MUST stay the LAST stage (default target)
#
# `pnpm fetch` needs only the lockfile, so the dependency download layer is
# cached across source changes without copying every package.json by hand.
# ============================================================================

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# --- dev: compose bind-mounts the repo; this install only pre-populates the
# anonymous node_modules volumes so container start is a near-no-op sync.
FROM fetch AS dev
COPY . .
RUN pnpm install --offline --frozen-lockfile
COPY apps/server/docker-entrypoint.sh /usr/local/bin/drobek-dev-entrypoint.sh
RUN chmod +x /usr/local/bin/drobek-dev-entrypoint.sh
ENV NODE_ENV=development
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/drobek-dev-entrypoint.sh"]
CMD ["pnpm", "--filter", "server", "dev"]

# --- builder: compile packages + the server, then carve out a prod-only tree.
FROM fetch AS builder
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm build:packages && pnpm --filter server build
RUN pnpm --filter server deploy --prod --legacy /out \
 # typescript is only an optional peer of @react-router/{node,express} (typegen);
 # nothing loads it at runtime. Workspace `src/` trees are types-only.
 && rm -rf /out/node_modules/.pnpm/typescript@* /out/node_modules/.pnpm/node_modules/typescript \
 && find /out/node_modules/.pnpm -path '*/node_modules/@drobek/*/src' -type d -prune -exec rm -rf {} +

# --- runner: production image (no pnpm, no devDependencies, non-root).
FROM node:22-alpine AS runner
# The runtime needs only `node` — drop the bundled package managers.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production \
    PORT=3000
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
WORKDIR /app
COPY --from=builder --chown=node:node /out/package.json ./package.json
COPY --from=builder --chown=node:node /out/node_modules ./node_modules
COPY --from=builder --chown=node:node /out/build ./build
COPY --from=builder --chown=node:node /out/dist ./dist
# M1-01: general skills for skill_info (skills/<name>/SKILL.md; the platform
# skill skills/drobek is shipped too but never listed).
COPY --from=builder --chown=node:node /repo/skills ./skills
# M1-05: FILES_DIR of the files module. Owned by `node`, so a fresh named
# volume mounted here inherits a writable directory.
RUN mkdir -p /data/files && chown node:node /data/files
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget -q -T 5 -O - http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/server/index.js"]
