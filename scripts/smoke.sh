#!/usr/bin/env bash
# Quick black-box check of any running deployment.
# Usage: scripts/smoke.sh [BASE_URL]        (default http://localhost:3000)
# Needs: curl, jq. Exits non-zero on the first failed check.
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
BASE_URL="${BASE_URL%/}"
command -v jq >/dev/null || { echo "jq is required (brew install jq / apt-get install jq)" >&2; exit 2; }

pass=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "ok   $*"; }

# fetch URL -> sets $status and $body
fetch() {
  local out
  out="$(curl -sS --max-time 15 -w $'\n%{http_code}' "$1")" || fail "request failed: $1"
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
}

echo "Smoke testing $BASE_URL"

fetch "$BASE_URL/health"
[[ "$status" == 200 ]] || fail "/health returned $status: $body"
ok "/health 200 ($(jq -r .status <<<"$body"))"

fetch "$BASE_URL/api/hotels?city=delhi&refresh=true"
[[ "$status" == 200 ]] || fail "delhi returned $status: $body"
holtin="$(jq -c '.[] | select(.name == "Holtin")' <<<"$body")"
[[ "$holtin" == '{"name":"Holtin","price":5340,"supplier":"Supplier B","commissionPct":20}' ]] \
  || fail "expected Holtin 5340 Supplier B 20, got: $holtin"
ok "delhi: Holtin = 5340 / Supplier B / 20%"
radison="$(jq -c '.[] | select(.name == "Radison")' <<<"$body")"
[[ "$radison" == '{"name":"Radison","price":5900,"supplier":"Supplier A","commissionPct":13}' ]] \
  || fail "expected Radison 5900 Supplier A 13, got: $radison"
ok "delhi: Radison = 5900 / Supplier A / 13%"
jq -e 'all(.[]; (keys | sort) == ["commissionPct","name","price","supplier"])' <<<"$body" >/dev/null \
  || fail "items must have exactly four keys"
jq -e '[.[].price] == ([.[].price] | sort)' <<<"$body" >/dev/null || fail "not sorted by price"
ok "delhi: exactly four keys per item, sorted by price"

fetch "$BASE_URL/api/hotels?city=delhi&minPrice=5000&maxPrice=6000"
[[ "$status" == 200 ]] || fail "filtered returned $status"
jq -e 'length > 0 and all(.[]; .price >= 5000 and .price <= 6000)' <<<"$body" >/dev/null \
  || fail "price filter returned out-of-range items: $body"
ok "price filter 5000..6000 -> $(jq -c '[.[].name]' <<<"$body")"

fetch "$BASE_URL/api/hotels?city=jaipur"
[[ "$status" == 200 && "$body" == "[]" ]] || fail "jaipur expected 200 [], got $status $body"
ok "jaipur -> 200 []"

fetch "$BASE_URL/api/hotels?city=delhi&minPrice=abc"
[[ "$status" == 400 ]] || fail "bad input expected 400, got $status"
[[ "$(jq -r .error.code <<<"$body")" == VALIDATION_ERROR ]] || fail "expected VALIDATION_ERROR"
ok "minPrice=abc -> 400 VALIDATION_ERROR"

echo "All $pass smoke checks passed."
