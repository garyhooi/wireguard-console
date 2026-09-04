FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN go mod init wgconsole/blockpage 2>/dev/null || true
RUN go build -o /blockpage .

FROM alpine:3.20
COPY --from=build /blockpage /usr/local/bin/blockpage
ENTRYPOINT ["blockpage"]
