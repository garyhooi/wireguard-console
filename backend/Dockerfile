# Backend API
FROM golang:1.27 AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/api ./cmd/api

# Debian slim runtime (not distroless) so the container includes pg_dump /
# psql / gzip for the built-in backup & restore endpoints, plus curl for
# the compose healthcheck and CA certificates for outbound TLS.
FROM debian:12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates postgresql-client curl gzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/api /api
EXPOSE 8080
ENTRYPOINT ["/api"]