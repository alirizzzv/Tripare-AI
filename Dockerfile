# One image, two processes: the API (default CMD) and the Temporal worker
# (`node dist/temporal/worker.js`, set in docker-compose.yml).
#
# WHY Debian slim, not Alpine: the Temporal TypeScript SDK ships a native Rust core
# (glibc). Alpine uses musl and would need extra work. Both amd64 and arm64 work.
# WHY no HEALTHCHECK here: the worker has no HTTP server, so healthchecks are defined
# per service in docker-compose.yml instead (api -> GET /ping).

ARG NODE_IMAGE=node:22.23.5-bookworm-slim

# ---- build: compile TypeScript with dev dependencies --------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- deps: production dependencies only -------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime ------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# The official node image already has a non-root "node" user (uid 1000).
USER node
EXPOSE 3000
CMD ["node", "dist/api/server.js"]
