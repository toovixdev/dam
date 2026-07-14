# TooVix DAM Agent — single Go binary, MODE-selectable (network | host | proxy).
# The host mode is eBPF: its kernel program (hostcap.bpf.c) is compiled with clang and
# embedded into the Go binary via bpf2go at build time, so the shipped image stays a
# single self-contained binary (no external .o, no libbpf runtime — cilium/ebpf is pure Go).
FROM golang:1.22-alpine AS build
RUN apk add --no-cache clang llvm libbpf-dev linux-headers bpftool git
WORKDIR /src
COPY go.mod ./
COPY *.go ./
COPY *.c ./
# Resolve the module graph first (tidy only needs import paths, not the generated symbols),
# so `go run bpf2go` has a consistent go.mod/go.sum.
RUN go mod tidy
# Compile the eBPF program and generate its Go bindings (amd64 + arm64 objects).
RUN go generate ./...
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /dam-agent .

FROM alpine:3.20
RUN adduser -D -u 10001 toovix
# host (eBPF) mode needs root + CAP_BPF/CAP_PERFMON at runtime; the deploy command runs the
# container privileged. network/proxy also run privileged, so the image keeps root available.
COPY --from=build /dam-agent /usr/local/bin/dam-agent
ENTRYPOINT ["/usr/local/bin/dam-agent"]
