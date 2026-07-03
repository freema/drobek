# syntax=docker/dockerfile:1
# drobek — mcp-server DEV image. Same bind-mount + anonymous-volume model as
# apps/web/Dockerfile.
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/mcp-server/package.json ./apps/mcp-server/
COPY packages/db/package.json ./packages/db/
COPY packages/core/package.json ./packages/core/
COPY packages/auth/package.json ./packages/auth/
COPY packages/tenancy/package.json ./packages/tenancy/
COPY packages/serving/package.json ./packages/serving/
COPY packages/deploy/package.json ./packages/deploy/
COPY packages/data/package.json ./packages/data/
COPY packages/agent-dx/package.json ./packages/agent-dx/
# @drobek/dashboard is web-only, but apps/web/package.json (copied above)
# references it — the workspace-wide frozen install needs its manifest present.
COPY packages/dashboard/package.json ./packages/dashboard/
COPY packages/oauth/package.json ./packages/oauth/
COPY packages/sdk/package.json ./packages/sdk/
COPY tests-e2e/package.json ./tests-e2e/

RUN pnpm install --frozen-lockfile

COPY packages ./packages
RUN pnpm --filter @drobek/db build \
 && pnpm --filter @drobek/core build \
 && pnpm --filter @drobek/auth build \
 && pnpm --filter @drobek/tenancy build \
 && pnpm --filter @drobek/serving build \
 && pnpm --filter @drobek/deploy build \
 && pnpm --filter @drobek/data build \
 && pnpm --filter @drobek/agent-dx build \
 && pnpm --filter @drobek/oauth build \
 && pnpm --filter @drobek/sdk build
COPY apps/mcp-server ./apps/mcp-server

COPY apps/mcp-server/docker-entrypoint.sh /usr/local/bin/drobek-mcp-entrypoint.sh
RUN chmod +x /usr/local/bin/drobek-mcp-entrypoint.sh

WORKDIR /repo/apps/mcp-server

ENV NODE_ENV=development
EXPOSE 3001

ENTRYPOINT ["/usr/local/bin/drobek-mcp-entrypoint.sh"]
CMD ["pnpm", "run", "dev"]
