---
title: Tripare Hotel Offer Orchestrator
emoji: 🏨
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
short_description: Temporal + Redis hotel offer aggregator (Tripare take-home)
---

# Hotel Offer Orchestrator (live demo)

Source code, architecture and tests: https://github.com/alirizzzv/Tripare-AI

Try it:

- `/api/hotels?city=delhi`
- `/api/hotels?city=delhi&minPrice=5000&maxPrice=6000`
- `/api/hotels?city=jaipur`
- `/health`

This Space runs the same code as the repository's Docker Compose stack, packed into one
container (Redis, Temporal dev server, worker and API) because Spaces expose a single port.
