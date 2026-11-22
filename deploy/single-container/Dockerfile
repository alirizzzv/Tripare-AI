# All-in-one image for free single-container hosts (used for the live demo on Render's free plan).
# The real architecture (separate api / worker / redis / temporal services) is docker-compose.yml.
# This image runs the SAME code and the SAME four processes inside one container:
#   redis-server (127.0.0.1:6379) + temporal dev server (127.0.0.1:7233) + worker + api ($PORT)
# Only the API port is reachable from outside. See render.yaml and docs/DEPLOYMENT.md.
#
# Test locally from the repo root:
#   docker build -f deploy/single-container/Dockerfile -t tripare-single .
#   docker run --rm -p 10000:10000 -m 512m -e CHAOS_TOKEN=test tripare-single

ARG NODE_IMAGE=node:22.23.5-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Compiles TypeScript AND pre-bundles the workflow code (dist/temporal/workflow-bundle.js).
RUN npm run build

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# The Temporal CLI binary (Go, statically linked) from the same pinned image used in Compose.
FROM temporalio/temporal:1.10.0 AS temporal

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends redis-server ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=temporal /usr/local/bin/temporal /usr/local/bin/temporal

# WHY GOMEMLIMIT / NODE_OPTIONS (start.sh): the free plan has 512 MB for all four processes,
# so the Go GC (Temporal) and the V8 heaps are told to stay small.
# PORT is injected by the host (Render sets it; 10000 is Render's default). start.sh points
# the supplier URLs at the same port because the mock suppliers live inside the API.
ENV NODE_ENV=production \
    PORT=10000 \
    REDIS_URL=redis://127.0.0.1:6379 \
    TEMPORAL_ADDRESS=127.0.0.1:7233 \
    TEMPORAL_NAMESPACE=default \
    TEMPORAL_TASK_QUEUE=hotel-offers \
    ENABLE_CHAOS=true \
    CHAOS_TTL_SECONDS=60 \
    LOG_LEVEL=info \
    GOMEMLIMIT=160MiB

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node deploy/single-container/start.sh ./start.sh
RUN chmod +x ./start.sh

USER node
EXPOSE 10000
CMD ["./start.sh"]
