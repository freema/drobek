# syntax=docker/dockerfile:1
# drobek — web DEV image. The compose file bind-mounts the repo over /repo and
# masks every node_modules with an anonymous volume; the install baked in here
# pre-populates those volumes so container start is a near-no-op sync.
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
COPY packages/insights/package.json ./packages/insights/
COPY packages/serving/package.json ./packages/serving/
COPY packages/deploy/package.json ./packages/deploy/
COPY packages/audit/package.json ./packages/audit/
COPY packages/data/package.json ./packages/data/
COPY packages/proxy/package.json ./packages/proxy/
COPY packages/agent-dx/package.json ./packages/agent-dx/
COPY packages/dashboard/package.json ./packages/dashboard/
COPY packages/oauth/package.json ./packages/oauth/
COPY packages/sdk/package.json ./packages/sdk/
COPY tests-e2e/package.json ./tests-e2e/

RUN pnpm install --frozen-lockfile

COPY packages ./packages
RUN pnpm --filter @drobek/db build \
 && pnpm --filter @drobek/core build \
 && pnpm --filter @drobek/audit build \
 && pnpm --filter @drobek/auth build \
 && pnpm --filter @drobek/tenancy build \
 && pnpm --filter @drobek/insights build \
 && pnpm --filter @drobek/serving build \
 && pnpm --filter @drobek/deploy build \
 && pnpm --filter @drobek/data build \
 && pnpm --filter @drobek/proxy build \
 && pnpm --filter @drobek/agent-dx build \
 && pnpm --filter @drobek/dashboard build \
 && pnpm --filter @drobek/oauth build \
 && pnpm --filter @drobek/sdk build
COPY apps/web ./apps/web

COPY apps/web/docker-entrypoint.sh /usr/local/bin/drobek-web-entrypoint.sh
RUN chmod +x /usr/local/bin/drobek-web-entrypoint.sh

WORKDIR /repo/apps/web

ENV NODE_ENV=development
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/drobek-web-entrypoint.sh"]
CMD ["pnpm", "run", "dev"]
