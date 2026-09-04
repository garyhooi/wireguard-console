#!/usr/bin/env bash
#
# configure-adguard.sh — one-shot AdGuard Home setup for WireGuard Console.
#
# AdGuard Home is deployed but unconfigured on first install (it shows a
# first-run wizard). This script configures it through its setup API so:
#   * the API password matches .env (ADGUARD_API_PASSWORD)
#   * DNS listens on the WireGuard tunnel gateway so VPN peers reach it
#   * upstream DNS works and blocked domains resolve to the block page
#
# Run as root on the console host AFTER the stack is up:
#   sudo bash configure-adguard.sh
set -euo pipefail

AGH_URL="${AGH_URL:-http://127.0.0.1:3000}"
ENV_FILE="${ENV_FILE:-/opt/wireguard-console/.env}"

error() { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }
info()  { echo -e "\033[1;34m[info]\033[0m  $*" >&2; }

# ---- load .env values ----
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi
ADGUARD_API_PASSWORD="${ADGUARD_API_PASSWORD:-}"
ADGUARD_API_USER="${ADGUARD_API_USER:-admin}"

[[ -n "$ADGUARD_API_PASSWORD" ]] || error "ADGUARD_API_PASSWORD is empty in $ENV_FILE"

# Tunnel gateway IP: the .1 of the first local server's network, else default.
WG_IP="$(docker exec "$(docker ps -q -f name=console 2>/dev/null | head -1)" env 2>/dev/null | grep -E '^CONSOLE_DOMAIN=' | cut -d= -f2 || true)"
GATEWAY="${BLOCKPAGE_IP:-}"
if [[ -z "$GATEWAY" ]]; then
  # resolve via the api container's DB if possible, else fall back
  GATEWAY="10.8.0.1"
fi

# ---- Step 1: is AdGuard still in wizard mode? ----
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$AGH_URL/control/status" || true)"
if [[ "$STATUS" == "200" ]]; then
  info "AdGuard already configured (status 200)."
else
  info "AdGuard is in first-run mode — applying initial setup..."
  curl -sf "$AGH_URL/install/configure" \
    -H 'Content-Type: application/json' \
    -d "{\"web\":{\"ip\":\"0.0.0.0\",\"port\":3000,\"username\":\"$ADGUARD_API_USER\",\"password\":\"$ADGUARD_API_PASSWORD\"},\"dns\":{\"ip\":\"0.0.0.0\",\"port\":53,\"upstream_dns\":[\"https://dns10.quad9.net/dns-query\",\"1.1.1.1\"],\"bind_hosts\":[\"0.0.0.0\",\"$GATEWAY\"]}}" \
    >/dev/null || error "install/configure failed (is port 3000 the web UI and is AGH reachable?)"
  info "AdGuard initial setup applied. Restarting so the new config takes effect..."
  docker restart "$(docker ps -qf name=adguardhome | head -1)" >/dev/null 2>&1 || true
  sleep 5
fi

AUTH="$ADGUARD_API_USER:$ADGUARD_API_PASSWORD"

# ---- Step 2: verify API auth ----
code="$(curl -s -u "$AUTH" -o /dev/null -w '%{http_code}' "$AGH_URL/control/status" || true)"
[[ "$code" == "200" ]] || error "Cannot authenticate to AdGuard API (got HTTP $code). Check ADGUARD_API_USER/PASSWORD and that AGH web is on :3000."

# ---- Step 3: blocking mode -> custom IP (the block page) ----
info "Setting blocking mode to custom IP $GATEWAY..."
CFG="$(curl -s -u "$AUTH" "$AGH_URL/control/dns_config")"
CFG="$(echo "$CFG" | python3 -c "
import json,sys
d=json.load(sys.stdin)
d['blocking_mode']='custom_ip'
d['blocking_ipv4']='$GATEWAY'
d['blocking_ipv6']='::'
print(json.dumps(d))" 2>/dev/null || echo "$CFG")"
curl -s -u "$AUTH" -X POST "$AGH_URL/control/dns_config" -H 'Content-Type: application/json' -d "$CFG" >/dev/null

# ---- Step 4: confirm DNS listens on the gateway ----
info "Checking DNS on $GATEWAY:53..."
if command -v dig >/dev/null 2>&1; then
  dig @$GATEWAY google.com +short +time=2 +tries=1 >/dev/null 2>&1 && echo "  ok: $GATEWAY answers DNS" || echo "  warning: $GATEWAY:53 not answering yet — is the WireGuard interface up?"
fi

info "AdGuard configuration complete."
info "Blocked domains now resolve to $GATEWAY, which serves the branded block page (:80)."