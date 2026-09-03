#!/usr/bin/env bash
#
# WireGuard Console — one-command installer for Ubuntu.
#
#   curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/install.sh | sudo bash
#
# What this does, in order: verifies you're on a supported Ubuntu release,
# installs Docker if it isn't present, installs WireGuard's kernel tools,
# frees port 53 from systemd-resolved (needed by the built-in DNS filter),
# enables IP forwarding (required for WireGuard routing), clones/updates
# this repo into /opt/wireguard-console, generates secrets on first
# install, opens the firewall if ufw is active, and starts the stack with
# Docker Compose. Re-running it later updates an existing install instead
# of reinstalling.
#
# Read before piping this into root bash — that's the whole point of it
# being a plain, commented script instead of a binary.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (override any of these by exporting them before running)
# ---------------------------------------------------------------------------
REPO="${WGCONSOLE_REPO:-garyhooi/wireguard-console}"
BRANCH="${WGCONSOLE_BRANCH:-main}"
INSTALL_DIR="${WGCONSOLE_DIR:-/opt/wireguard-console}"
MIN_UBUNTU_VERSION="22.04"
WG_DEFAULT_PORT="51820"

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
info()  { echo -e "\033[1;34m[info]\033[0m  $*"; }
warn()  { echo -e "\033[1;33m[warn]\033[0m  $*"; }
error() { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Must be root (needs apt, systemd, Docker, firewall access)
# ---------------------------------------------------------------------------
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  error "Run this as root, e.g.: curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh | sudo bash"
fi

# ---------------------------------------------------------------------------
# 2. Must be Ubuntu, warn (don't hard-fail) if older than MIN_UBUNTU_VERSION
# ---------------------------------------------------------------------------
[[ -f /etc/os-release ]] || error "Cannot detect the OS (no /etc/os-release). This installer supports Ubuntu only."
# shellcheck disable=SC1091
. /etc/os-release

if [[ "${ID:-}" != "ubuntu" ]]; then
  error "This installer supports Ubuntu only (detected: ${PRETTY_NAME:-unknown}). For other distros, follow the manual setup in the README instead."
fi

info "Detected ${PRETTY_NAME}"

if command -v dpkg >/dev/null 2>&1; then
  if ! dpkg --compare-versions "${VERSION_ID:-0}" ge "${MIN_UBUNTU_VERSION}"; then
    warn "Ubuntu ${VERSION_ID:-unknown} is older than the tested baseline (${MIN_UBUNTU_VERSION} LTS+)."
    warn "Continuing anyway, but if Docker or WireGuard steps fail below, upgrading Ubuntu is the first thing to try."
  fi
fi

# ---------------------------------------------------------------------------
# 3. Docker + Compose plugin
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  info "Docker already installed ($(docker --version))"
fi

if ! docker compose version >/dev/null 2>&1; then
  error "Docker is installed but the 'docker compose' plugin isn't available. Install docker-compose-plugin and re-run."
fi

# ---------------------------------------------------------------------------
# 4. WireGuard kernel module + userspace tools
# ---------------------------------------------------------------------------
info "Installing WireGuard tools..."
apt-get update -qq
apt-get install -y -qq wireguard wireguard-tools git openssl >/dev/null

if ! modprobe wireguard 2>/dev/null; then
  warn "Could not load the WireGuard kernel module directly."
  warn "On older LTS kernels this usually means you need the HWE kernel: apt install --install-recommends linux-generic-hwe-\$(lsb_release -rs)"
  warn "Continuing — the wg-helper container installs wireguard-tools too and may still work if the module loads another way."
fi

# ---------------------------------------------------------------------------
# 5. Free port 53 from systemd-resolved's stub listener
#    (AdGuard Home needs it — this is the single most common snag on Ubuntu)
# ---------------------------------------------------------------------------
if systemctl is-active --quiet systemd-resolved 2>/dev/null; then
  info "Freeing port 53 from systemd-resolved's stub listener..."
  mkdir -p /etc/systemd/resolved.conf.d
  cat > /etc/systemd/resolved.conf.d/no-stub.conf <<'EOF'
[Resolve]
DNSStubListener=no
EOF
  # Point /etc/resolv.conf at systemd-resolved's *non-stub* file so the host
  # itself keeps working DNS resolution after the stub listener goes away.
  ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
  systemctl restart systemd-resolved
  info "Port 53 is free for AdGuard Home."
else
  info "systemd-resolved stub listener not active — nothing to change."
fi

# ---------------------------------------------------------------------------
# 6. Enable IP forwarding — required for WireGuard to route traffic
# ---------------------------------------------------------------------------
info "Enabling IPv4 forwarding (persisted)..."
sysctl -w net.ipv4.ip_forward=1 >/dev/null
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-wgconsole.conf

# ---------------------------------------------------------------------------
# 7. Fetch (or update) the repo
# ---------------------------------------------------------------------------
UPGRADE=false
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  info "Existing install found at ${INSTALL_DIR} — updating"
  git -C "${INSTALL_DIR}" fetch --depth 1 origin "${BRANCH}"
  git -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}"
  UPGRADE=true
else
  info "Cloning ${REPO} (${BRANCH}) into ${INSTALL_DIR}..."
  git clone --branch "${BRANCH}" --depth 1 "https://github.com/${REPO}.git" "${INSTALL_DIR}"
fi
cd "${INSTALL_DIR}"

# ---------------------------------------------------------------------------
# 8. Configuration — generate secrets on first install, prompt for the two
#    values that can't be generated. All of these can be pre-set as env
#    vars to run this non-interactively.
# ---------------------------------------------------------------------------
if [[ "${UPGRADE}" == false ]]; then
  info "Generating configuration (.env)..."

  if [[ -z "${CONSOLE_DOMAIN:-}" && -r /dev/tty ]]; then
    read -rp "Domain this console will be reachable at (e.g. vpn.yourcompany.com): " CONSOLE_DOMAIN < /dev/tty
  fi
  [[ -n "${CONSOLE_DOMAIN:-}" ]] || error "CONSOLE_DOMAIN is required. Re-run with: CONSOLE_DOMAIN=vpn.yourcompany.com bash install.sh (needs a DNS A record pointing at this server for automatic HTTPS)"

  if [[ -z "${WG_PUBLIC_ENDPOINT:-}" && -r /dev/tty ]]; then
    read -rp "WireGuard public endpoint, host:port [${CONSOLE_DOMAIN}:${WG_DEFAULT_PORT}]: " WG_PUBLIC_ENDPOINT < /dev/tty
  fi
  WG_PUBLIC_ENDPOINT="${WG_PUBLIC_ENDPOINT:-${CONSOLE_DOMAIN}:${WG_DEFAULT_PORT}}"

  cat > .env <<EOF
# Generated by install.sh — treat this file as a secret.
CONSOLE_DOMAIN=${CONSOLE_DOMAIN}
WG_PUBLIC_ENDPOINT=${WG_PUBLIC_ENDPOINT}
APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
SESSION_SIGNING_KEY=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
ADGUARD_API_PASSWORD=$(openssl rand -hex 16)

# --- Optional: SMTP for user/admin invite emails ---
# Configurable later from Configuration → Email in the console itself.
SMTP_HOST=
SMTP_PORT=587
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM_ADDRESS=
EOF

  chmod 600 .env
  info "Secrets generated; domain set to ${CONSOLE_DOMAIN}"
else
  info "Existing .env kept as-is."
  # shellcheck disable=SC1091
  source .env
fi

# ---------------------------------------------------------------------------
# 9. Firewall — only touch it if ufw is installed AND active, and only add
# ---------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  info "ufw is active — opening 80/tcp, 443/tcp, ${WG_DEFAULT_PORT}/udp..."
  ufw allow 80/tcp   >/dev/null
  ufw allow 443/tcp  >/dev/null
  ufw allow "${WG_DEFAULT_PORT}/udp" >/dev/null
fi

# ---------------------------------------------------------------------------
# 10. Build and start
# ---------------------------------------------------------------------------
info "Building images and starting the stack (this can take a few minutes on first run)..."
docker compose up -d --build

# ---------------------------------------------------------------------------
# 11. Summary
# ---------------------------------------------------------------------------
DOMAIN_SHOWN="$(grep '^CONSOLE_DOMAIN=' .env | cut -d= -f2-)"
cat <<SUMMARY

==================================================================
 WireGuard Console is starting.

   Console:      https://${DOMAIN_SHOWN}
   Install dir:  ${INSTALL_DIR}
   Logs:         docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f
   Re-run this script any time to update.

 Before it's reachable over HTTPS, make sure ${DOMAIN_SHOWN} has a DNS
 A/AAAA record pointing at this server, and ports 80+443 are reachable
 from the internet — Caddy needs both to issue a certificate.

 First visit walks you through creating the first super_admin account.
 Enroll 2FA immediately — see the build guide, section 6.
==================================================================
SUMMARY