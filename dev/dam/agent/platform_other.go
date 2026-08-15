//go:build !windows

package main

// platformMain runs the agent directly on Linux/macOS. Under systemd (Linux) the process is the
// service; there is no service-manager handshake to perform. Windows overrides this to run under
// the Service Control Manager (see platform_windows.go).
func platformMain(run func()) { run() }
