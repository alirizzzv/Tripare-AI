#!/usr/bin/env bash
# One-time, idempotent VM setup (Ubuntu 22.04/24.04, x86_64 or arm64). Run as root:
#   sudo DEPLOY_USER=deploy bash scripts/bootstrap-vm.sh
# Installs Docker Engine + Compose plugin (official apt repo), creates a deploy user,
# enables ufw (22/80/443), unattended security upgrades, a swap file, and key-only SSH.
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || { echo "this script targets Ubuntu; got ${ID:-unknown}" >&2; exit 1; }
echo "==> Ubuntu ${VERSION_ID} on $(dpkg --print-architecture)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git jq ufw unattended-upgrades

# --- Docker Engine (https://docs.docker.com/engine/install/ubuntu/) ----------------------
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
echo "==> $(docker --version); $(docker compose version)"
# !reset / !override in docker-compose.prod.yml need Compose >= 2.24.4.
compose_ver="$(docker compose version --short | sed 's/^v//')"
if [[ "$(printf '%s\n2.24.4\n' "$compose_ver" | sort -V | head -n1)" != "2.24.4" ]]; then
  echo "Docker Compose $compose_ver is older than 2.24.4" >&2
  exit 1
fi

# --- deploy user ---------------------------------------------------------------------
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
# Copy the invoking user's keys so you can SSH in as the deploy user.
if [[ -n "${SUDO_USER:-}" && -f "/home/$SUDO_USER/.ssh/authorized_keys" ]]; then
  touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
  sort -u "/home/$SUDO_USER/.ssh/authorized_keys" "/home/$DEPLOY_USER/.ssh/authorized_keys" \
    -o "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
  chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
fi

# --- firewall (defense in depth only: ufw does NOT filter Docker-published ports) ---------
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

# --- automatic security updates ------------------------------------------------------
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# --- swap (small VMs: the worker bundles workflow code with webpack at start-up) ---------
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- SSH hardening: key-only, no root login -------------------------------------------
# Only if the deploy user can already log in with a key, so we never lock ourselves out.
# The drop-in name sorts BEFORE cloud-init's 50-cloud-init.conf; sshd keeps the first value it reads.
if [[ -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ]]; then
  cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin)'
else
  echo "WARNING: $DEPLOY_USER has no authorized_keys; SSH hardening skipped." >&2
fi

echo "==> Done. Next: log in as $DEPLOY_USER, clone the repo, create .env, run scripts/deploy.sh"
