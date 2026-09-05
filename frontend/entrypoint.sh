#!/bin/sh
# Choose the Caddyfile variant at startup:
#   - WGCONSOLE_TLS=internal (or any non-empty value other than
#     external-proxy) → IP-only mode: internal CA, single :443 listener
#     (console + block page routes)
#   - WGCONSOLE_TLS=external-proxy → Cloudflare reverse-proxy mode:
#     the console is fronted by Cloudflare in Flexible/Automatic SSL mode,
#     which talks plain HTTP to this server. Caddy terminates NO TLS and
#     disables the automatic HTTP→HTTPS redirect (that redirect is what
#     causes the browser "redirected you too many times" loop when the
#     origin only ever receives HTTP).
#   - otherwise (empty) → domain mode: public ACME certificates
# A wrapper (rather than Caddyfile env interpolation) so the choice is
# deterministic and independent of image cache state.
set -e

if [ "${WGCONSOLE_TLS:-}" = "external-proxy" ]; then
	echo "[entrypoint] Cloudflare reverse-proxy mode: plain HTTP origin, no redirects"
	cp /etc/caddy/Caddyfile.cloudflare /etc/caddy/Caddyfile
elif [ -n "${WGCONSOLE_TLS:-}" ]; then
	echo "[entrypoint] IP-only mode: internal CA, single :443 listener"
	cp /etc/caddy/Caddyfile.ip /etc/caddy/Caddyfile
else
	echo "[entrypoint] Domain mode: public ACME certificates"
	cp /etc/caddy/Caddyfile.domain /etc/caddy/Caddyfile
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile