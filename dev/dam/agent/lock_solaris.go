//go:build solaris

package main

import (
	"os"

	"golang.org/x/sys/unix"
)

// flockFile takes an exclusive, non-blocking advisory lock on an open file via fcntl
// (F_SETLK). Solaris / illumos does not expose flock(2) through Go's syscall package, so
// the audit-forward single-instance guard uses POSIX record locking instead. A zero Len
// locks the whole file; F_SETLK is non-blocking and returns EAGAIN/EACCES when another
// process already holds the lock — so we report false rather than waiting.
func flockFile(f *os.File) bool {
	lk := &unix.Flock_t{
		Type:   unix.F_WRLCK,
		Whence: 0, // SEEK_SET
		Start:  0,
		Len:    0, // whole file
	}
	return unix.FcntlFlock(f.Fd(), unix.F_SETLK, lk) == nil
}
