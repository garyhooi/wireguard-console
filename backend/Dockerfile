# Backend API
FROM golang:1.27 AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/api ./cmd/api

# Runtime is postgres:18-alpine itself (not distroless/debian) so the
# container ships pg_dump/psql matching the running server major version —
# the built-in backup & restore endpoints need them, and pg_dump refuses to
# dump a NEWER server than its own version. Also provides gzip + busybox
# wget (used by the compose healthcheck against /healthz).
FROM postgres:18-alpine
COPY --from=build /out/api /api
COPY --from=build /app/migrations /migrations
ENV MIGRATIONS_DIR=/migrations
EXPOSE 8080
ENTRYPOINT ["/api"]