//go:build linux && !amd64

package main

import "log"

// eBPF host (below-TLS) capture is built for linux/amd64 only. Its BPF program
// (hostcap.bpf.c) reads function arguments via PT_REGS macros that need a full
// `struct pt_regs`, which x86 UAPI exposes but arm64 UAPI does not (arm64 has
// `struct user_pt_regs`), so the object won't cross-compile without a libbpf/CO-RE
// port. On non-amd64 Linux (e.g. arm64/aarch64) the agent still runs the network
// (AF_PACKET, plaintext) and proxy modes — use one of those instead of MODE=host.
func runHost(cfg Config) {
	log.Fatalf("host (eBPF/TLS) capture is only built for linux/amd64; on this architecture (%s) use MODE=network for plaintext or MODE=proxy", "arm64")
}
