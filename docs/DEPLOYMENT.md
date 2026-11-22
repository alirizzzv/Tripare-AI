# Deployment (single VM, HTTPS)

The production setup is the **same Compose stack** as local, plus an overlay
(`docker-compose.prod.yml`) that:

- publishes **only Caddy** on 80/443 (automatic Let's Encrypt HTTPS),
- publishes **nothing** for Redis, the API or Temporal gRPC (7233),
- publishes the Temporal Web UI on **127.0.0.1:8233 only** (reach it through an SSH tunnel),
- turns on the chaos routes **protected by `CHAOS_TOKEN`**, adds memory limits, log rotation and `restart: unless-stopped`.

> The optional GitHub Actions deploy workflow was skipped on purpose: deploys are one command
> (`scripts/deploy.sh`) and CI already builds and runs the full stack on every push.

## 1. Create the VM

Any Ubuntu 22.04/24.04 VM with ~2 GB RAM works (x86_64 or arm64; images are built on the VM).
Examples: Oracle Cloud Always Free (Ampere A1), Hetzner CX22, GCP e2-small, AWS t4g.small.

1. Create the VM with your SSH public key.
2. Reserve a **static public IP** and attach it.
3. Open inbound **22, 80, 443** in the provider firewall.
   *Oracle Cloud:* open them in the VCN **security list** AND check the instance's own iptables rules.
4. Point a hostname at the IP, for example a free DuckDNS name: `tripare-hotels.duckdns.org → <ip>`.
   Check: `dig +short tripare-hotels.duckdns.org` prints your IP.

## 2. Bootstrap (once)

```bash
ssh ubuntu@<ip>
git clone https://github.com/alirizzzv/Tripare-AI.git && cd Tripare-AI
sudo DEPLOY_USER=deploy bash scripts/bootstrap-vm.sh
```

The script is idempotent. It installs Docker Engine + the Compose plugin (and refuses Compose < 2.24.4),
creates the `deploy` user (in the `docker` group, with your SSH key), enables ufw (22/80/443),
unattended security upgrades, a 2 GB swap file, and key-only SSH without root login.

## 3. Configure and deploy

```bash
ssh deploy@<ip>
git clone https://github.com/alirizzzv/Tripare-AI.git && cd Tripare-AI
cp .env.example .env
# edit .env and set (uncomment) at least:
#   DOMAIN=tripare-hotels.duckdns.org
#   CHAOS_TOKEN=<output of: openssl rand -hex 24>
./scripts/deploy.sh
```

`deploy.sh` pulls `main`, runs
`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`, waits until
`https://$DOMAIN/health` reports `ok` (worker polling included), runs `scripts/smoke.sh` against the
public URL and prints the previous git SHA as a rollback hint.

## 4. Operate

```bash
C="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
$C ps                       # status
$C logs -f api worker       # JSON logs (pino)
$C restart worker           # restart one service
./scripts/deploy.sh         # redeploy latest main
```

**Temporal Web UI without exposing it:**

```bash
ssh -L 8233:localhost:8233 deploy@<ip>
# then open http://localhost:8233 on your laptop
```

**Screenshot for the README:** with the tunnel open, call
`https://$DOMAIN/api/hotels?city=delhi&refresh=true`, open the `hotels-delhi` workflow in the UI,
and capture the event history (two `fetchSupplierHotels` activities started in parallel, then
`persistOffers`). Save it as `docs/images/temporal-ui.png`.

**Run Postman against the live URL:** put the URL and token into `postman/live.postman_environment.json`
locally (do not commit the token), then `npm run test:postman:live`.

## 5. Security checklist (with proof commands)

| Check | Command | Expected |
|---|---|---|
| Internal ports are closed from the internet | from your laptop: `for p in 6379 7233 8233 3000; do nc -zv -w 3 <ip> $p; done` | all fail / time out |
| Public ports are open | `nc -zv <ip> 80` and `nc -zv <ip> 443` | succeed |
| HTTPS works | `curl -sI https://$DOMAIN/ping` | `HTTP/2 200` + `strict-transport-security` header |
| Only Caddy is published | on the VM: `docker compose -f docker-compose.yml -f docker-compose.prod.yml ps` | ports only on caddy (80/443) and temporal `127.0.0.1:8233` |
| Nothing else listens publicly | on the VM: `sudo ss -tlnp` | no `0.0.0.0:6379`, `:7233`, `:3000`; `8233` only on `127.0.0.1` |
| Rendered config matches | `docker compose -f docker-compose.yml -f docker-compose.prod.yml config \| grep -A4 ports:` | same as above |
| Chaos needs the token | `curl -s -o /dev/null -w '%{http_code}' -X POST https://$DOMAIN/__chaos/reset` | `401` |
| `.env` never committed | `git log --all --oneline -- .env` | empty |
| SSH is key-only | on the VM: `sudo sshd -T \| grep -Ei 'passwordauthentication\|permitrootlogin'` | `no` / `no` |

**Important:** ufw does **not** protect Docker-published ports (Docker writes its own iptables rules
that bypass ufw). The real protection is that Redis, Temporal and the API are **not published at all**
in the production overlay. ufw is defense in depth only.
