#!/usr/bin/env bash
#
# configure-adguard.sh — idempotent AdGuard Home setup for WireGuard Console.
#
# AdGuard Home is deployed by docker-compose but on a fresh volume it shows
# a first-run wizard. This script configures it through its setup API so:
#   * the API password matches .env (ADGUARD_API_PASSWORD)
#   * DNS listens on the WireGuard tunnel gateway so VPN peers reach it
#   * blocked domains resolve to this host (custom_ip block mode) where
#     Caddy serves the branded block page on :80
#
# Usage (as root on the console host, after the stack is up):
#   sudo bash configure-adguard.sh
#
# If AdGuard was already configured with an unknown password (your case:
# HTTP 302 on /control), run with --reset once — it wipes the AGH config
# volume and re-runs the first-run wizard with the .env password:
#   sudo bash configure-adguard.sh --reset
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/wireguard-console}"
ENV_FILE="${ENV_FILE:-$COMPOSE_DIR/.env}"
AGH_URL="${AGH_URL:-http://127.0.0.1:3000}"
RESET="${1:-}"

error() { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }
info()  { echo -e "\033[1;34m[info]\033[0m  $*" >&2; }

# ---- load .env values ----
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi
ADGUARD_API_USER="${ADGUARD_API_USER:-admin}"
: "${ADGUARD_API_PASSWORD:?ADGUARD_API_PASSWORD is empty in $ENV_FILE}"

AGH_CONTAINER="$(docker ps -q -f name=adguardhome | head -1)"
[[ -n "$AGH_CONTAINER" ]] || error "AdGuard Home container is not running. Run 'docker compose up -d' first."

# ---- Optional hard reset: wipe AGH config and start fresh ----
if [[ "${RESET}" == "--reset" ]]; then
  info "Wiping AdGuard Home config volume (user rules, filters, settings)..."
  (cd "$COMPOSE_DIR" && docker compose stop adguardhome >/dev/null 2>&1 || true)
  docker rm -f "$AGH_CONTAINER" >/dev/null 2>&1 || true
  VOL="$(docker volume ls -q | grep -iE 'adguard|agh' | grep -i conf | head -1)"
  [[ -n "$VOL" ]] && docker volume rm "$VOL" >/dev/null 2>&1 || true
  (cd "$COMPOSE_DIR" && docker compose up -d adguardhome >/dev/null 2>&1)
  info "AdGuard restarted fresh. Waiting for the wizard to come up..."
  sleep 8
fi

# ---- Step 1: is AdGuard in wizard mode (install endpoints live)? ----
WIZARD_CODE="$(curl -s -o /dev/null -w '%{http_code}' "$AGH_URL/install/configure" || true)"
if [[ "$WIZARD_CODE" == "200" || "$WIZARD_CODE" == "405" ]]; then
  info "AdGuard is in first-run mode — applying initial setup..."
  GATEWAY="10.8.0.1"
  PAYLOAD="{\"web\":{\"ip\":\"0.0.0.0\",\"port\":3000,\"username\":\"$ADGUARD_API_USER\",\"password\":\"$ADGUARD_API_PASSWORD\"},\"dns\":{\"ip\":\"0.0.0.0\",\"port\":53,\"upstream_dns\":[\"https://dns10.quad9.net/dns-query\",\"1.1.1.1\"],\"bind_hosts\":[\"0.0.0.0\",\"$GATEWAY\"]}}"
  curl -s "$AGH_URL/install/configure" -H 'Content-Type: application/json' -d "$PAYLOAD" \
    >/dev/null || error "install/configure failed."
  info "AdGuard initial setup applied. Restarting..."
  docker restart "$AGH_CONTAINER" >/dev/null 2>&1 || true
  sleep 6
else
  info "AdGuard is already configured (install wizard inactive)."
fi

AUTH="$ADGUARD_API_USER:$ADGUARD_API_PASSWORD"

# ---- Step 2: verify API auth ----
code="$(curl -s -u "$AUTH" -o /dev/null -w '%{http_code}' "$AGH_URL/control/status" || true)"
if [[ "$code" != "200" ]]; then
  echo
  error "Cannot authenticate to the AdGuard API (HTTP $code).
  AdGuard was configured before with a password that does not match .env.
  Run this once to reset it to the .env password:
      sudo bash configure-adguard.sh --reset"
fi
info "AdGuard API reachable and authenticated."

# ---- Step 3: blocking mode -> custom IP (Caddy block page on this host) ----
info "Setting blocking mode to custom IP 10.8.0.1..."
CFG="$(curl -s -u "$AUTH" "$AGH_URL/control/dns_config")"
CFG="$(echo "$CFG" | python3 -c "
import json,sys
d=json.load(sys.stdin)
d['blocking_mode']='custom_ip'
d['blocking_ipv4']='10.8.0.1'
d['blocking_ipv6']='::'
print(json.dumps(d))" 2>/dev/null || echo "$CFG")"
curl -s -u "$AUTH" -X POST "$AGH_URL/control/dns_config" \
  -H 'Content-Type: application/json' -d "$CFG" >/dev/null

# ---- Step 4: confirm DNS on the gateway ----
info "Checking DNS on 10.8.0.1:53..."
if command -v dig >/dev/null 2>&1; then
  dig @10.8.0.1 example.com +short +time=2 +tries=1 >/dev/null 2>&1 \
    && echo "  ok: 10.8.0.1 answers DNS" \
    || echo "  warning: 10.8.0.1:53 not answering — is the WireGuard interface up?"
fi

info "AdGuard configuration complete."
info "Add a rule in the console (e.g. google.com) — blocked domains now resolve"
info "to 10.8.0.1, where Caddy serves the branded block page."
