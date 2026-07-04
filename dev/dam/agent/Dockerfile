# TooVix DAM Agent — single Go binary, MODE-selectable. Built locally by docker-compose
# (no registry needed for dev). For production this image is pushed to a registry the
# customer's environment can pull from.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /dam-agent .

FROM alpine:3.20
RUN adduser -D -u 10001 toovix
USER toovix
COPY --from=build /dam-agent /usr/local/bin/dam-agent
ENTRYPOINT ["/usr/local/bin/dam-agent"]
