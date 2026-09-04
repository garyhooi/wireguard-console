#!/usr/bin/env bash
#
# configure-adguard.sh — deterministic AdGuard Home setup for WireGuard
# Console. Writes AdGuardHome.yaml directly into the config volume, so it
# never depends on the flaky first-run wizard API.
#
#   sudo bash configure-adguard.sh           # (re)write config, start AGH
#   sudo bash configure-adguard.sh --diag    # print state, don't change
#
# Existing AdGuard configs (unknown password) are replaced; blocked
# domains resolve to 10.8.0.1 where Caddy serves the branded block page.
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/wireguard-console}"
ENV_FILE="${ENV_FILE:-$COMPOSE_DIR/.env}"
MODE="${1:-}"

error() { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }
info()  { echo -e "\033[1;34m[info]\033[0m  $*" >&2; }

# ---- load .env values ----
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi
ADGUARD_API_USER="${ADGUARD_API_USER:-admin}"
: "${ADGUARD_API_PASSWORD:?ADGUARD_API_PASSWORD is empty in $ENV_FILE}"

AGH_VOL="$(docker volume ls -q | grep -E '(^|_)agh-conf$' | head -1)"
[[ -n "$AGH_VOL" ]] || error "AdGuard conf volume not found. Is the stack up? (docker compose up -d)"

diag() {
  echo "== AGH conf volume =="; echo "  $AGH_VOL"
  echo "== containers =="
  docker ps -a --format '  {{.Names}}  {{.Image}}  {{.Status}}' | grep -iE 'adguard' || echo "  (none)"
  echo "== config file in volume =="
  docker run --rm -v "$AGH_VOL":/conf alpine:3 sh -c 'ls -la /conf 2>/dev/null | head -5; [ -f /conf/AdGuardHome.yaml ] && echo "-- yaml present --" || echo "-- yaml ABSENT (fresh) --"'
  echo "== port 80 =="
  (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep -E ':80 ' || echo "  (nothing on :80)"
  echo "== AGH http endpoints =="
  for ep in install/configure control/status; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000/$ep" || true)"
    echo "  /$ep -> HTTP $code"
  done
  echo ""
  echo "== Live AdGuard state (Basic auth from .env) =="
  AUTH="${ADGUARD_API_USER:-admin}:${ADGUARD_API_PASSWORD}"
  echo "-- user rules currently in AdGuard --"
  curl -s -u "$AUTH" "http://127.0.0.1:3000/control/filtering/status" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('protection:', d.get('enabled')); [print('  rule:', r) for r in d.get('user_rules',[])] or print('  (none)')" 2>&1 || echo "  (could not read filtering status)"
  echo "-- blocking mode --"
  curl -s -u "$AUTH" "http://127.0.0.1:3000/control/dns_config" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('  mode:', d.get('blocking_mode'), 'ipv4:', d.get('blocking_ipv4'))" 2>&1 || echo "  (could not read dns_config)"
  echo ""
  echo "== DNS answer for common blocked/test domains via AGH (127.0.0.1:53) =="
  for host in google.com www.google.com youtube.com www.youtube.com; do
    ans="$(dig +short +time=2 +tries=1 "@127.0.0.1" "$host" A 2>/dev/null | tr '\n' ' ')"
    echo "  $host -> ${ans:-<no answer / timeout>}"
  done
}

if [[ "${MODE}" == "--diag" ]]; then
  diag
  exit 0
fi

command -v python3 >/dev/null || error "python3 is required"
command -v docker >/dev/null || error "docker not found"

info "Generating AdGuard bcrypt password hash..."
HASH="$(docker run --rm -v "$COMPOSE_DIR/backend":/src -w /src golang:1.27-alpine \
  go run ./cmd/aghenc "$ADGUARD_API_USER" "$ADGUARD_API_PASSWORD" 2>/dev/null | tail -1)"
if [[ -z "$HASH" || "$HASH" != *:* ]]; then
  error "Failed to compute bcrypt hash (backend/cmd/aghenc). Is the golang image pullable?"
fi

AGH_CONTAINER="$(docker ps -aq -f name=adguardhome | head -1)"
if [[ -n "$AGH_CONTAINER" ]]; then
  info "Stopping AdGuard Home..."
  docker stop "$AGH_CONTAINER" >/dev/null 2>&1 || true
fi

info "Writing AdGuardHome.yaml into $AGH_VOL ..."
python3 - "$HASH" <<'PY' | docker run --rm -i -v "$AGH_VOL":/conf alpine:3 sh -c 'cat > /conf/AdGuardHome.yaml && chmod 644 /conf/AdGuardHome.yaml && echo wrote'
import sys
user_line = sys.argv[1]
name, pw_hash = user_line.split(':', 1)
print(f"""http:
  address: 0.0.0.0:3000
  session_ttl: 720h
users:
  - name: {name}
    password: {pw_hash}
dns:
  bind_hosts:
    - "0.0.0.0"
    - "10.8.0.1"
  port: 53
  upstream_dns:
    - https://dns10.quad9.net/dns-query
    - 1.1.1.1
  upstream_dns_file: ""
filtering:
  protection_enabled: true
  filtering_enabled: true
  blocking_mode: custom_ip
  blocking_ipv4: 10.8.0.1
  blocking_ipv6: "::"
  blocked_response_ttl: 10
querylog:
  enabled: true
statistics:
  enabled: true
filters: []
whitelist_filters: []
user_rules: []
os:
  group: ""
  user: ""
log:
  enabled: false
schema_version: 28
""")
PY

info "Starting AdGuard Home..."
(cd "$COMPOSE_DIR" && docker compose up -d adguardhome >/dev/null 2>&1 || true)
if [[ -n "$AGH_CONTAINER" ]] && ! docker ps -q -f name=adguardhome | grep -q .; then
  docker start "$AGH_CONTAINER" >/dev/null 2>&1 || true
fi
sleep 6

code="$(curl -s -u "$ADGUARD_API_USER:$ADGUARD_API_PASSWORD" -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000/control/status" || true)"
if [[ "$code" == "200" ]]; then
  info "AdGuard API authenticated OK (HTTP 200)."
else
  error "AdGuard API still not authenticating (HTTP $code). Run 'sudo bash configure-adguard.sh --diag' and paste output."
fi

info "Done. Blocked domains now resolve to 10.8.0.1 (Caddy shows the block page)."