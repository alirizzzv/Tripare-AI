#!/usr/bin/env bash
# Poll GET /health until the whole system is ready (suppliers + Redis + Temporal + a polling worker).
# Usage: scripts/wait-healthy.sh [BASE_URL] [TIMEOUT_SECONDS]
# This is a readiness gate for scripts. Container healthchecks use /ping (AGENTS.md Decision 12).
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
TIMEOUT="${2:-120}"
deadline=$((SECONDS + TIMEOUT))

printf 'Waiting for %s/health to report ok (timeout %ss)' "$BASE_URL" "$TIMEOUT"
while ((SECONDS < deadline)); do
  body="$(curl -fsS --max-time 3 "$BASE_URL/health" 2>/dev/null || true)"
  if [[ "$body" == *'"status":"ok"'* ]]; then
    printf '\nReady: %s\n' "$body"
    exit 0
  fi
  printf '.'
  sleep 2
done

printf '\nTimed out. Last /health response:\n%s\n' "${body:-<no response>}" >&2
exit 1
