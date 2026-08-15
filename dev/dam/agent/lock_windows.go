//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// flockFile takes an exclusive, immediate lock on an open file via LockFileEx — the Windows
// equivalent of a non-blocking flock. Returns false if another process already holds it.
func flockFile(f *os.File) bool {
	ol := new(windows.Overlapped)
	err := windows.LockFileEx(
		windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, ol,
	)
	return err == nil
}
