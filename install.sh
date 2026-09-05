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

# Cloudflare's public IPv4 ranges (must match frontend/Caddyfile.cloudflare).
# A domain whose A records all live inside these is fronted by Cloudflare
# ("orange-cloud" proxied), which is how we can tell install.sh's one-liner
# users they are very likely behind Cloudflare.
CLOUDFLARE_RANGES="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"

ip_to_int() {
  local ip="$1" a b c d
  IFS=. read -r a b c d <<< "$ip"
  echo $(( (10#$a << 24) + (10#$b << 16) + (10#$c << 8) + 10#$d ))
}

# usage: is_cloudflare_ip <ipv4>  → 0 if the IP is inside Cloudflare's ranges
is_cloudflare_ip() {
  local ip_int net mask hostbits net_int range
  ip_int="$(ip_to_int "$1")"
  for range in $CLOUDFLARE_RANGES; do
    net="${range%/*}"; mask="${range#*/}"
    hostbits=$(( 32 - mask ))
    net_int="$(ip_to_int "$net")"
    if (( (ip_int >> hostbits) == (net_int >> hostbits) )); then
      return 0
    fi
  done
  return 1
}

# usage: domain_is_cloudflare_proxied <domain> → 0 if its public A records
# resolve inside Cloudflare's ranges (i.e. Cloudflare is in front of it).
# Unresolvable/AAAA-only domains return 1 (fail closed to domain mode).
# Resolution order: getent (glibc, the Ubuntu target) → dig → host →
# nslookup → python3, so it also works on macOS for local testing.
domain_is_cloudflare_proxied() {
  local domain="$1" ips ip found=1
  if command -v getent >/dev/null 2>&1; then
    ips="$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u)"
  elif command -v dig >/dev/null 2>&1; then
    ips="$(dig +short A "$domain" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u)"
  elif command -v host >/dev/null 2>&1; then
    ips="$(host -t A "$domain" 2>/dev/null | awk '/has address/{print $NF}' | sort -u)"
  elif command -v nslookup >/dev/null 2>&1; then
    ips="$(nslookup "$domain" 2>/dev/null | awk '/^Address: /{print $2}' | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u)"
  elif command -v python3 >/dev/null 2>&1; then
    ips="$(python3 -c "import socket,sys; print('\\n'.join({r[4][0] for r in socket.getaddrinfo(sys.argv[1], 443, socket.AF_INET)}))" "$domain" 2>/dev/null | sort -u)"
  else
    return 1
  fi
  [[ -z "${ips:-}" ]] && return 1
  for ip in $ips; do
    if is_cloudflare_ip "$ip"; then
      found=0
    else
      return 1   # any non-Cloudflare address means it's NOT fronted by CF
    fi
  done
  return "$found"
}

# Collect the first super-admin credentials (email prompted on a terminal,
# password always generated). Sets FIRST_ADMIN_EMAIL / FIRST_ADMIN_PASSWORD.
# Honors ADMIN_EMAIL / ADMIN_PASSWORD env overrides. The password is never
# prompted for — it is generated so it always satisfies the strength policy
# and can be printed exactly once in the install summary.
collect_first_admin_credentials() {
  FIRST_ADMIN_EMAIL="${ADMIN_EMAIL:-}"
  if [[ -z "${FIRST_ADMIN_EMAIL:-}" ]] && true 2>/dev/null < /dev/tty; then
    read -rp "First super-admin email (Enter for admin@company.com): " FIRST_ADMIN_EMAIL < /dev/tty || true
  fi
  FIRST_ADMIN_EMAIL="${FIRST_ADMIN_EMAIL:-admin@company.com}"
  if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
    FIRST_ADMIN_PASSWORD="${ADMIN_PASSWORD}"
  else
    # Guaranteed to satisfy the password policy (>= 12 chars, upper +
    # lower case, a digit and a special character): "Wg" (upper+lower) +
    # 14 hex chars + "1!" (digit + special) = 18 chars.
    FIRST_ADMIN_PASSWORD="Wg$(openssl rand -hex 7)1!"
  fi

  # .env values are single-quoted below (so spaces, '#' and other shell
  # characters survive both `source .env` and compose's env_file parser).
  # A literal single quote cannot be represented in that format, so reject
  # it up front with a clear message rather than corrupting the .env.
  if [[ "${FIRST_ADMIN_EMAIL}" == *"'"* ]] || [[ "${FIRST_ADMIN_PASSWORD}" == *"'"* ]]; then
    error "ADMIN_EMAIL / ADMIN_PASSWORD must not contain a single quote (') — the .env format cannot represent it. Re-run with a different value."
  fi
}

# usage: write_admin_env_to <file> — replace/append the ADMIN_EMAIL and
# ADMIN_PASSWORD lines in a .env file with the freshly collected values.
# Values are single-quoted for compose's env_file parser (collect_* already
# rejects embedded single quotes). awk reads the values from its environment
# so no quoting/escaping of the values ever reaches the shell or awk source;
# works on GNU and BSD systems alike.
write_admin_env_to() {
  local file="$1"
  if grep -q '^ADMIN_EMAIL=' "$file"; then
    ADMIN_EMAIL_VAL="${FIRST_ADMIN_EMAIL}" ADMIN_PASSWORD_VAL="${FIRST_ADMIN_PASSWORD}" awk '
      BEGIN { q = sprintf("%c", 39) }
      /^ADMIN_EMAIL=/     { print "ADMIN_EMAIL=" q ENVIRON["ADMIN_EMAIL_VAL"] q; next }
      /^ADMIN_PASSWORD=/  { print "ADMIN_PASSWORD=" q ENVIRON["ADMIN_PASSWORD_VAL"] q; next }
      { print }
    ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  else
    printf "\nADMIN_EMAIL='%s'\nADMIN_PASSWORD='%s'\n" "${FIRST_ADMIN_EMAIL}" "${FIRST_ADMIN_PASSWORD}" >> "$file"
  fi
}

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
# 7b. Fresh-database detection.
#    The signal for "first install" is NOT the UPGRADE flag (the repo dir at
#    ${INSTALL_DIR} can survive a reset — wiping Docker data/volumes or the
#    whole server except this folder leaves .git behind and makes UPGRADE
#    true). The authoritative signal is whether the Postgres data volume
#    exists: when it is missing the database will be created empty, and the
#    API's BootstrapAdmin then seeds the first super_admin from
#    ADMIN_EMAIL/ADMIN_PASSWORD in .env. In that case install.sh must
#    (re)generate those credentials and print them — never silently keep a
#    stale pair from an old .env.
# ---------------------------------------------------------------------------
PROJECT_NAME="$(basename "${INSTALL_DIR}")"
PG_VOLUME="${PROJECT_NAME}_pg-data"
FRESH_DB=false
if ! docker volume inspect "${PG_VOLUME}" >/dev/null 2>&1; then
  FRESH_DB=true
  info "No existing Postgres data volume (${PG_VOLUME}) — first run with a fresh database."
fi

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
  # Snapshot the caller's own env (if any) BEFORE sourcing .env, so a
  # fresh-DB re-seed below can tell "operator pre-set ADMIN_EMAIL" apart
  # from the stale value stored in the old .env file.
  CALLER_ADMIN_EMAIL="${ADMIN_EMAIL:-}"
  CALLER_ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
  # shellcheck disable=SC1091
  source .env

  # Self-heal: an .env generated by an older installer may have an empty
  # WGCONSOLE_TLS while CONSOLE_DOMAIN is an IP — Caddy then tries public
  # ACME for a bare IP, gets no certificate, and TLS handshakes fail.
  if [[ "${CONSOLE_DOMAIN:-}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && [[ -z "${WGCONSOLE_TLS:-}" ]]; then
    warn "IP console address with empty WGCONSOLE_TLS in .env — enabling internal TLS mode."
    sed -i "s|^WGCONSOLE_TLS=.*|WGCONSOLE_TLS=internal|" .env
  fi

  # Self-heal 2: an existing domain-mode install whose domain now resolves
  # to Cloudflare (or was always behind it) and whose .env has no TLS mode
  # is stuck in the ERR_TOO_MANY_REDIRECTS loop under Flexible SSL. Same
  # logic as the fresh-install branch: interactive confirm, headless
  # assumes Flexible. Never overrides a WGCONSOLE_TLS the user set.
  if [[ -z "${WGCONSOLE_TLS:-}" ]] \
     && [[ "${CONSOLE_DOMAIN:-}" == *.* ]] \
     && domain_is_cloudflare_proxied "${CONSOLE_DOMAIN:-}"; then
    if true 2>/dev/null < /dev/tty; then
      read -rp "The domain ${CONSOLE_DOMAIN} is fronted by Cloudflare. Is Cloudflare set to Flexible / Automatic SSL (reaches this server over plain HTTP on port 80)? [Y/n]: " CF_ANSWER < /dev/tty || true
      case "${CF_ANSWER:-y}" in
        y|Y|yes|YES|"")
          warn "Enabling WGCONSOLE_TLS=external-proxy (fixes the HTTP→HTTPS redirect loop behind Cloudflare Flexible)."
          sed -i "s|^WGCONSOLE_TLS=.*|WGCONSOLE_TLS=external-proxy|" .env
          ;;
        *)
          info "Keeping domain mode. Set WGCONSOLE_TLS=external-proxy in .env if Cloudflare is actually in Flexible mode."
          ;;
      esac
    else
      warn "CONSOLE_DOMAIN (${CONSOLE_DOMAIN}) resolves to Cloudflare IPs but no interactive terminal is available."
      warn "Assuming Cloudflare 'Flexible' mode and enabling WGCONSOLE_TLS=external-proxy (Caddy serves plain HTTP on :80, no redirects)."
      warn "If Cloudflare is set to 'Full' (HTTPS origin), set WGCONSOLE_TLS= in .env and re-run this installer."
      sed -i "s|^WGCONSOLE_TLS=.*|WGCONSOLE_TLS=external-proxy|" .env
    fi
  fi

  # Fresh-DB self-heal: the .env above was kept from a previous install,
  # but the Postgres data volume is gone (a reset that wiped Docker volumes
  # while leaving ${INSTALL_DIR} behind). The API's BootstrapAdmin will then
  # seed a brand-new super_admin from ADMIN_EMAIL/ADMIN_PASSWORD in .env —
  # re-ask for the email and rotate the password so the printed credentials
  # in the summary are real and current, instead of silently reusing a stale
  # pair the operator may never have seen.
  if [[ "${FRESH_DB}" == true ]]; then
    warn "The Postgres data volume (${PG_VOLUME}) is gone — a fresh super_admin will be created."
    # Override the stale values just sourced from .env with the caller's own
    # env (usually empty), so the interactive prompt actually re-asks.
    ADMIN_EMAIL="${CALLER_ADMIN_EMAIL:-}"
    ADMIN_PASSWORD="${CALLER_ADMIN_PASSWORD:-}"
    collect_first_admin_credentials
    write_admin_env_to .env
  fi

  # Reject a nonsense combination instead of silently mis-deploying.
  if [[ "${WGCONSOLE_TLS:-}" == "external-proxy" ]] && [[ "${CONSOLE_DOMAIN:-}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    error "WGCONSOLE_TLS=external-proxy needs a real domain (Cloudflare fronts a hostname, not a raw IP). CONSOLE_DOMAIN=${CONSOLE_DOMAIN}"
  fi
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

  # TLS mode selection. Priority:
  #   1. WGCONSOLE_TLS pre-set by the caller — respected.
  #   2. A bare IPv4 CONSOLE_DOMAIN → "internal": IP-only deployments get
  #      Caddy's internal CA — public certificate authorities can't issue
  #      certificates for bare IP addresses. For a fully trusted
  #      certificate without owning a domain, use an sslip.io address
  #      instead, e.g. 203.0.113.5.sslip.io (works exactly like a domain).
  #   3. CONSOLE_DOMAIN resolves inside Cloudflare's IP ranges (orange-cloud
  #      proxied, e.g. vpn.example.com → 104.16.x/172.64.x) and the caller
  #      did NOT pre-set WGCONSOLE_TLS → "external-proxy": such a domain is
  #      almost always Cloudflare "Flexible"/"Automatic SSL/TLS", where
  #      Cloudflare terminates HTTPS and reaches this server over plain
  #      HTTP on :80. Caddy must then serve HTTP only and never redirect to
  #      HTTPS — the automatic redirect is exactly what makes browsers loop
  #      with ERR_TOO_MANY_REDIRECTS (Cloudflare fetches :80 → Caddy 308s
  #      to https → repeat). DNS can't tell Flexible from Full (HTTPS
  #      origin), so an interactive terminal is asked to confirm; headless
  #      installs assume Flexible (the common case for a proxied domain)
  #      and print how to switch to domain mode.
  #   4. Otherwise empty → domain mode (public ACME certificates).
  if [[ -z "${WGCONSOLE_TLS:-}" ]] && [[ "${CONSOLE_DOMAIN}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    WGCONSOLE_TLS="internal"
    info "IPv4 address detected — HTTPS will use Caddy's internal CA (browsers will show a self-signed certificate warning)."
  elif [[ -z "${WGCONSOLE_TLS:-}" ]] && [[ "${CONSOLE_DOMAIN}" == *.* ]] \
     && domain_is_cloudflare_proxied "${CONSOLE_DOMAIN}"; then
    if true 2>/dev/null < /dev/tty; then
      read -rp "The domain ${CONSOLE_DOMAIN} is fronted by Cloudflare. Is Cloudflare set to Flexible / Automatic SSL (reaches this server over plain HTTP on port 80)? [Y/n]: " CF_ANSWER < /dev/tty || true
      case "${CF_ANSWER:-y}" in
        y|Y|yes|YES|"") WGCONSOLE_TLS="external-proxy" ;;
        *) info "Keeping domain mode (Caddy obtains its own certificate and serves HTTPS). Use WGCONSOLE_TLS=external-proxy if Cloudflare is actually in Flexible mode." ;;
      esac
    else
      warn "CONSOLE_DOMAIN (${CONSOLE_DOMAIN}) resolves to Cloudflare IPs, but no interactive terminal is available."
      warn "Assuming Cloudflare 'Flexible' mode and enabling WGCONSOLE_TLS=external-proxy (Caddy serves plain HTTP on :80, no redirects)."
      warn "If Cloudflare is set to 'Full' (HTTPS origin) instead, set WGCONSOLE_TLS= in .env and re-run this installer."
      WGCONSOLE_TLS="external-proxy"
    fi
  fi
  if [[ "${WGCONSOLE_TLS:-}" == "external-proxy" ]]; then
    if [[ "${CONSOLE_DOMAIN}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
      error "WGCONSOLE_TLS=external-proxy needs a real domain — Cloudflare fronts a hostname, not a raw IP. CONSOLE_DOMAIN=${CONSOLE_DOMAIN}"
    fi
    info "Cloudflare reverse-proxy mode (WGCONSOLE_TLS=external-proxy): Cloudflare terminates TLS; Caddy serves plain HTTP on :80 with no redirects. No HTTPS listener is started — make sure Cloudflare's SSL/TLS mode is Flexible or 'Automatic SSL/TLS'."
  fi
  WGCONSOLE_TLS="${WGCONSOLE_TLS:-}"

  # First super_admin bootstrap credentials. The API auto-creates the
  # account only when the admins table is empty (a brand-new database),
  # using ADMIN_EMAIL/ADMIN_PASSWORD from .env. install.sh prints them in
  # the final summary so no `docker logs` is needed on first install.
  # Pre-set ADMIN_EMAIL/ADMIN_PASSWORD when running this script to choose
  # the credentials yourself instead of having them generated.
  #
  # Ask for the admin email on an interactive terminal (defaults to
  # admin@company.com on Enter) — the password is always generated, never
  # prompted, so it can satisfy the strength policy and be shown once.
  # .env always receives real values; the summary decides whether to show
  # them based on FRESH_DB.
  if [[ "${FRESH_DB}" == true ]]; then
    collect_first_admin_credentials
  else
    # Not fresh (an old volume keeps its admins): BootstrapAdmin will not
    # run, so don't prompt for a login that won't exist — write inert values
    # and let the summary say admins are kept.
    warn "An existing Postgres data volume was found — keeping the current admins."
    warn "If you intended a fresh install, remove the volume first: docker compose down -v"
    FIRST_ADMIN_EMAIL="${ADMIN_EMAIL:-admin@company.com}"
    FIRST_ADMIN_PASSWORD="${ADMIN_PASSWORD:-Wg$(openssl rand -hex 7)1!}"
  fi

  cat > .env <<EOF
# Generated by install.sh — treat this file as a secret.
CONSOLE_DOMAIN=${CONSOLE_DOMAIN}
WG_PUBLIC_ENDPOINT=${WG_PUBLIC_ENDPOINT}
# Empty for domain mode (public ACME certificates); "internal" for
# IP-only mode; "external-proxy" for a Cloudflare (Flexible/Automatic
# SSL) reverse proxy that reaches the origin over plain HTTP.
WGCONSOLE_TLS=${WGCONSOLE_TLS}
APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
SESSION_SIGNING_KEY=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
ADGUARD_API_PASSWORD=$(openssl rand -hex 16)
# AdGuard Home login user for the /control API (Basic auth).
ADGUARD_API_USER=admin

# --- First super_admin bootstrap (used only on a fresh database) ---
# The password is printed in the install summary; change it in Profile
# after first login. Re-running the installer never rotates it.
ADMIN_EMAIL='${FIRST_ADMIN_EMAIL}'
ADMIN_PASSWORD='${FIRST_ADMIN_PASSWORD}'

# --- Session auth transport (localStorage → HttpOnly cookie migration) ---
# The admin session rides an HttpOnly SameSite=Strict cookie with a
# per-session CSRF token. During the transition the API also accepts the
# legacy Authorization header so a stale cached bundle keeps working.
# Remove this line (and re-run) once the cookie-only frontend is proven.
AUTH_ACCEPT_HEADER=1

# --- Session lifecycle ---
# Sessions idle longer than this are rejected (0 disables; the absolute
# 24h expiry always applies). Profile → Active Sessions can revoke live
# sessions manually.
SESSION_IDLE_MINUTES=30

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

  # Show the one-time super_admin credentials NOW, before the multi-minute
  # image build scrolls them out of the terminal. The end-of-install summary
  # repeats them, but a long docker build (or a truncated scrollback/SSH
  # capture) can otherwise hide the only time they are ever printed. The
  # account is only created on the API's first boot (empty admins table).
  if [[ "${FRESH_DB}" == true ]]; then
    cat <<CRED

==================================================================
 ⚠  SAVE THESE NOW — the super_admin password is shown only once.
    Email:    ${FIRST_ADMIN_EMAIL}
    Password: ${FIRST_ADMIN_PASSWORD}

    Log in at https://${CONSOLE_DOMAIN} after the stack starts, then
    change this password in Profile and enroll 2FA immediately.
    (Recovery: the same values are in ${INSTALL_DIR}/.env as
    ADMIN_EMAIL / ADMIN_PASSWORD.)
==================================================================
CRED
  fi
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
if ! docker compose up -d --build; then
  error "docker compose failed. Diagnose with:
  docker compose -f ${INSTALL_DIR}/docker-compose.yml ps -a
  docker compose -f ${INSTALL_DIR}/docker-compose.yml logs --tail=50 postgres
  docker logs --tail=50 wireguard-console-postgres-1
  df -h /var/lib/docker
  Then fix the cause and re-run this script."
fi

# ---------------------------------------------------------------------------
# 10b. Provision AdGuard Home (first run): write AdGuardHome.yaml directly
#      into its config volume so DNS filtering + the block page work out of
#      the box. Idempotent — safe to re-run on updates.
# ---------------------------------------------------------------------------
info "Provisioning AdGuard Home..."
if ! bash configure-adguard.sh 2>&1 | sed 's/^/  [adguard] /'; then
  warn "AdGuard provisioning reported a problem — domain blocking may not work until"
  warn "it is fixed. Re-run: sudo bash ${INSTALL_DIR}/configure-adguard.sh"
fi

# Post-start sanity: flag unhealthy containers instead of printing a happy
# summary while half the stack is down.
UNHEALTHY="$(docker compose ps 2>/dev/null | awk 'NR>1 && $0 ~ /unhealthy/ {print $1}' || true)"
if [[ -n "${UNHEALTHY}" ]]; then
  warn "Some containers are not healthy yet: ${UNHEALTHY}"
  warn "Watch them with: docker compose -f ${INSTALL_DIR}/docker-compose.yml ps"
  warn "Logs: docker compose -f ${INSTALL_DIR}/docker-compose.yml logs -f"
fi

# Authoritative fresh-DB confirmation. The API's BootstrapAdmin seeds the
# first super_admin on the very first boot after an empty database is
# migrated, so by the time the stack is up the admins table either already
# has that row (this run created it) or had rows from before (real upgrade).
# Poll briefly — the api container may still be mid-bootstrap on a slow
# first start. If we cannot confirm zero→one transition, fall back to the
# volume-based FRESH_DB guess rather than misreporting.
ADMIN_COUNT=""
if [[ "${FRESH_DB}" == true ]]; then
  for _ in $(seq 1 15); do
    ADMIN_COUNT="$(docker compose exec -T postgres psql -U wgconsole -d wgconsole -tAc 'SELECT count(*) FROM admins' 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "${ADMIN_COUNT}" =~ ^[0-9]+$ ]] && break
    sleep 2
  done
  if [[ "${ADMIN_COUNT}" =~ ^[0-9]+$ ]] && [[ "${ADMIN_COUNT}" -gt 0 ]]; then
    info "Confirmed: super_admin bootstrap completed (${ADMIN_COUNT} admin(s) in the fresh database)."
  else
    warn "Could not confirm the super_admin bootstrap in the database yet."
    warn "If the API is still starting, the account will appear on its first completed boot."
  fi
fi

# ---------------------------------------------------------------------------
# 11. Summary
# ---------------------------------------------------------------------------
# A fresh database prints the bootstrapped first-admin credentials right
# here; an existing database (real upgrade) gets a short note instead.
# "Fresh" is decided by the Postgres data volume (FRESH_DB), not by the
# UPGRADE flag — a reset that wipes Docker volumes but leaves ${INSTALL_DIR}
# re-seeds the admin, and those credentials must be shown. Values come from
# the .env that was just written (or pre-set env vars), matching what the
# api container uses to create the account on its first boot.
FIRST_ADMIN_BLOCK=""
if [[ "${FRESH_DB}" == true ]]; then
  # Display straight from the variables used to generate .env — no need to
  # re-parse the file (and no quoting pitfalls for special characters).
  FIRST_ADMIN_BLOCK=" First super_admin account (created on first boot):
    Email:    ${FIRST_ADMIN_EMAIL}
    Password: ${FIRST_ADMIN_PASSWORD}

   Log in at the console URL above, then change this password in Profile
   and enroll 2FA immediately. This is the only time these credentials
   are shown."
else
  FIRST_ADMIN_BLOCK=" Existing install updated — admins and data are kept."
fi

# Display values come from .env (the source of truth — shell variables can be
# stale after a self-heal sed -i above). The `|| true` guards are essential:
# under `set -euo pipefail`, an unguarded non-matching `grep` would abort the
# script silently right here — after the stack is up — and swallow the
# credentials summary. Fall back to the shell variables, which were validated
# above, when a key is absent.
DOMAIN_SHOWN="$(grep '^CONSOLE_DOMAIN=' .env | cut -d= -f2- || true)"
TLS_MODE_SHOWN="$(grep '^WGCONSOLE_TLS=' .env | cut -d= -f2- || true)"
DOMAIN_SHOWN="${DOMAIN_SHOWN:-${CONSOLE_DOMAIN:-}}"
TLS_MODE_SHOWN="${TLS_MODE_SHOWN:-${WGCONSOLE_TLS:-}}"
if [[ "${TLS_MODE_SHOWN}" == "external-proxy" ]]; then
  REACH_NOTE=" ${DOMAIN_SHOWN} is fronted by Cloudflare (or another proxy) in Flexible /
  Automatic SSL mode — Cloudflare terminates HTTPS and reaches this server
  over plain HTTP. Caddy serves HTTP only, with no HTTPS redirect, so make
  sure only port 80 is published to the proxy.
  Invite links use https://${DOMAIN_SHOWN}/claim/... and WireGuard peers
  use ${DOMAIN_SHOWN}:${WG_DEFAULT_PORT} as their endpoint automatically."
elif [[ "${DOMAIN_SHOWN}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
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

${FIRST_ADMIN_BLOCK}
 Re-running the installer later updates the stack without touching your
 admins or data (only a wiped database volume re-creates the super_admin).
==================================================================
SUMMARY
