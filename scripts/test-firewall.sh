#!/usr/bin/env bash
#
# Tests for scripts/firewall.sh — the host-firewall helper install.sh and
# configure-adguard.sh now use.
#
# The helper must work on ufw, firewalld and bare-iptables hosts, and on the
# last one it must insert ACCEPT rules BEFORE a chain's catch-all
# REJECT/DROP — appending after it is a silent no-op (exactly the Oracle
# Cloud Ubuntu image bug: UDP 51820 accepted by the cloud Security List, then
# dropped by the image's iptables rules). Rules are stubbed with a fake
# iptables that keeps chain state in files, so this runs anywhere (CI, macOS)
# without root or a real firewall.
#
set -euo pipefail
cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
STATE="$TMP/state"
LOG="$TMP/log"
mkdir -p "$BIN" "$STATE"
: > "$LOG"

# --- fake iptables: chain state in files, enough of -S/-nvL/-I/-A/-D/-C ----
cat > "$BIN/iptables" <<'MOCK'
#!/usr/bin/env python3
import os
import sys

state_dir = os.environ["IPT_STATE"]


def path(table, chain):
    return os.path.join(state_dir, table + "." + chain)


def load(table, chain):
    p = path(table, chain)
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return [line.rstrip("\n") for line in f if line.strip() != ""]


def save(table, chain, lines):
    with open(path(table, chain), "w") as f:
        for line in lines:
            f.write(line + "\n")


args = sys.argv[1:]
table = "filter"
if len(args) >= 2 and args[0] == "-t":
    table, args = args[1], args[2:]
if not args:
    sys.exit(2)
cmd, rest = args[0], args[1:]

if cmd == "-S":
    chain = rest[0]
    print("-P %s ACCEPT" % chain)
    for rule in load(table, chain):
        print("-A %s %s" % (chain, rule))
elif cmd in ("-nvL", "-nL"):
    chain = rest[0]
    print("num   pkts bytes target     prot opt in     out     source               destination")
    for idx, rule in enumerate(load(table, chain), 1):
        toks = rule.split()
        target = toks[toks.index("-j") + 1] if "-j" in toks else "ACCEPT"
        print("%d 0 0 %s" % (idx, target))
elif cmd == "-I":
    chain = rest[0]
    pos = int(rest[1])
    rule = " ".join(rest[2:])
    lines = load(table, chain)
    lines.insert(pos - 1, rule)
    save(table, chain, lines)
elif cmd == "-A":
    chain = rest[0]
    rule = " ".join(rest[1:])
    lines = load(table, chain)
    lines.append(rule)
    save(table, chain, lines)
elif cmd == "-D":
    chain = rest[0]
    rule = " ".join(rest[1:])
    lines = load(table, chain)
    if rule not in lines:
        sys.exit(1)
    lines.remove(rule)
    save(table, chain, lines)
elif cmd == "-C":
    chain = rest[0]
    rule = " ".join(rest[1:])
    sys.exit(0 if rule in load(table, chain) else 1)
else:
    sys.exit(2)
MOCK
chmod +x "$BIN/iptables"

# --- fake ufw / firewall-cmd: log every call, report active state on demand --
cat > "$BIN/ufw" <<'MOCK'
#!/usr/bin/env bash
{ printf 'ufw'; printf ' %s' "$@"; printf '\n'; } >> "$FW_LOG"
if [ "$1" = "status" ]; then
  if [ "${UFW_ACTIVE:-0}" = "1" ]; then
    echo "Status: active"
  else
    echo "Status: inactive"
  fi
fi
exit 0
MOCK
chmod +x "$BIN/ufw"

cat > "$BIN/firewall-cmd" <<'MOCK'
#!/usr/bin/env bash
{ printf 'firewall-cmd'; printf ' %s' "$@"; printf '\n'; } >> "$FW_LOG"
if [ "$1" = "--state" ]; then
  if [ "${FIREWALLD_ACTIVE:-0}" = "1" ]; then
    echo "running"
  else
    echo "not running"
  fi
fi
exit 0
MOCK
chmod +x "$BIN/firewall-cmd"

export PATH="$BIN:$PATH"
export IPT_STATE="$STATE"
export FW_LOG="$LOG"
export WGC_FIREWALL_SKIP_PERSIST=1

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok - $*"; }

run_fw() { bash scripts/firewall.sh "$@"; }

chain_file() { echo "$STATE/filter.$1"; }
nat_file() { echo "$STATE/nat.POSTROUTING"; }

reset_state() {
  rm -f "$STATE"/*
  : > "$LOG"
}

pos_of() { # <file> <fixed string> -> first matching line number
  awk -v pat="$2" 'index($0, pat) { print NR; exit }' "$1"
}

first_reject_pos() {
  awk 'index($0, "-j REJECT") || index($0, "-j DROP") { print NR; exit }' "$1"
}

assert_rule_before_reject() { # <chain> <fixed rule fragment>
  local f rp p
  f="$(chain_file "$1")"
  rp="$(first_reject_pos "$f")"
  p="$(pos_of "$f" "$2")"
  [ -n "$p" ] || fail "$1 is missing rule: $2"
  [ -n "$rp" ] || fail "$1 fixture has no catch-all REJECT"
  [ "$p" -lt "$rp" ] || fail "$1 rule '$2' is at line $p, after REJECT at line $rp"
}

oracle_input() {
  cat > "$(chain_file INPUT)" <<'RULES'
-m state --state RELATED,ESTABLISHED -j ACCEPT
-p icmp -j ACCEPT
-i lo -j ACCEPT
-p tcp -m tcp --dport 22 -j ACCEPT
-j REJECT --reject-with icmp-host-prohibited
RULES
}

echo "== iptables host with Oracle-style catch-all REJECT =="
reset_state
oracle_input
cat > "$(chain_file FORWARD)" <<'RULES'
-j REJECT --reject-with icmp-host-prohibited
RULES
run_fw apply >/dev/null
assert_rule_before_reject INPUT "--dport 80 -j ACCEPT"
assert_rule_before_reject INPUT "--dport 443 -j ACCEPT"
assert_rule_before_reject INPUT "--dport 51820 -j ACCEPT"
assert_rule_before_reject INPUT "-i wg+ -p udp -m udp --dport 53 -j ACCEPT"
assert_rule_before_reject INPUT "-i wg+ -p tcp -m tcp --dport 53 -j ACCEPT"
assert_rule_before_reject INPUT "-s 172.16.0.0/12 -p tcp -m tcp --dport 3000 -j ACCEPT"
assert_rule_before_reject FORWARD "-s 10.8.0.0/24 -j ACCEPT"
assert_rule_before_reject FORWARD "-d 10.8.0.0/24 -j ACCEPT"
grep -q -- '-s 10.8.0.0/24 -j MASQUERADE' "$(nat_file)" || fail "nat MASQUERADE missing"
ok "ports + forwarding rules inserted before the REJECT; MASQUERADE added"

cp -r "$STATE" "$TMP/snap1"
run_fw apply >/dev/null
diff -r "$TMP/snap1" "$STATE" >/dev/null || fail "second apply changed the ruleset (not idempotent)"
ok "apply is idempotent"

echo "== iptables host: stray rules after the REJECT are repaired =="
reset_state
cat > "$(chain_file FORWARD)" <<'RULES'
-j REJECT --reject-with icmp-host-prohibited
-s 10.8.0.0/24 -j ACCEPT
-d 10.8.0.0/24 -j ACCEPT
RULES
run_fw apply >/dev/null
assert_rule_before_reject FORWARD "-s 10.8.0.0/24 -j ACCEPT"
assert_rule_before_reject FORWARD "-d 10.8.0.0/24 -j ACCEPT"
[ "$(grep -c -- '-s 10.8.0.0/24 -j ACCEPT' "$(chain_file FORWARD)")" = "1" ] \
  || fail "duplicate -s ACCEPT rule left behind"
[ "$(grep -c -- '-d 10.8.0.0/24 -j ACCEPT' "$(chain_file FORWARD)")" = "1" ] \
  || fail "duplicate -d ACCEPT rule left behind"
ok "stray rules moved before the REJECT, duplicates removed"

echo "== ufw host =="
reset_state
export UFW_ACTIVE=1
export FIREWALLD_ACTIVE=0
run_fw apply >/dev/null
grep -q -- 'ufw allow 80/tcp' "$LOG" || fail "ufw did not get 80/tcp"
grep -q -- 'ufw allow 443/tcp' "$LOG" || fail "ufw did not get 443/tcp"
grep -q -- 'ufw allow 51820/udp' "$LOG" || fail "ufw did not get 51820/udp"
grep -q -- 'ufw allow in on wg0 to any port 53 proto udp' "$LOG" || fail "ufw did not get wg-scoped UDP DNS"
grep -q -- 'ufw allow in on wg0 to any port 53 proto tcp' "$LOG" || fail "ufw did not get wg-scoped TCP DNS"
grep -q -- 'ufw allow from 172.16.0.0/12 to any port 3000 proto tcp' "$LOG" || fail "ufw did not get the AdGuard API path"
ok "ufw gets 80/443/51820, wg-scoped DNS and the docker->AdGuard API rule"

echo "== ufw host whose rules are shadowed by an Oracle-style catch-all REJECT =="
reset_state
cat > "$(chain_file INPUT)" <<'RULES'
-m state --state RELATED,ESTABLISHED -j ACCEPT
-p icmp -j ACCEPT
-i lo -j ACCEPT
-p tcp -m tcp --dport 22 -j ACCEPT
-j REJECT --reject-with icmp-host-prohibited
-j ufw-before-logging-input
-j ufw-before-input
-j ufw-after-input
-j ufw-reject-input
RULES
cat > "$(chain_file FORWARD)" <<'RULES'
-j DOCKER-USER
-j REJECT --reject-with icmp-host-prohibited
-s 10.8.0.0/24 -j ACCEPT
-d 10.8.0.0/24 -j ACCEPT
-j ufw-before-forward
RULES
export UFW_ACTIVE=1
export FIREWALLD_ACTIVE=0
run_fw apply >/dev/null
if grep -q -- '-j REJECT' "$(chain_file INPUT)"; then
  fail "INPUT still has the shadowing catch-all REJECT"
fi
if grep -q -- '-j REJECT' "$(chain_file FORWARD)"; then
  fail "FORWARD still has the shadowing catch-all REJECT"
fi
[ -n "$(pos_of "$(chain_file INPUT)" '-j ufw-before-input')" ] || fail "ufw jump rules disappeared"
[ -n "$(pos_of "$(chain_file FORWARD)" '-s 10.8.0.0/24 -j ACCEPT')" ] || fail "FORWARD accept rule disappeared"
run_fw apply >/dev/null
if grep -q -- '-j REJECT' "$(chain_file INPUT)"; then
  fail "shadow REJECT returned on the second run"
fi
ok "shadowing catch-all REJECT removed so the ufw rules are reachable"

echo "== firewalld host =="
reset_state
export UFW_ACTIVE=0
export FIREWALLD_ACTIVE=1
run_fw apply >/dev/null
grep -q -- 'firewall-cmd --permanent --add-port=80/tcp' "$LOG" || fail "firewalld did not get 80/tcp"
grep -q -- 'firewall-cmd --permanent --add-port=51820/udp' "$LOG" || fail "firewalld did not get 51820/udp"
grep -q -- 'source address=172.16.0.0/12 port port=3000 protocol=tcp accept' "$LOG" || fail "firewalld did not get the AdGuard API rule"
grep -q -- 'firewall-cmd --permanent --zone=trusted --add-interface=wg0' "$LOG" || fail "firewalld did not trust wg0 for tunnel DNS"
grep -q -- 'firewall-cmd --reload' "$LOG" || fail "firewalld was not reloaded"
ok "firewalld gets ports, AdGuard API rule, wg0 trusted zone and a reload"

echo "== dry run changes nothing =="
reset_state
oracle_input
export UFW_ACTIVE=0
export FIREWALLD_ACTIVE=0
cp -r "$STATE" "$TMP/snap2"
out="$(run_fw apply --dry-run)"
case "$out" in
  *"+ iptables -I INPUT"*) ;;
  *) fail "dry run did not print the planned iptables commands" ;;
esac
diff -r "$TMP/snap2" "$STATE" >/dev/null || fail "dry run modified the ruleset"
ok "dry run prints the plan and leaves the ruleset untouched"

echo
echo "ALL FIREWALL TESTS PASSED"
