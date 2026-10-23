#!/usr/bin/env bash
#
# WireGuard Console — host firewall helper.
#
# Opens the ports this stack needs on whichever host firewall is actually in
# use, instead of assuming ufw:
#
#   * ufw       — Ubuntu/Debian hosts with ufw enabled (the common case)
#   * firewalld — RHEL/Alma/Rocky/CentOS images, where firewalld is on by default
#   * iptables  — hosts with a bare iptables ruleset and no ufw/firewalld.
#                 Oracle Cloud's Ubuntu images ship /etc/iptables/rules.v4
#                 (netfilter-persistent) that allows SSH/ICMP and then REJECTs
#                 everything else, so without this path WireGuard's UDP port is
#                 closed: every handshake is dropped at the host, "last
#                 handshake: never" in the console, and the api container can't
#                 reach AdGuard's API on :3000. Rules here are inserted BEFORE
#                 that catch-all REJECT (appending after it would be a no-op)
#                 and re-applied at boot by a systemd unit.
#
# Rules applied (all idempotent):
#   80/tcp, 443/tcp                       console (Caddy)
#   ${WG_PORT}/udp                        WireGuard
#   udp+tcp/53 on wg*                     AdGuard DNS for tunnel peers (never public)
#   3000/tcp from 172.16.0.0/12           docker bridge -> AdGuard API
#   forward ${WG_CIDR} <-> anywhere        tunnel peers -> internet
#   nat MASQUERADE ${WG_CIDR}              tunnel peers -> internet
#   ICMP + established are left untouched (Oracle's image already allows them)
#
# Usage: firewall.sh [apply|status] [--dry-run]
#   apply      apply (and persist) the rules — the default
#   status     print the detected firewall manager and this stack's live rules
#   --dry-run  print what would be run, without changing anything
#
# Env:
#   WG_PORT                    WireGuard listen port            (default 51820)
#   WG_CIDR                    WireGuard client network        (default 10.8.0.0/24)
#   DOCKER_SOURCE_CIDR         docker bridge super-net         (default 172.16.0.0/12)
#   WGCONSOLE_DIR              install dir, informational only (default /opt/wireguard-console)
#   WGC_FIREWALL_SKIP_PERSIST  1 = apply rules but don't install the boot unit
#
set -euo pipefail

WG_PORT="${WG_PORT:-51820}"
WG_CIDR="${WG_CIDR:-10.8.0.0/24}"
DOCKER_SOURCE_CIDR="${DOCKER_SOURCE_CIDR:-172.16.0.0/12}"
WGCONSOLE_DIR="${WGCONSOLE_DIR:-/opt/wireguard-console}"
SKIP_PERSIST="${WGC_FIREWALL_SKIP_PERSIST:-0}"
UNIT_PATH="/etc/systemd/system/wg-console-firewall.service"
UNIT_BIN="/usr/local/sbin/wgc-firewall.sh"
REPO_URL="https://github.com/garyhooi/wireguard-console"

MODE="apply"
DRY_RUN=0
for arg in "$@"; do
  case "${arg}" in
    apply|status) MODE="${arg}" ;;
    --dry-run)    DRY_RUN=1 ;;
    -h|--help)    MODE="help" ;;
    *)
      echo "unknown argument: ${arg} (use apply|status|--dry-run)" >&2
      exit 2
      ;;
  esac
done

info() { echo -e "\033[1;34m[firewall]\033[0m $*"; }
warn() { echo -e "\033[1;33m[firewall]\033[0m $*" >&2; }

# run: echo the command in --dry-run, execute it otherwise
run() {
  if [ "${DRY_RUN}" = "1" ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

# run_q: like run, but hides successful output (ufw/firewall-cmd are chatty)
run_q() {
  if [ "${DRY_RUN}" = "1" ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@" >/dev/null 2>&1
}

detect_mode() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    echo ufw
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state 2>/dev/null | grep -qx running; then
    echo firewalld
  elif command -v iptables >/dev/null 2>&1; then
    echo iptables
  else
    echo none
  fi
}

# ufw cannot match wildcard interfaces, so enumerate the real ones.
wg_interfaces() {
  local ifaces
  ifaces="$(ls -d /sys/class/net/wg* 2>/dev/null | xargs -n1 basename 2>/dev/null | sort -u || true)"
  if [ -z "${ifaces}" ]; then
    ifaces="wg0"
  fi
  echo "${ifaces}"
}

# ---------------------------------------------------------------------------
# ufw
# ---------------------------------------------------------------------------
apply_ufw() {
  info "ufw is active — opening 80/tcp, 443/tcp, ${WG_PORT}/udp..."
  run_q ufw allow 80/tcp
  run_q ufw allow 443/tcp
  run_q ufw allow "${WG_PORT}/udp"

  local iface
  for iface in $(wg_interfaces); do
    run_q ufw allow in on "${iface}" to any port 53 proto udp comment 'WG peers -> AdGuard DNS (UDP)'
    run_q ufw allow in on "${iface}" to any port 53 proto tcp comment 'WG peers -> AdGuard DNS (TCP)'
  done
  info "Allowed DNS (53) from WireGuard peers to AdGuard on the tunnel gateway (never from the internet)."

  run_q ufw allow from "${DOCKER_SOURCE_CIDR}" to any port 3000 proto tcp comment 'docker bridge -> AdGuard API'
  info "Allowed docker bridge -> AdGuard API (:3000) so the console can enforce domain rules."

  remove_iptables_unit
}

# ---------------------------------------------------------------------------
# firewalld
# ---------------------------------------------------------------------------
apply_firewalld() {
  info "firewalld is running — opening 80/tcp, 443/tcp, ${WG_PORT}/udp..."
  run_q firewall-cmd --permanent --add-port=80/tcp
  run_q firewall-cmd --permanent --add-port=443/tcp
  run_q firewall-cmd --permanent --add-port="${WG_PORT}/udp"
  run_q firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=${DOCKER_SOURCE_CIDR} port port=3000 protocol=tcp accept"
  info "Allowed docker bridge -> AdGuard API (:3000) so the console can enforce domain rules."

  local iface
  for iface in $(wg_interfaces); do
    run_q firewall-cmd --permanent --zone=trusted --add-interface="${iface}"
  done
  info "Put WireGuard interface(s) in firewalld's trusted zone so tunnel peers reach AdGuard DNS on :53 (never exposed on the public interface)."

  run_q firewall-cmd --reload
  remove_iptables_unit
}

# ---------------------------------------------------------------------------
# bare iptables (Oracle Cloud Ubuntu images, minimal images, containers)
#
# On these hosts the chain usually ends with an explicit catch-all
# REJECT/DROP. Appending ACCEPT rules with -A after that line does nothing
# (that is exactly what wg-helper used to do), so rules must be *inserted*
# before the first REJECT/DROP rule.
# ---------------------------------------------------------------------------

# Print the line number of the first REJECT/DROP rule in a chain (empty if none).
chain_catchall_pos() {
  iptables -nvL "$1" --line-numbers 2>/dev/null \
    | awk 'NR>1 && ($4=="REJECT" || $4=="DROP") {print $1; exit}'
}

# match_line <line> <token...> — every token must appear in the line
match_line() {
  local line="$1"
  shift
  local token
  for token in "$@"; do
    case "${line}" in
      *"${token}"*) ;;
      *) return 1 ;;
    esac
  done
  return 0
}

# delete_spec_line <chain> <"-A CHAIN ..."> — turn an iptables -S line into -D
delete_spec_line() {
  local chain="$1"
  local line="$2"
  local -a parts=()
  read -r -a parts <<< "${line}"
  if [ "${#parts[@]}" -lt 2 ]; then
    return 0
  fi
  local -a del=("-D")
  local i
  for ((i = 1; i < ${#parts[@]}; i++)); do
    del[${#del[@]}]="${parts[${i}]}"
  done
  if [ "${DRY_RUN}" = "1" ]; then
    run iptables "${del[@]}"
    return 0
  fi
  iptables "${del[@]}" >/dev/null 2>&1 || true
}

# ensure_ipt_rule <chain> <match tokens...> -- <iptables args...>
#
# Idempotent and order-aware: keeps exactly one matching rule, positioned
# before the chain's catch-all REJECT/DROP (or appended when there is none).
ensure_ipt_rule() {
  local chain="$1"
  shift
  local -a tokens=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do
    tokens[${#tokens[@]}]="$1"
    shift
  done
  if [ $# -gt 0 ] && [ "$1" = "--" ]; then
    shift
  fi
  local -a args=("$@")

  if [ "${DRY_RUN}" = "1" ]; then
    local pos_hint
    pos_hint="$(chain_catchall_pos "${chain}" || true)"
    if [ -n "${pos_hint}" ]; then
      run iptables -I "${chain}" "${pos_hint}" "${args[@]}"
    else
      run iptables -I "${chain}" 1 "${args[@]}"
    fi
    return 0
  fi

  local line seen_reject=0 found_before=0
  local strays=""
  while IFS= read -r line; do
    case "${line}" in
      "-A ${chain} "*) ;;
      *) continue ;;
    esac
    if [ "${seen_reject}" = "0" ]; then
      case "${line}" in
        *"-j REJECT"*|*"-j DROP"*) seen_reject=1 ;;
      esac
    fi
    if match_line "${line}" "${tokens[@]}"; then
      if [ "${seen_reject}" = "0" ]; then
        found_before=1
      else
        strays="${strays}${line}\n"
      fi
    fi
  done < <(iptables -S "${chain}" 2>/dev/null || true)

  # Drop stray copies that sit after the catch-all (left behind by older
  # wg-helper builds, or by a previous run against a different chain order).
  if [ -n "${strays}" ]; then
    local stray
    while IFS= read -r stray; do
      [ -n "${stray}" ] || continue
      delete_spec_line "${chain}" "${stray}"
    done <<< "$(printf '%b' "${strays}")"
  fi

  if [ "${found_before}" = "1" ]; then
    return 0
  fi

  local reject_pos
  reject_pos="$(chain_catchall_pos "${chain}" || true)"
  if [ -n "${reject_pos}" ]; then
    iptables -I "${chain}" "${reject_pos}" "${args[@]}"
  else
    iptables -A "${chain}" "${args[@]}"
  fi
}

ensure_masquerade() {
  if [ "${DRY_RUN}" = "1" ]; then
    run iptables -t nat -A POSTROUTING -s "${WG_CIDR}" -j MASQUERADE
    return 0
  fi
  if iptables -t nat -C POSTROUTING -s "${WG_CIDR}" -j MASQUERADE 2>/dev/null; then
    return 0
  fi
  iptables -t nat -A POSTROUTING -s "${WG_CIDR}" -j MASQUERADE
}

apply_iptables() {
  info "no ufw/firewalld active — managing the iptables ruleset directly (Oracle Cloud images ship a REJECT ruleset here, so rules are inserted before it)..."

  ensure_ipt_rule INPUT "--dport 80" "-j ACCEPT" -- -p tcp -m tcp --dport 80 -j ACCEPT
  ensure_ipt_rule INPUT "--dport 443" "-j ACCEPT" -- -p tcp -m tcp --dport 443 -j ACCEPT
  ensure_ipt_rule INPUT "--dport ${WG_PORT}" "-j ACCEPT" -- -p udp -m udp --dport "${WG_PORT}" -j ACCEPT
  ensure_ipt_rule INPUT "-i wg+" "-p udp" "--dport 53" "-j ACCEPT" -- -i wg+ -p udp -m udp --dport 53 -j ACCEPT
  ensure_ipt_rule INPUT "-i wg+" "-p tcp" "--dport 53" "-j ACCEPT" -- -i wg+ -p tcp -m tcp --dport 53 -j ACCEPT
  ensure_ipt_rule INPUT "${DOCKER_SOURCE_CIDR}" "--dport 3000" "-j ACCEPT" -- -s "${DOCKER_SOURCE_CIDR}" -p tcp -m tcp --dport 3000 -j ACCEPT
  ensure_ipt_rule FORWARD "-s ${WG_CIDR}" "-j ACCEPT" -- -s "${WG_CIDR}" -j ACCEPT
  ensure_ipt_rule FORWARD "-d ${WG_CIDR}" "-j ACCEPT" -- -d "${WG_CIDR}" -j ACCEPT

  ensure_masquerade
  info "Opened 80/tcp, 443/tcp, ${WG_PORT}/udp, ${DOCKER_SOURCE_CIDR} -> 3000/tcp, and ${WG_CIDR} forwarding + masquerade (inserted before any catch-all REJECT)."

  persist_iptables
}

# ---------------------------------------------------------------------------
# Persistence: a systemd oneshot unit re-applies the (idempotent) rules at
# boot. This works on every supported host regardless of whether the image
# persists its own ruleset via netfilter-persistent, nftables.conf or not at
# all — and it is ordered after netfilter-persistent so a boot-time
# rules.v4 load cannot wipe the rules we just added.
# ---------------------------------------------------------------------------
persist_iptables() {
  if [ "${SKIP_PERSIST}" = "1" ]; then
    info "WGC_FIREWALL_SKIP_PERSIST=1 — leaving the boot-time unit alone."
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not available — iptables rules are live, but will not survive a reboot."
    return 0
  fi
  # Running from the unit itself: rules were just applied, no need to re-register.
  if [ -n "${INVOCATION_ID:-}" ]; then
    return 0
  fi

  local self_path="${BASH_SOURCE[0]}"
  if [ "$(readlink -f "${self_path}" 2>/dev/null || echo "${self_path}")" != "${UNIT_BIN}" ]; then
    if [ -f "${self_path}" ]; then
      run_q install -m 0755 "${self_path}" "${UNIT_BIN}"
    fi
  fi

  local unit_content
  unit_content="$(cat <<EOF
[Unit]
Description=WireGuard Console host firewall exceptions (iptables)
Documentation=${REPO_URL}
After=netfilter-persistent.service iptables.service
ConditionPathExists=${UNIT_BIN}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${UNIT_BIN} apply

[Install]
WantedBy=multi-user.target
EOF
)"

  local tmp
  tmp="$(mktemp)"
  printf '%s\n' "${unit_content}" > "${tmp}"
  if [ "${DRY_RUN}" = "1" ]; then
    info "would install ${UNIT_PATH} and enable it"
    rm -f "${tmp}"
    return 0
  fi
  if ! cmp -s "${tmp}" "${UNIT_PATH}" 2>/dev/null; then
    mv "${tmp}" "${UNIT_PATH}"
    chmod 0644 "${UNIT_PATH}"
    systemctl daemon-reload
    info "Installed ${UNIT_PATH} (re-applies the rules at boot, after netfilter-persistent)."
  else
    rm -f "${tmp}"
  fi
  systemctl enable wg-console-firewall.service >/dev/null 2>&1 || true
  systemctl start wg-console-firewall.service >/dev/null 2>&1 || true
}

# Remove the boot unit when the host is managed by ufw/firewalld instead.
remove_iptables_unit() {
  if [ "${SKIP_PERSIST}" = "1" ]; then
    return 0
  fi
  [ -f "${UNIT_PATH}" ] || return 0
  if command -v systemctl >/dev/null 2>&1; then
    run_q systemctl disable --now wg-console-firewall.service
  fi
  run_q rm -f "${UNIT_PATH}"
  if command -v systemctl >/dev/null 2>&1; then
    run_q systemctl daemon-reload
  fi
  info "Removed the iptables boot unit (no longer needed on a ufw/firewalld host)."
}

show_status() {
  local mode
  mode="$(detect_mode)"
  info "detected host firewall: ${mode}"
  case "${mode}" in
    iptables)
      echo "--- INPUT ---"
      iptables -S INPUT 2>/dev/null || true
      echo "--- FORWARD ---"
      iptables -S FORWARD 2>/dev/null || true
      echo "--- POSTROUTING (nat) ---"
      iptables -t nat -S POSTROUTING 2>/dev/null || true
      ;;
    ufw)       ufw status verbose 2>/dev/null || true ;;
    firewalld) firewall-cmd --list-all 2>/dev/null || true ;;
    none)      warn "no ufw/firewalld/iptables found" ;;
  esac
}

usage() {
  cat <<EOF
WireGuard Console host firewall helper

  firewall.sh apply [--dry-run]   open the stack's ports (default)
  firewall.sh status              print the detected firewall + live rules

Ports: 80/tcp, 443/tcp, ${WG_PORT}/udp, 53 (tunnel interfaces only),
       3000/tcp from ${DOCKER_SOURCE_CIDR}, and ${WG_CIDR} forwarding + NAT.
EOF
}

case "${MODE}" in
  help)
    usage
    ;;
  status)
    show_status
    ;;
  apply)
    firewall_mode="$(detect_mode)"
    case "${firewall_mode}" in
      ufw)
        apply_ufw
        ;;
      firewalld)
        apply_firewalld
        ;;
      iptables)
        apply_iptables
        ;;
      *)
        warn "No supported host firewall found (no active ufw/firewalld and no iptables)."
        warn "Open these ports yourself: 80/tcp, 443/tcp, ${WG_PORT}/udp, ${DOCKER_SOURCE_CIDR} -> 3000/tcp, and ${WG_CIDR} forwarding + NAT."
        ;;
    esac
    ;;
esac
