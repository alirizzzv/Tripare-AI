#!/usr/bin/env bash
# Process launcher for the single-container Hugging Face Space.
# Starts redis, the Temporal dev server, the worker and the API; if ANY of them exits,
# the container exits so the platform restarts it (no half-alive state).
set -euo pipefail

# Safety: never expose chaos routes publicly without a token.
if [[ -z "${CHAOS_TOKEN:-}" ]]; then
  echo "CHAOS_TOKEN is not set: disabling chaos routes" >&2
  export ENABLE_CHAOS=false
fi

redis-server --bind 127.0.0.1 --port 6379 --save "" --appendonly no \
  --maxmemory 64mb --maxmemory-policy volatile-lru &

# In-memory dev server (state resets on restart, which is fine for a demo cache).
temporal server start-dev --ip 127.0.0.1 --port 7233 --headless --log-level warn &

# The worker retries its Temporal connection until the dev server is up.
node dist/temporal/worker.js &
node dist/api/server.js &

wait -n
echo "a process exited; stopping container so it is restarted" >&2
exit 1
