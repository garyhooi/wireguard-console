#!/usr/bin/env bash
# TLS-mode helpers for install.sh (sourced; not executed on its own).
#
# WGCONSOLE_TLS values stored in .env:
#   domain         hostname: Caddy obtains public ACME certificates and serves
#                  HTTPS on :443. Works with Cloudflare Full / Full (strict),
#                  with "Automatic SSL/TLS" (which probes the origin over HTTP
#                  and HTTPS and only upgrades the encryption mode), and with
#                  DNS-only setups.
#   internal       bare-IP console: Caddy's internal CA on :443.
#   external-proxy hostname behind Cloudflare Flexible: Caddy serves plain HTTP
#                  on :80 and never redirects (Flexible cannot reach :443).
#
# install.sh resolves the mode once and persists it, so later runs are silent;
# CONSOLE_DOMAIN and WGCONSOLE_TLS on the command line override the stored
# values deliberately.

# resolve_tls_mode <console_domain> - normalise/complete WGCONSOLE_TLS.
# Explicit non-empty values win (caller env or stored .env). A bare IPv4
# address forces internal CA mode. An empty/legacy value becomes "domain" - the
# safe default for a hostname, because DNS cannot tell whether the proxy in
# front is Flexible (plain HTTP) or Full (HTTPS); guessing was the bug.
resolve_tls_mode() {
  local domain="${1}"
  case "${WGCONSOLE_TLS:-}" in
    ""|domain) WGCONSOLE_TLS="domain" ;;
    internal|ip) WGCONSOLE_TLS="internal" ;;
    external-proxy) WGCONSOLE_TLS="external-proxy" ;;
    *)
      echo "[tls] unknown WGCONSOLE_TLS='${WGCONSOLE_TLS}' - using domain mode" >&2
      WGCONSOLE_TLS="domain"
      ;;
  esac
  if [[ "${domain}" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && [[ "${WGCONSOLE_TLS}" != "external-proxy" ]]; then
    WGCONSOLE_TLS="internal"
  fi
}

# tls_mode_hint <http_code> <https_code> - classify the public console URL once
# the stack is running. Prints one of:
#   domain             origin redirects HTTP->HTTPS and answers on HTTPS
#   external-proxy     origin answers plain HTTP (Cloudflare Flexible shape)
#   loop               both redirect: Cloudflare Flexible against an HTTPS origin
#   https-unreachable  HTTPS did not answer (DNS/firewall/proxy mismatch)
#   unknown            not enough signal (e.g. 000:000)
tls_mode_hint() {
  case "${1}:${2}" in
    3*:2*) echo domain ;;
    2*:*) echo external-proxy ;;
    3*:3*) echo loop ;;
    *:000|3*:5*) echo https-unreachable ;;
    *) echo unknown ;;
  esac
}
