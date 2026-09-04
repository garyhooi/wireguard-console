#!/usr/bin/env bash
#
# WireGuard Console — distributed node installer.
#
#   curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/node-install.sh | \
#     sudo bash -s -- <NODE_TOKEN> <CONSOLE_URL> <NODE_ID>
#
# Turns this machine into a managed node: installs Docker (if missing),
# builds the wg-helper image, and runs it in agent mode. The agent polls
# the console for desired state, applies WireGuard interfaces locally,
# and reports back — no inbound ports required on this node.
#
# The token + node id come from the console: Nodes → Add Node.

set -euo pipefail

TOKEN="${1:-}"
CONSOLE_URL="${2:-}"
NODE_ID="${3:-}"

error() { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }
info()  { echo -e "\033[1;34m[info]\033[0m  $*"; }

if [[ -z "${TOKEN}" || -z "${CONSOLE_URL}" || -z "${NODE_ID}" ]]; then
  error "Usage: sudo bash node-install.sh <NODE_TOKEN> <CONSOLE_URL> <NODE_ID>"
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  error "Run as root (see the sudo in the one-liner)."
fi

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  info "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
if ! docker compose version >/dev/null 2>&1 && ! docker version >/dev/null 2>&1; then
  error "Docker is not usable. Install it and re-run."
fi

# 2. Clone the console repo (lightweight: we only need wg-helper).
REPO="${WGCONSOLE_REPO:-garyhooi/wireguard-console}"
INSTALL_DIR="${WGCONSOLE_DIR:-/opt/wireguard-console}"
if [[ ! -d "${INSTALL_DIR}/.git" ]]; then
  info "Cloning ${REPO}..."
  git clone -q --depth 1 "https://github.com/${REPO}.git" "${INSTALL_DIR}"
else
  git -C "${INSTALL_DIR}" fetch -q --depth 1 origin main
  git -C "${INSTALL_DIR}" reset -q --hard origin/main
fi

# 3. Build the agent image.
info "Building wg-helper image (first run takes a few minutes)..."
cd "${INSTALL_DIR}"
docker build -q -t wireguard-console-wg-helper wg-helper >/dev/null

# 4. Run the agent. Stale containers are replaced.
docker rm -f wgconsole-agent >/dev/null 2>&1 || true
docker run -d --name wgconsole-agent \
  --restart unless-stopped \
  --cap-add NET_ADMIN \
  --cap-add SYS_MODULE \
  --network host \
  -e WGCONSOLE_URL="${CONSOLE_URL}" \
  -e WGCONSOLE_NODE_TOKEN="${TOKEN}" \
  -e WGCONSOLE_NODE_ID="${NODE_ID}" \
  wireguard-console-wg-helper >/dev/null

info "Node agent started for node ${NODE_ID}."
info "Console: ${CONSOLE_URL}"
info "The console will show this node as online within ~30s. Add servers
 in the console with 'Managed by: <this node>' and they appear here
 automatically — no manual steps on this machine."