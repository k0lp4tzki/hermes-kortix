# syntax=docker/dockerfile:1
# One image for both runtime roles of Hermes: `api` (HTTP API + web UI) and `worker`
# (scheduler, discovery, checks, state engine, alerting). The role is selected by the command.
FROM node:22-bookworm-slim AS base
RUN npm install -g pnpm@11.15.1 >/dev/null 2>&1
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile
COPY server server
COPY web web
RUN pnpm --filter @hermes/server build && pnpm --filter @hermes/web build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --prod --filter @hermes/server

FROM node:22-bookworm-slim AS runtime
# iputils-ping: ICMP checks (needs CAP_NET_RAW, granted in docker-compose.yml)
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HERMES_WEB_DIR=/app/web \
    HERMES_MIGRATIONS_DIR=/app/server/migrations
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/server/node_modules /app/server/node_modules
COPY --from=build /app/server/dist /app/server/dist
COPY --from=build /app/server/package.json /app/server/package.json
COPY server/migrations /app/server/migrations
COPY --from=build /app/web/dist /app/web
WORKDIR /app/server
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/api/main.js"]
