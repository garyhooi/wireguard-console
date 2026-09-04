# wg-helper - The only container in the stack that holds CAP_NET_ADMIN
# (granted in docker-compose.yml, not here). Needs wireguard-tools in the runtime
# image for the base interface bring-up; everything after that goes
# through wgctrl-go over netlink.

FROM golang:1.27 AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/wg-helper ./cmd/wg-helper

FROM debian:12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends wireguard-tools iproute2 iptables ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/wg-helper /wg-helper
ENTRYPOINT ["/wg-helper"]
