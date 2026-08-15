//go:build !windows

package main

import (
	"os"
	"syscall"
)

// flockFile takes an exclusive, non-blocking advisory lock (flock) on an open file. Returns
// false if another process already holds it. Used by the audit-forward single-instance guard.
func flockFile(f *os.File) bool {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil
}
