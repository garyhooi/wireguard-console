#!/bin/sh
# Choose the Caddyfile variant at startup from WGCONSOLE_TLS:
#   - external-proxy -> Cloudflare Flexible reverse-proxy mode: Cloudflare
#     terminates TLS and reaches this server over plain HTTP on :80. Caddy
#     terminates NO TLS and disables the HTTP->HTTPS redirect (that redirect
#     is what causes ERR_TOO_MANY_REDIRECTS when the origin only receives HTTP).
#   - internal (or legacy "ip") -> IP-only mode: internal CA, single :443
#     listener (console + block-page routes).
#   - domain (or empty) -> domain mode: public ACME certificates. This is the
#     shape Cloudflare Full / Full (strict) and "Automatic SSL/TLS" expect.
#     Unknown legacy values also fall back here instead of silently switching
#     to the IP-only listener.
# A wrapper (rather than Caddyfile env interpolation) so the choice is
# deterministic and independent of image cache state.
set -e

case "${WGCONSOLE_TLS:-}" in
	external-proxy)
		echo "[entrypoint] Cloudflare reverse-proxy mode: plain HTTP origin, no redirects"
		cp /etc/caddy/Caddyfile.cloudflare /etc/caddy/Caddyfile
		;;
	internal|ip)
		echo "[entrypoint] IP-only mode: internal CA, single :443 listener"
		cp /etc/caddy/Caddyfile.ip /etc/caddy/Caddyfile
		;;
	"")
		echo "[entrypoint] Domain mode: public ACME certificates"
		cp /etc/caddy/Caddyfile.domain /etc/caddy/Caddyfile
		;;
	*)
		echo "[entrypoint] Domain mode: public ACME certificates (WGCONSOLE_TLS=${WGCONSOLE_TLS})"
		cp /etc/caddy/Caddyfile.domain /etc/caddy/Caddyfile
		;;
esac

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
