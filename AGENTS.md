# AGENTS.md — Hotel Offer Orchestrator (master context, v3)

Every prompt starts with: "Read AGENTS.md first. Do PROMPT N only."

## ROLE

You are a senior backend engineer building a take-home assessment for Tripare AI (a corporate travel startup, Gurugram, ~9 people). Reviewers will read the code, read the README, run the Docker setup, import the Postman collection and open a live URL. Pragmatic, working, well-explained software beats clever architecture. Everything must run from a fresh clone. Think production engineering, but do not add technology or features just to look complex.

## PROJECT: "Hotel Offer Orchestrator"

Stack: Node.js + TypeScript (strict), Express, Temporal.io, Redis, Docker Compose.

## SPEC (from the assessment, non-negotiable)

- Two mock supplier APIs INSIDE this same service: `GET /supplierA/hotels` and `GET /supplierB/hotels`. Record shape: `{hotelId, name, price, city, commissionPct}`. Must contain overlapping hotel names across A and B.
- `GET /api/hotels?city=delhi`: a Temporal workflow calls Supplier A and Supplier B in parallel, dedupes hotels by name, keeps the cheaper offer when both suppliers have the hotel, keeps the single offer when only one has it, returns the deduplicated list. The list must also be saved in Redis.
- `GET /api/hotels?city=delhi&minPrice=<min>&maxPrice=<max>`: price filtering must happen INSIDE Redis (not in Node code).
- Response: a bare JSON array. Each item has exactly these four keys and nothing else: `{"name","price","supplier","commissionPct"}`. `supplier` is the string `"Supplier A"` or `"Supplier B"`.
- Deliverables: Dockerfile + docker-compose, README with clear setup and deployment steps, Postman collection JSON (valid city with overlaps, city with no results, one supplier down = optional).
- Bonus: `GET /health` reporting health of both suppliers; logging and error handling in activities/workflows.
- Extra goal: a live deployed URL.
- The original assessment PDF may be provided separately. Never commit it to the repo.

## INVARIANTS (every one needs at least one test; PROMPT 9 traces them)

- **I1.** Every response item has exactly four keys; the body is a bare array.
- **I2.** Both suppliers down never yields HTTP 200 and never writes the cache.
- **I3.** A reader never sees a half-written list (writes are one MULTI).
- **I4.** Price filtering happens only in Redis (`ZRANGEBYSCORE`), bounds inclusive, applied to the post-dedupe best price.
- **I5.** Workflow code is deterministic and imports only `@temporalio/workflow` and specific pure files under `src/domain`.
- **I6.** Concurrent cold requests for the same city share ONE workflow run (workflow ID + `USE_EXISTING`).
- **I7.** `persistOffers` is idempotent.
- **I8.** The city is normalized by the same function everywhere (API edge, repo, workflow ID). User input never reaches a Redis key un-normalized and un-validated.
- **I9.** Degraded results live at most `DEGRADED_TTL_SECONDS`.
- **I10.** `/health` never throws or leaks internals, and is never used for a container healthcheck or `depends_on`.
- **I11.** In production Redis and the api port are not published; Temporal is published on `127.0.0.1` only; only Caddy publishes 80/443.
- **I12.** Chaos routes do not exist unless `ENABLE_CHAOS=true`; with `CHAOS_TOKEN` set, a missing or wrong token gives 401; every non-ok chaos mode auto-reverts.
- **I13.** Error responses always use the shape in Decision 14; no stack traces or secrets in any response.

## LOCKED DECISIONS (do not change without asking)

1. Tie on price: higher `commissionPct` wins; if still tied, Supplier A wins. Implemented as one small pure function.
2. "Same hotel" = same name after this exact normalization (no fuzzy matching): (1) `normalize('NFKC')`; (2) `toLowerCase()`; (3) delete apostrophe-like characters (`' ‘ ’`); (4) replace every run of characters that are not letters or digits (`/[^\p{L}\p{N}]+/gu`) with ONE space; (5) trim. Diacritics are NOT stripped ("Café" and "Cafe" are different hotels). Examples: `"Taj-Mahal"` = `"Taj Mahal"`; `"St. Regis"` = `"St Regis"`; `"O'Brien"` = `"OBrien"`; full-width `"ＨＯＬＴＩＮ"` = `"Holtin"`; `"Hilton"` and `"Hilton Garden Inn"` stay separate. A name that normalizes to an empty string is an invalid record. Keep the winning offer's original display name. `normalizeCity()` = NFKC, trim, lowercase, collapse internal whitespace.
3. Cache-first: a Redis hit is served directly; a miss or `?refresh=true` runs the Temporal workflow.
4. One supplier down: return the other supplier's results with headers `X-Degraded: true` and `X-Failed-Suppliers: <supplierA|supplierB>`, cached for only 60s. Both suppliers down: HTTP 503, nothing cached. Never turn "both down" into an empty `[]`. (Accepted trade-off: `refresh=true` with both down returns 503 even if a stale cache exists. The existing cache is left untouched. Document it in the README.)
5. Valid city with no hotels: `200 []`. Missing/blank/invalid city: 400. "Invalid" = fails the Zod city rule (1-60 chars, letters/spaces/hyphens/dots only, as a single string value).
6. Cache TTL 600s via env `CACHE_TTL_SECONDS`; degraded TTL 60s via `DEGRADED_TTL_SECONDS`.
7. Cold cache + price-range request: run the workflow, save, then filter. Both endpoints share one read path. The filter applies to the best (post-dedupe) price, not raw offers. Bounds are inclusive. Results are sorted by price ascending. Ties in price are ordered by the lexicographic order of the serialized member string `serializeOffer(offer)`. Redis orders equal scores by member bytes and the API always serves from Redis, so `serializeOffer` lives in `src/domain` (pure), is used for the ZADD member AND as the tie-break comparator in `mergeBestOffers`. (Do not use `localeCompare` or compare plain names: `"Hilton Garden Inn"` sorts before `"Hilton"` in member order because a space sorts before a quote.)
8. Temporal runs as the dev-server container in Docker (with Web UI on 8233).
9. Chaos endpoint simulates supplier failure. In-memory, auto-reverts, token-protected when `CHAOS_TOKEN` is set. `delayMs` is an integer 0-10000. Request bodies are limited to 10kb.
10. `commissionPct` is ASSUMED to be "our earning on the selling price". This is an assumption; say so in the README.
11. Supplier HTTP timeout `SUPPLIER_TIMEOUT_MS` default 2500 (must stay BELOW the 3s activity `startToCloseTimeout`, so our clean AbortController error fires before Temporal's own timeout).
12. Healthchecks: the container healthcheck for the api uses `GET /ping` (liveness). `/health` (suppliers + Redis + Temporal reachability + worker poller check) is for humans, monitors and SCRIPTS (`scripts/wait-healthy.sh`, `deploy.sh`, `smoke.sh` may poll it as a readiness gate). It is NEVER used for a container healthcheck or `depends_on`. Reason: `/health` reports "down" until a worker polls, and the worker must not wait on the api, so using it would deadlock startup. The poller check (`describeTaskQueue`, verify the API in the installed SDK) is REQUIRED, not a stretch.
13. Host ports: base `docker-compose.yml` publishes dev ports (api 3000, redis 6379, temporal 7233 and 8233). `docker-compose.prod.yml` must NOT publish them: Compose MERGES ports lists across files, so the overlay has to use `ports: !reset []` (needs Compose >= 2.24) for api and redis, and `ports: !override ["127.0.0.1:8233:8233"]` for temporal (needs Compose >= 2.24.4; loopback only, so an SSH tunnel to the Temporal UI works but the internet cannot reach it). Only Caddy publishes 80/443. Verify with `docker compose -f docker-compose.yml -f docker-compose.prod.yml config`. A valid config is not enough; read the ports.
14. ERROR CONTRACT (one table, used by code, tests, README and Postman). Body is always `{"error":{"code","message","details?"}}`.

| Situation | HTTP | code | Extra header |
| --- | --- | --- | --- |
| bad/missing/blank city, bad prices, min>max, bad refresh, repeated or array/object query params, bad chaos body, malformed JSON | 400 | VALIDATION_ERROR | |
| unknown route | 404 | NOT_FOUND | |
| missing/wrong x-chaos-token | 401 | UNAUTHORIZED | |
| request body too large | 413 | PAYLOAD_TOO_LARGE | |
| both suppliers failed (workflow ALL_FAILED) | 503 | SUPPLIERS_UNAVAILABLE | Retry-After: 10 |
| Redis unreachable/failing on read, or cache unexpectedly empty (hit=false) after a successful run | 503 | CACHE_UNAVAILABLE | |
| Temporal unreachable (cannot start the workflow) | 503 | ORCHESTRATOR_UNAVAILABLE | |
| workflow ended in failure that is not ALL_FAILED (e.g. persist exhausted retries) | 503 | WORKFLOW_FAILED | |
| workflow did not finish within WORKFLOW_WAIT_MS (workflow keeps running) | 504 | WORKFLOW_TIMEOUT | |
| anything else | 500 | INTERNAL_ERROR | (generic message; details only in logs) |

## REDIS MODEL

- `hotels:{city}:offers` -> sorted set, member = `serializeOffer(offer)` (JSON, key order: name, price, supplier, commissionPct), score = price
- `hotels:{city}:meta` -> hash `{degraded, failedSuppliers, fetchedAt}`
- `{city}` is `normalizeCity()` output, validated at the API edge.
- Write atomically with MULTI: DEL both keys, ZADD offers (if any), HSET meta, EXPIRE both. Meta is ALWAYS written so "cached but empty" differs from "cold".
- Read in one MULTI: HGETALL meta + ZRANGEBYSCORE offers min max (missing bound = -inf / +inf, inclusive).
- Redis is a REQUIRED dependency (Redis down => 503).
- Known accepted window: a request that missed the cache just before a run completed may start one extra run. It is bounded (one extra run, not a storm). Document it, do not "fix" it.

## TEMPORAL RULES

- Workflow code must be deterministic: no I/O, no `Date.now`, no `Math.random`, no imports of logger/config/redis. Workflow files may import only `@temporalio/workflow` and SPECIFIC pure files under `src/domain` (e.g. `merge.ts`, `types.ts`). Never import `schemas.ts` (pulls zod) or any barrel/index file into workflow code. Use `import type` where possible.
- All HTTP/Redis work is in activities. Fan out with `Promise.allSettled` so one failure does not kill the run.
- Activity options: `startToCloseTimeout` 3s, `scheduleToCloseTimeout` ~6s, retry `maximumAttempts` 3 with short exponential backoff (initial ~200ms, coefficient 2, max ~1s). Permanent errors are non-retryable `ApplicationFailure`: HTTP 4xx EXCEPT 408 and 429 (those are retryable), and schema-invalid or non-array payloads.
- Retry math (state it honestly in the README, and confirm it in the Temporal UI/event history before writing it): fast failures (e.g. 503) get all 3 attempts. A SLOW supplier: attempt 1 is aborted at 2.5s; retry after ~200ms; attempt 2 runs ~2.7s to ~5.2s; retry after ~400ms; attempt 3 would start at ~5.6s and is cut off at 6s by `scheduleToCloseTimeout`. So: "two full attempts plus a truncated third". Total worst case stays under `WORKFLOW_WAIT_MS` (8000). Write what the UI actually shows, not what this paragraph predicts.
- Workflow ID = `hotels-{normalizedCity}` and must be injective in the normalized city: use the normalized city as-is or `encodeURIComponent` it; NEVER a lossy replacement (e.g. spaces -> hyphens would make `"new delhi"` and `"new-delhi"` share one run and return the wrong city's data). Use `workflowIdConflictPolicy USE_EXISTING` (verify the exact option/enum name in the installed SDK types) so concurrent requests share one run. After a run completes, a later request correctly starts a NEW run; that is expected.
- API waits for the workflow at most `WORKFLOW_WAIT_MS` (default 8000), then returns 504 without terminating the workflow.
- `runHotelWorkflow` maps failures to typed AppErrors (Decision 14) so route code stays simple. The Temporal client is a lazily created singleton, not one connection per request.
- `persistOffers` must be idempotent (DEL + ZADD again gives the same state).
- Test environments: use `TestWorkflowEnvironment.createLocal()` (a real dev server) for anything involving workflow ID conflict policy, concurrency, retries/timeouts. The SDK docs say the time-skipping test server does not support the full server feature set and may behave differently. The test server binary downloads on first run (needs network).
- Worker workflow bundling: bundling workflows with webpack at worker startup can use a lot of memory. PROMPT 5 measures the worker's startup peak and pre-bundles with `bundleWorkflowCode` (verify in installed types) if it would not fit comfortably in the prod memory limit. Report the measured number.

## DOCKER / COMPOSE RULES

- One image, two commands (api, worker). Debian-slim Node base (NOT Alpine; Temporal TS SDK ships native binaries; confirm arm64 + x86_64 both work). Non-root user.
- Do NOT put HEALTHCHECK in the Dockerfile (the image is shared with the worker, which has no HTTP server). Define healthchecks per service in compose.
- `node:slim` has no curl/wget. api healthcheck command: `node -e "fetch('http://127.0.0.1:3000/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.
- worker `depends_on`: temporal + redis healthy ONLY (never api). The worker retries its Temporal connection at startup anyway.
- Inside compose, supplier URLs are `http://api:3000/supplierA` and `/supplierB` (never localhost). For `npm run dev:*` outside Docker, `.env.example` defaults use localhost.
- Temporal dev DB lives on a named volume. Verify the container user can write it and that workflow history survives `docker compose restart temporal`.
- Pin every image to an exact tag (for Redis an exact 7.x.y patch tag, not `redis:7`); look up current tags, do not trust memory.
- Caddy (prod): `caddy_data` and `caddy_config` must be named volumes so certificates survive redeploys (avoids re-issuing and Let's Encrypt rate limits).
- ufw does NOT filter Docker-published ports. Real protection = not publishing Redis/Temporal at all (Decision 13). ufw is defense in depth only; never claim otherwise.
- SSH hardening in `bootstrap-vm.sh`: key-only login, no root login, via a drop-in file that sorts BEFORE cloud-init's (sshd uses the first value it reads); validate with `sshd -t`, reload (not restart), verify with `sshd -T`, and only apply if the deploy user already has an authorized key.

## QUALITY BAR

- TypeScript strict (also `noUncheckedIndexedAccess`). ESLint + Prettier. No `any` without a comment.
- Zod for all external input: query params AND supplier responses. A bad supplier record is skipped and logged; it does not fail the whole supplier. Repeated or array query params (`city[]=a`, `city=a&city=b`) are rejected with 400.
- pino JSON logs with `requestId` / `workflowId` / `supplier` / `city` fields. One central Express error handler (Decision 14) that logs 5xx at error level. `x-powered-by` disabled. JSON body limit 10kb.
- Config only via env vars, validated at startup with Zod. Provide `.env.example`. Never commit secrets.
- Prefer CommonJS output (fewer Temporal bundling surprises) unless the SDK docs say otherwise.
- Verify any version, image tag, CLI flag or API name against current official docs instead of trusting memory. Pin versions. Before pinning the Node LTS, confirm the installed Temporal TS SDK supports that Node version (native binaries). State which Express major you pinned.
- Dependency budget: only the packages named in the prompts. If you need another, ask first and list it in the report.
- Non-obvious decision (Redis/Temporal/Docker semantics): add a one-line `WHY:` comment next to the code, including the alternative you rejected.

## TEST LAYERS (keep it lean; there is NO separate e2e suite)

- `tests/unit` (`npm test`, fast, no external services): pure domain, mocked-dependency API tests with supertest, activity tests with mocked fetch.
- `tests/integration` (`npm run test:integration`): needs a real Redis (`docker compose up -d redis`) and uses Redis DB index 1 (`redis://localhost:6379/1`, overridable with `TEST_REDIS_URL`) with unique city names and cleanup in `afterAll`, so tests never touch the dev cache in DB 0. Temporal workflow tests use `TestWorkflowEnvironment.createLocal()` (see Temporal rules).
- Newman (`npm run test:postman`) is the black-box end-to-end check against the compose stack; `scripts/smoke.sh` is the quick check for any base URL.
- Never use sleeps without reason; prefer fake timers or polling helpers.
- Every bug you fix gets a regression test. Fix the root cause, not the symptom.

## EVIDENCE RULES (apply to every report, README line and interview note)

- Label anything you state as MEASURED (you ran it and saw it), ESTIMATED (reasoned, not run) or NOT TESTED.
- Never invent numbers, benchmarks, screenshots or test results. Never say something passes unless you ran it and saw it pass.
- Review findings use this format: Severity (Critical/High/Medium/Low), realistic failure scenario, why the design fails, concrete fix, test that proves it.
- Failure-analysis entries use: Scenario / Expected / Actual / Root cause / Fix / Verification evidence.

## REPO LAYOUT

```
src/config/env.ts
src/lib/{logger,errors,redis,temporalClient}.ts
src/domain/{types,schemas,normalize,pickBest,merge,serialize}.ts
src/suppliers/{mockData,mockRouter,chaos}.ts
src/temporal/{constants,activities,workflows,worker}.ts
src/redis/offersRepo.ts
src/api/{app,server}.ts
src/api/routes/{hotels,health}.ts
tests/{unit,integration}/
scripts/{smoke.sh,wait-healthy.sh,bootstrap-vm.sh,deploy.sh}
postman/ docs/ bench/
Dockerfile, docker-compose.yml, docker-compose.prod.yml
```

## WORKING RULES (every prompt)

1. Do ONLY the prompt I give you. When done, STOP. Never start the next prompt on your own.
2. Time box: each prompt states one. If you are about to blow it, stop at a working state and tell me what is left. A working smaller thing beats a broken bigger thing.
3. Before finishing: run lint, typecheck, and all tests that exist so far. Do not claim anything passes unless you ran it and saw it pass. Paste the real output summary (the last lines, not the whole log).
4. Commit with conventional messages (`feat:`, `test:`, `chore:`, `docs:`). One commit per sub-part when a prompt lists several. Never commit `.env` or `node_modules`.
5. Ambiguity: if it changes business behaviour (what a response contains, price/commission/ordering rules, status codes, what is cached), STOP and ask me; do not invent business logic. If it is purely technical or tooling (file naming, a library choice inside the dependency budget, a config detail), pick the simplest option, keep going, and list it under "assumptions". If a locked decision conflicts with reality (SDK API differs, tool missing), STOP and tell me.
6. Final report, max ~40 lines: (a) files created/changed, (b) commands run + results, (c) deviations or assumptions, (d) open questions, (e) what I should read/understand before moving on (file + one line each), (f) anything NOT tested.
7. Keep code readable and commented where Temporal/Redis semantics are non-obvious. I must be able to explain every file in an interview.
