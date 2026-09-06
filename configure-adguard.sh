#!/usr/bin/env bash
#
# configure-adguard.sh — deterministic AdGuard Home setup for WireGuard
# Console. Writes AdGuardHome.yaml directly into the config volume, so it
# never depends on the flaky first-run wizard API.
#
#   sudo bash configure-adguard.sh           # provision, or skip if healthy
#   sudo bash configure-adguard.sh --force   # (re)write config, start AGH
#   sudo bash configure-adguard.sh --diag    # print state, don't change
#
# Default behavior: if AdGuard is already up AND authenticates with the .env
# credentials (HTTP 200 on /control/status), the config is left alone — an
# update must not stop/rewrite a healthy AdGuard, because a fresh
# AdGuardHome.yaml starts with user_rules: [] and wipes every domain-block
# rule (they only live in AdGuard's runtime config, not the DB-backed console
# re-push). Rewriting from scratch happens only when AdGuard is missing,
# unreachable, or its password no longer matches .env (use --force to demand
# a rewrite). While here, if ufw is active the script also opens the docker
# bridge → host :3000 path so the api container can reach AdGuard's API
# (default-deny INPUT otherwise drops it and rules can never be enforced).
#
# Existing AdGuard configs (unknown password) are replaced; blocked
# domains resolve to 10.8.0.1 where Caddy serves the branded block page.
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/wireguard-console}"
ENV_FILE="${ENV_FILE:-$COMPOSE_DIR/.env}"
MODE="${1:-}"
FORCE=false
if [[ "${MODE}" == "--force" ]]; then
  FORCE=true
  MODE=""
fi

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

# ---------------------------------------------------------------------------
# Idempotent ufw rule for the api container -> AdGuard API management path.
# AdGuard runs on the host network; the api container reaches it through the
# docker bridge gateway (172.x.0.1). With ufw active and default-deny
# incoming, that INPUT traffic is dropped unless allowed — the console then
# shows "AdGuard unreachable" forever (rules can't be enforced or re-pushed)
# while AdGuard itself is perfectly healthy on loopback. install.sh §9 opens
# the public + tunnel ports but never this one; keeping it here means every
# install/update self-heals the path, matching the interface-scoped DNS rule
# pattern. Docker bridge subnets vary per host (172.17/172.18/...), so allow
# the whole private 172.16.0.0/12 block on port 3000 only — ufw is
# idempotent, so re-runs are no-ops.
# ---------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow from 172.16.0.0/12 to any port 3000 proto tcp comment 'docker bridge -> AdGuard API' >/dev/null
  info "ufw active — allowed docker bridge -> AdGuard API (:3000) so the console can enforce rules."
fi

# ---------------------------------------------------------------------------
# Healthy check: if AdGuard is already up and authenticates with the .env
# credentials, do NOT rewrite its config. A rewrite (or even a restart)
# creates the "gap" after every console update: the api container is down
# (rebuilt) while AdGuard restarts, and a fresh AdGuardHome.yaml starts with
# empty user_rules — wiping every domain-block rule until the 5-minute worker
# happens to re-push (which itself needs the :3000 path above). Skipping a
# healthy AdGuard keeps rules + uptime intact across updates.
# ---------------------------------------------------------------------------
ALREADY_HEALTHY=false
if ! "$FORCE"; then
  # Retry briefly: on an update docker compose may have just recreated the
  # adguardhome container (e.g. a new image), so give it a moment to come up
  # before concluding it's unhealthy and rewriting. A fresh install is never
  # misjudged here — a never-configured AGH answers 302/404, not 200.
  for _ in $(seq 1 6); do
    code="$(curl -s -u "$ADGUARD_API_USER:$ADGUARD_API_PASSWORD" -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:3000/control/status" || true)"
    [[ "$code" == "200" ]] && break
    sleep 2
  done
  if [[ "$code" == "200" ]]; then
    ALREADY_HEALTHY=true
    info "AdGuard is up and the .env credentials authenticate (HTTP 200) — leaving its config untouched (use --force to rewrite)."
  fi
fi

if [[ "$ALREADY_HEALTHY" == true ]]; then
  echo ""
  echo " AdGuard Home is healthy — nothing to do. Its domain-block rules stay in place."
  echo " If you meant to re-provision from scratch: sudo bash configure-adguard.sh --force"
  echo ""
  exit 0
fi

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
  # Bind 0.0.0.0 only. Adding the tunnel gateway 10.8.0.1 here made AGH
  # FATAL-crash at boot ("bind: can't assign requested address") whenever the
  # wg0 interface wasn't up yet — a fresh docker compose up starts adguardhome
  # (host network) in parallel with wg-helper, so 10.8.0.1 usually doesn't
  # exist when AGH binds :53. 0.0.0.0 already covers the tunnel's DNS traffic.
  bind_hosts:
    - "0.0.0.0"
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