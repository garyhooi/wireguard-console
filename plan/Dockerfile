# Multi-stage: build the Vite/React app, then serve it (and reverse-proxy
# /api/*) from Caddy in the final image. One container does TLS + static
# hosting + routing — no separate nginx layer needed.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM caddy:2-alpine
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
