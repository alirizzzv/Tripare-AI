.PHONY: up down logs reset ps smoke wait test test-int postman check

BASE_URL ?= http://localhost:3000

up:        ## build and start the whole stack (api, worker, redis, temporal)
	docker compose up --build -d
	./scripts/wait-healthy.sh $(BASE_URL)

down:      ## stop the stack (keeps the Temporal history volume)
	docker compose down

reset:     ## stop the stack and delete volumes (fresh Temporal history, empty Redis)
	docker compose down -v

logs:      ## follow api + worker logs
	docker compose logs -f api worker

ps:
	docker compose ps

wait:
	./scripts/wait-healthy.sh $(BASE_URL)

smoke:     ## black-box checks against BASE_URL
	./scripts/smoke.sh $(BASE_URL)

test:      ## unit tests (no external services)
	npm test

test-int:  ## integration tests (needs: docker compose up -d redis)
	npm run test:integration

postman:   ## run the Postman collection with newman against the local stack
	npm run test:postman

check:     ## everything CI runs before Docker
	npm run lint && npm run typecheck && npm test && npm run build
