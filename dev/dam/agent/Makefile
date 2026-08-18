# TooVix DAM Agent — build the static Linux binary and OS packages (.deb/.rpm).
#
# The agent is a single static Go binary with the eBPF program embedded (no libbpf/clang at
# runtime). Building it needs clang/libbpf/bpf2go, which live in the Docker builder — so the
# host that RUNS the agent needs none of that, and the build machine needs only Docker.
#
#   make binary     -> dist/dam-agent-linux-amd64   (static, amd64)
#   make packages   -> dist/dam-agent_<ver>_amd64.deb + dam-agent-<ver>.x86_64.rpm
#   make clean

IMAGE   ?= dam-agent:pkg-build
PLATFORM ?= linux/amd64
DIST     := dist
NFPM_IMG ?= goreleaser/nfpm:latest

.PHONY: binary solaris windows packages deb rpm clean

binary:
	mkdir -p $(DIST)
	DOCKER_BUILDKIT=1 docker build --platform $(PLATFORM) -t $(IMAGE) .
	cid=$$(docker create --platform $(PLATFORM) $(IMAGE)); \
	docker cp $$cid:/usr/local/bin/dam-agent $(DIST)/dam-agent-linux-amd64; \
	docker rm $$cid >/dev/null
	@echo "==> $(DIST)/dam-agent-linux-amd64"

# Solaris / illumos build. eBPF (host) and AF_PACKET (network) are Linux-only, so on Solaris
# the agent runs in MODE=proxy (inline TCP) or MODE=audit-forward (tail the DB audit log) —
# the same modes used on Windows. CGO off → a single self-contained binary; no clang/libbpf.
solaris:
	mkdir -p $(DIST)
	docker run --rm --platform linux/amd64 -v "$$PWD":/w -w /w \
	  -e GOOS=solaris -e GOARCH=amd64 -e CGO_ENABLED=0 golang:1.22-alpine \
	  sh -c 'apk add --no-cache git >/dev/null 2>&1; go build -trimpath -o $(DIST)/dam-agent-solaris-amd64 .'
	@echo "==> $(DIST)/dam-agent-solaris-amd64  (deploy with packaging/dam-agent.smf.xml)"

# Windows build (SQL Server via Extended Events over TDS). eBPF/AF_PACKET unavailable → proxy
# or audit-forward mode; runs as a Windows service.
windows:
	mkdir -p $(DIST)
	docker run --rm --platform linux/amd64 -v "$$PWD":/w -w /w \
	  -e GOOS=windows -e GOARCH=amd64 -e CGO_ENABLED=0 golang:1.22-alpine \
	  sh -c 'apk add --no-cache git >/dev/null 2>&1; go build -trimpath -o $(DIST)/dam-agent-windows-amd64.exe .'
	@echo "==> $(DIST)/dam-agent-windows-amd64.exe"

deb: binary
	docker run --rm --platform $(PLATFORM) -v "$$PWD":/w -w /w $(NFPM_IMG) \
	  package --config packaging/nfpm.yaml --target $(DIST) --packager deb

rpm: binary
	docker run --rm --platform $(PLATFORM) -v "$$PWD":/w -w /w $(NFPM_IMG) \
	  package --config packaging/nfpm.yaml --target $(DIST) --packager rpm

packages: deb rpm
	@ls -la $(DIST)

clean:
	rm -rf $(DIST)
