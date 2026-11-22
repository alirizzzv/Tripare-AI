#!/usr/bin/env bash
# Deploy / redeploy on the VM, from the repo directory, as the deploy user:
#   ./scripts/deploy.sh
# Pulls main, rebuilds, waits until /health is ok over HTTPS, runs the smoke test.
set -euo pipefail

cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo ".env missing: cp .env.example .env and set DOMAIN + CHAOS_TOKEN" >&2; exit 1; }
DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2- | tr -d '"' || true)"
[[ -n "$DOMAIN" ]] || { echo "DOMAIN is not set in .env" >&2; exit 1; }

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
previous_sha="$(git rev-parse --short HEAD)"

echo "==> git pull (current $previous_sha)"
git pull --ff-only
current_sha="$(git rev-parse --short HEAD)"

echo "==> build and start"
"${COMPOSE[@]}" up -d --build --remove-orphans

echo "==> wait for https://$DOMAIN/health"
./scripts/wait-healthy.sh "https://$DOMAIN" 180

echo "==> smoke test"
./scripts/smoke.sh "https://$DOMAIN"

"${COMPOSE[@]}" ps
cat <<EOF

Deployed $current_sha to https://$DOMAIN
Rollback hint: git checkout $previous_sha && ${COMPOSE[*]} up -d --build
EOF
