#!/usr/bin/env bash
#
# Tests for scripts/tls-mode.sh - the TLS-mode helpers install.sh sources.
#
# The installer used to guess the Cloudflare SSL mode from DNS and prompt for
# it on every run. It now defaults a hostname to domain mode (Caddy serves
# HTTPS on :443, what Cloudflare Full and "Automatic SSL/TLS" expect) and only
# warns when a public probe proves the Flexible-mode redirect loop. These tests
# pin that classification down.
set -euo pipefail
cd "${0%/*}/.." 2>/dev/null || cd "${0%/*}"
# shellcheck source=scripts/tls-mode.sh
source scripts/tls-mode.sh

fail() { echo "FAIL: ${*}" >&2; exit 1; }

expect_hint() {
  local got
  got="$(tls_mode_hint "${1}" "${2}")"
  [ "${got}" = "${3}" ] || fail "tls_mode_hint ${1} ${2} = '${got}', want '${3}'"
}

expect_hint 308 200 domain
expect_hint 301 200 domain
expect_hint 302 200 domain
expect_hint 200 200 external-proxy
expect_hint 200 404 external-proxy
expect_hint 308 308 loop
expect_hint 301 302 loop
expect_hint 308 000 https-unreachable
expect_hint 308 502 https-unreachable
expect_hint 000 000 https-unreachable
expect_hint 404 404 unknown

# resolve_tls_mode never prompts: explicit values win, a bare IP forces the
# internal CA, and a legacy empty value resolves to domain mode.
expect_mode() {
  (
    WGCONSOLE_TLS="${2}"
    resolve_tls_mode "${1}"
    [ "${WGCONSOLE_TLS}" = "${3}" ] || {
      echo "resolve_tls_mode '${1}' from '${2}' = '${WGCONSOLE_TLS}', want '${3}'" >&2
      exit 1
    }
  ) || fail "resolve_tls_mode '${1}' from '${2}'"
}

expect_mode "vpn.example.com" "" "domain"
expect_mode "vpn.example.com" "domain" "domain"
expect_mode "vpn.example.com" "external-proxy" "external-proxy"
expect_mode "vpn.example.com" "internal" "internal"
expect_mode "vpn.example.com" "ip" "internal"
expect_mode "vpn.example.com" "bogus" "domain"
expect_mode "203.0.113.5" "" "internal"
expect_mode "203.0.113.5" "internal" "internal"
expect_mode "203.0.113.5" "external-proxy" "external-proxy"

echo "ALL TLS-MODE TESTS PASSED"
