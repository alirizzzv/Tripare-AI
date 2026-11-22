#!/usr/bin/env bash
# Process launcher for the single-container live demo.
# Starts redis, the Temporal dev server, the worker and the API. If ANY of them exits,
# the container exits so the platform restarts it (no half-alive state).
set -euo pipefail

PORT="${PORT:-10000}"
export PORT
# The mock suppliers are routes of the API itself, so they share its port.
export SUPPLIER_A_URL="http://127.0.0.1:${PORT}/supplierA"
export SUPPLIER_B_URL="http://127.0.0.1:${PORT}/supplierB"

# Safety: never expose chaos routes publicly without a token.
if [[ -z "${CHAOS_TOKEN:-}" ]]; then
  echo "CHAOS_TOKEN is not set: disabling chaos routes" >&2
  export ENABLE_CHAOS=false
fi

redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no \
  --maxmemory 32mb --maxmemory-policy volatile-lru &

# In-memory dev server, no Web UI (state resets on restart; the cache refills on the next request).
temporal server start-dev --ip 127.0.0.1 --port 7233 --headless --log-level warn &

# The worker retries its Temporal connection until the dev server is up.
NODE_OPTIONS="--max-old-space-size=160" node dist/temporal/worker.js &
NODE_OPTIONS="--max-old-space-size=96" node dist/api/server.js &

wait -n
echo "a process exited; stopping the container so it is restarted" >&2
exit 1
