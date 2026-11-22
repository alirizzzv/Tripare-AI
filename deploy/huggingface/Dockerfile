# All-in-one image for a free Hugging Face Docker Space (one container, one public port).
# The real architecture (separate api / worker / redis / temporal services) is docker-compose.yml;
# this image runs the SAME code and the SAME four processes, just inside one container:
#   redis-server (127.0.0.1:6379) + temporal dev server (127.0.0.1:7233) + worker + api (:7860)
# Test locally from the repo root:  docker build -f deploy/huggingface/Dockerfile -t tripare-space .
# Published by scripts/publish-hf-space.sh, which places this file at the Space root as Dockerfile.

ARG NODE_IMAGE=node:22.23.5-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
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

ENV NODE_ENV=production \
    PORT=7860 \
    REDIS_URL=redis://127.0.0.1:6379 \
    TEMPORAL_ADDRESS=127.0.0.1:7233 \
    TEMPORAL_NAMESPACE=default \
    TEMPORAL_TASK_QUEUE=hotel-offers \
    SUPPLIER_A_URL=http://127.0.0.1:7860/supplierA \
    SUPPLIER_B_URL=http://127.0.0.1:7860/supplierB \
    ENABLE_CHAOS=true \
    CHAOS_TTL_SECONDS=60 \
    LOG_LEVEL=info

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node deploy/huggingface/start.sh ./start.sh
RUN chmod +x ./start.sh

# Hugging Face runs Spaces as uid 1000; the node image's "node" user is uid 1000.
USER node
EXPOSE 7860
CMD ["./start.sh"]
