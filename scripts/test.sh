#!/usr/bin/env bash
#
# Local test runner: backend unit + E2E, frontend tests + build, shell syntax.
# E2E needs a Postgres 18 — uses docker if present, else the Apple container
# runtime (`container`), else skips E2E with a warning.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_CONTAINER="wgc-test-pg-$$"
CLEANUP=()

cleanup() {
  if [[ -n "${PG_CONTAINER:-}" ]]; then
    if command -v docker >/dev/null 2>&1; then
      docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
    elif command -v container >/dev/null 2>&1; then
      container delete -f "$PG_CONTAINER" >/dev/null 2>&1 || true
    fi
  fi
  for c in "${CLEANUP[@]:-}"; do rm -rf "$c"; done
}
trap cleanup EXIT

echo "== backend: build + vet + unit tests =="
(cd backend && go build ./... && go vet ./... && go test ./...)

E2E_URL=""
if command -v docker >/dev/null 2>&1; then
  echo "== starting throwaway Postgres 18 (docker) =="
  docker run -d --name "$PG_CONTAINER" -e POSTGRES_USER=wgconsole -e POSTGRES_PASSWORD=testp123 -e POSTGRES_DB=wgconsole postgres:18-alpine >/dev/null
  for _ in $(seq 1 20); do
    docker exec "$PG_CONTAINER" pg_isready -U wgconsole -d wgconsole >/dev/null 2>&1 && break
    sleep 1
  done
  E2E_URL="postgres://wgconsole:testp123@localhost:5432/wgconsole?sslmode=disable"
elif command -v container >/dev/null 2>&1; then
  echo "== starting throwaway Postgres 18 (apple container) =="
  container run -d --name "$PG_CONTAINER" -e POSTGRES_USER=wgconsole -e POSTGRES_PASSWORD=testp123 -e POSTGRES_DB=wgconsole postgres:18-alpine >/dev/null
  sleep 6
  PGIP=$(container inspect "$PG_CONTAINER" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['status']['networks'][0]['ipv4Address'].split('/')[0])")
  E2E_URL="postgres://wgconsole:testp123@$PGIP:5432/wgconsole?sslmode=disable"
else
  echo "!! no docker or container runtime found — skipping E2E (set TEST_DATABASE_URL manually to run it)"
fi

if [[ -n "$E2E_URL" ]]; then
  echo "== backend: E2E suite =="
  # E2E_PG_PASSWORD feeds the API subprocess's POSTGRES_PASSWORD (needed by
  # the pg_dump-based backup tests). testp123 matches the throwaway PG above.
  (cd backend && TEST_DATABASE_URL="$E2E_URL" E2E_PG_USER=wgconsole E2E_PG_PASSWORD=testp123 E2E_PG_DB=wgconsole go test ./e2e/ -v -count=1)
fi

echo "== frontend: install + tests + build =="
(cd frontend && bun install --frozen-lockfile >/dev/null && bunx vitest run && bun run build)

echo "== shell scripts: syntax =="
bash -n install.sh node-install.sh scripts/scan-vulnerabilities.sh

echo
echo "ALL TESTS PASSED ✔"