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
apt-get install -y -qq wireguard wireguard-tools git openssl curl >/dev/null

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
# An existing install's .env is only kept if it is complete; if it's
# missing or broken (e.g. an installer run that failed before finishing),
# generate a fresh one instead of dying on `source .env`.
if [[ "${UPGRADE}" == true ]] \
   && [[ -f .env ]] \
   && grep -q '^CONSOLE_DOMAIN=.\+' .env \
   && grep -q '^POSTGRES_PASSWORD=.\+' .env; then
  info "Existing .env kept as-is."
  # shellcheck disable=SC1091
  source .env
else
  [[ "${UPGRADE}" == true ]] && warn "Existing .env is missing or incomplete — generating a fresh configuration."

  info "Generating configuration (.env)..."

  # Best-effort auto-detection of this server's public IPv4, so a plain
  # Enter at the prompt deploys with the detected address.
  DETECTED_IP=""
  if command -v curl >/dev/null 2>&1; then
    DETECTED_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
    [[ "${DETECTED_IP}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || DETECTED_IP=""
  fi

  # Prompt only when a controlling terminal actually opens (works even
  # when stdin is a pipe, e.g. curl ... | sudo bash). Note: `-r /dev/tty`
  # is NOT enough — bash's test is stat-based and lies when there is no
  # controlling terminal (cron, `container exec`, SSH command mode). And
  # never `exec 3<>/dev/tty` as the probe — a failed exec redirection is
  # FATAL for the shell. `true 2>/dev/null < /dev/tty` fails gracefully;
  # the 2> must come FIRST — redirections apply left-to-right, so a
  # leading `< /dev/tty` failure would bypass the stderr suppression.
  if [[ -z "${CONSOLE_DOMAIN:-}" ]] && true 2>/dev/null < /dev/tty; then
    if [[ -n "${DETECTED_IP:-}" ]]; then
      read -rp "Console address — domain, public IP, or Enter to use the detected IP ${DETECTED_IP}: " CONSOLE_DOMAIN < /dev/tty || true
      CONSOLE_DOMAIN="${CONSOLE_DOMAIN:-${DETECTED_IP}}"
    else
      read -rp "Domain or public IP this console will be reachable at (e.g. vpn.yourcompany.com, or 203.0.113.5): " CONSOLE_DOMAIN < /dev/tty || true
    fi
  fi
  # Headless (no terminal, e.g. cron/CI): fall back to the detected public
  # IP rather than aborting — it is the address peers will reach, after all.
  if [[ -z "${CONSOLE_DOMAIN:-}" && -n "${DETECTED_IP:-}" ]]; then
    warn "No interactive terminal and CONSOLE_DOMAIN unset — using detected public IP ${DETECTED_IP}. Override with CONSOLE_DOMAIN=... if this server is behind NAT with port-forwarding."
    CONSOLE_DOMAIN="${DETECTED_IP}"
  fi
  [[ -n "${CONSOLE_DOMAIN:-}" ]] || error "CONSOLE_DOMAIN is required. Re-run with: CONSOLE_DOMAIN=vpn.yourcompany.com bash install.sh (a domain gets automatic HTTPS; a public IP works too, with a self-signed certificate)"
  info "Console will be reachable at ${CONSOLE_DOMAIN}"

  # WG_PUBLIC_ENDPOINT is not prompted for — the default
  # CONSOLE_DOMAIN:51820 is correct for the vast majority of deployments
  # and every extra prompt is a chance to appear "stuck". Override via
  # WG_PUBLIC_ENDPOINT=host:port if your tunnel endpoint differs.
  WG_PUBLIC_ENDPOINT="${WG_PUBLIC_ENDPOINT:-${CONSOLE_DOMAIN}:${WG_DEFAULT_PORT}}"

  # IP-only deployments get Caddy's internal CA — public certificate
  # authorities can't issue certificates for bare IP addresses. For a
  # fully trusted certificate without owning a domain, use an sslip.io
  # address instead, e.g. 203.0.113.5.sslip.io (works exactly like a domain).
  WGCONSOLE_TLS=""
  if [[ "${CONSOLE_DOMAIN}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    WGCONSOLE_TLS="tls internal"
    info "IPv4 address detected — HTTPS will use Caddy's internal CA (browsers will show a self-signed certificate warning)."
  fi

  cat > .env <<EOF
# Generated by install.sh — treat this file as a secret.
CONSOLE_DOMAIN=${CONSOLE_DOMAIN}
WG_PUBLIC_ENDPOINT=${WG_PUBLIC_ENDPOINT}
# Empty for domain mode (public ACME certificates); "tls internal" for
# IP-only mode. Quoted so `source .env` on upgrades stays valid.
WGCONSOLE_TLS="${WGCONSOLE_TLS}"
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
if [[ "${DOMAIN_SHOWN}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  REACH_NOTE=" ${DOMAIN_SHOWN} is an IP address, so HTTPS uses Caddy's internal CA:
  your browser will warn about a self-signed certificate on first visit —
  proceed past the warning (the connection is still fully encrypted).
  For a certificate trusted by browsers without owning a domain, set
  CONSOLE_DOMAIN=${DOMAIN_SHOWN}.sslip.io and WGCONSOLE_TLS= in .env,
  then re-run this installer.
  Invite links use https://${DOMAIN_SHOWN}/claim/... and WireGuard peers
  use ${DOMAIN_SHOWN}:${WG_DEFAULT_PORT} as their endpoint automatically."
else
  REACH_NOTE=" Before it's reachable over HTTPS, make sure ${DOMAIN_SHOWN} has a DNS
  A/AAAA record pointing at this server, and ports 80+443 are reachable
  from the internet — Caddy needs both to issue a certificate."
fi
cat <<SUMMARY

==================================================================
 WireGuard Console is starting.

   Console:      https://${DOMAIN_SHOWN}
   Install dir:  ${INSTALL_DIR}
   Logs:         docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f
   Re-run this script any time to update.

${REACH_NOTE}

 First visit walks you through creating the first super_admin account.
 Enroll 2FA immediately — see the build guide, section 6.
==================================================================
SUMMARY