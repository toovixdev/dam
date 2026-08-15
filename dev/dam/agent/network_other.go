//go:build !linux

package main

import "log"

// runNetwork is unavailable off Linux — AF_PACKET raw sniffing is a Linux facility. On Windows
// (SQL Server), use MODE=audit-forward (Extended Events over TDS), which also captures
// TLS-encrypted sessions and carries row counts.
func runNetwork(cfg Config) {
	log.Fatalf("network (AF_PACKET) capture requires Linux; on this OS use MODE=audit-forward")
}
