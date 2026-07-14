//go:build !linux

package main

import "log"

// runHost is a no-op stub on non-Linux platforms. eBPF host capture is Linux-only;
// the production agent image is always built GOOS=linux (see Dockerfile).
func runHost(cfg Config) {
	log.Fatalf("host (eBPF) mode requires Linux; build/run the agent on a Linux host")
}
