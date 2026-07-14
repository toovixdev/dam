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

.PHONY: binary packages deb rpm clean

binary:
	mkdir -p $(DIST)
	DOCKER_BUILDKIT=1 docker build --platform $(PLATFORM) -t $(IMAGE) .
	cid=$$(docker create --platform $(PLATFORM) $(IMAGE)); \
	docker cp $$cid:/usr/local/bin/dam-agent $(DIST)/dam-agent-linux-amd64; \
	docker rm $$cid >/dev/null
	@echo "==> $(DIST)/dam-agent-linux-amd64"

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
