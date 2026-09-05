#!/bin/sh
# Choose the Caddyfile variant at startup:
#   - WGCONSOLE_TLS set (any non-empty value, e.g. "internal") → IP-only
#     mode: internal CA, single :443 listener (console + block page routes)
#   - otherwise → domain mode: public ACME certificates
# A wrapper (rather than Caddyfile env interpolation) so the choice is
# deterministic and independent of image cache state.
set -e

if [ -n "${WGCONSOLE_TLS:-}" ]; then
	echo "[entrypoint] IP-only mode: internal CA, single :443 listener"
	cp /etc/caddy/Caddyfile.ip /etc/caddy/Caddyfile
else
	echo "[entrypoint] Domain mode: public ACME certificates"
	cp /etc/caddy/Caddyfile.domain /etc/caddy/Caddyfile
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile