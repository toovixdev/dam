# ── Stage 1: build the static agent binary WITH eBPF (served at /api/download) ──
# Build context is ./dam (see docker-compose), so agent/ (incl. *.c + packaging/) is available.
# The host (eBPF) mode needs clang/libbpf + `go generate` (bpf2go) to compile+embed the eBPF
# object; without it host_linux.go won't compile. Mirrors agent/Dockerfile.
FROM golang:1.22-alpine AS agent
RUN apk add --no-cache clang llvm libbpf-dev linux-headers bpftool git
WORKDIR /src
COPY agent/go.mod ./
COPY agent/*.go ./
COPY agent/*.c ./
RUN go mod tidy
RUN go generate ./...
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /out/dam-agent-linux-amd64 .

# ── Stage 1b: package the binary into .deb/.rpm with nfpm (served for the Package tab) ──
FROM golang:1.22-alpine AS pkg
RUN go install github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.35.3
WORKDIR /w
COPY --from=agent /out/dam-agent-linux-amd64 dist/dam-agent-linux-amd64
COPY agent/packaging/ packaging/
# /out must exist as a directory, else nfpm treats --target as the output filename.
RUN mkdir -p /out \
 && nfpm package --config packaging/nfpm.yaml --target /out --packager deb \
 && nfpm package --config packaging/nfpm.yaml --target /out --packager rpm \
 && ls -la /out

# ── Stage 2: the control-plane API ──
FROM node:20-alpine
WORKDIR /app
COPY api/package.json ./
RUN npm install --production
COPY api/main.js api/archive.js ./
# Customer-installable agent artifacts, served by the control plane at /api/download.
COPY --from=agent /out/dam-agent-linux-amd64 /app/artifacts/dam-agent-linux-amd64
COPY --from=pkg /out/dam-agent_0.1.0_amd64.deb /app/artifacts/dam-agent_amd64.deb
COPY --from=pkg /out/dam-agent-0.1.0-1.x86_64.rpm /app/artifacts/dam-agent_amd64.rpm
EXPOSE 3000
CMD ["node", "main.js"]
