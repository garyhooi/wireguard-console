# Frontend - Multi-stage: build the Vite/React app, then serve it (and reverse-proxy
# /api/*) from Caddy in the final image. One container does TLS + static
# hosting + routing — no separate nginx layer needed.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM caddy:2-alpine
COPY --from=build /app/dist /srv
# Two Caddyfile variants (domain mode / IP-only mode) plus an entrypoint
# wrapper that picks one at startup based on the WGCONSOLE_TLS env var —
# no Caddyfile env interpolation, immune to image-cache staleness.
COPY Caddyfile.domain Caddyfile.ip entrypoint.sh /etc/caddy/
RUN chmod +x /etc/caddy/entrypoint.sh
ENTRYPOINT ["/etc/caddy/entrypoint.sh"]