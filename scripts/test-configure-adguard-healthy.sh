#!/usr/bin/env bash
# Sandboxed behavior test for configure-adguard.sh healthy-skip logic.
# Stubs docker/curl/ufw so no daemon, no root, no network is needed.
# Runs from a scratch dir that mirrors /opt/wireguard-console layout.
set -euo pipefail

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$SCRATCH/backend/cmd"
cp "$REPO_DIR/configure-adguard.sh" "$SCRATCH/"
cp -r "$REPO_DIR/backend/cmd/aghenc" "$SCRATCH/backend/cmd/" 2>/dev/null || true
printf 'CONSOLE_DOMAIN=test\nADGUARD_API_USER=admin\nADGUARD_API_PASSWORD=secretpw\n' > "$SCRATCH/.env"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# ---- stub commands live in PATH ----
STUB="$SCRATCH/stub-bin"
mkdir -p "$STUB"
cat > "$STUB/docker" <<'EOF'
#!/usr/bin/env bash
# args: volume ls -q | ps ... | run ... | stop ... | start ...
case "${1:-}" in
  volume) echo "wireguard-console_agh-conf" ;;
  ps)     echo "wireguard-console-adguardhome-1 adguard/adguardhome:v0.107.79 Up 1 hour" ;;
  run)    # simulate aghenc output: name:bcrypt-ish-hash
    echo "admin:\$2a\$10\$abcdefghijklmnopqrstuv" ;;
  stop|start) : ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$STUB/docker"

cat > "$STUB/curl" <<'EOF'
#!/usr/bin/env bash
# healthy by default: /control/status -> HTTP 200 (only meaningful with -u creds)
for a in "$@"; do
  case "$a" in
    *control/status*) echo "200"; exit 0 ;;
  esac
done
echo "000"
EOF
chmod +x "$STUB/curl"

# ufw "not active" so the ufw branch is skipped in this harness
cat > "$STUB/ufw" <<'EOF'
#!/usr/bin/env bash
echo "Status: inactive"
EOF
chmod +x "$STUB/ufw"

cat > "$STUB/python3" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/python3 "$@"
EOF
chmod +x "$STUB/python3"

export PATH="$STUB:$PATH"
export COMPOSE_DIR="$SCRATCH"
export ENV_FILE="$SCRATCH/.env"

echo "== CASE 1: healthy AdGuard (200) => skip rewrite, no provision =="
out1="$(cd "$SCRATCH" && bash configure-adguard.sh 2>&1)" || { bad "healthy case exited nonzero"; }
echo "$out1" | grep -q "healthy — nothing to do" && ok "prints healthy skip message" || bad "missing healthy message: $out1"
echo "$out1" | grep -q "Generating AdGuard bcrypt" && bad "should NOT provision when healthy" || ok "did not provision when healthy"

echo "== CASE 2: --force => provision path runs =="
# --force should ignore health and reach the bcrypt step (which needs a
# "docker run" aghenc hash + a "docker stop" + "docker compose up"). Our stub
# docker run prints a hash; the alpine write step is stubbed by docker run too.
out2="$(cd "$SCRATCH" && bash configure-adguard.sh --force 2>&1)" || rc2=$?
echo "$out2" | grep -q "Generating AdGuard bcrypt" && ok "--force reaches provision" || bad "--force did not provision: $out2"

echo
echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
