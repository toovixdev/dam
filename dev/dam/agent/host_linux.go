//go:build linux

// TooVix DAM Agent — host (eBPF) capture mode.
//
// Loads the SSL_read/SSL_write uprobes (see hostcap.bpf.c), attaches them to the
// DB server's libssl, and feeds the captured *plaintext* into the SAME wire-protocol
// decoders the network agent uses (frameAndDecode / frameAndDecodePG / frameAndDecodeTDS
// for queries; parseResponse* for result sets). The only thing that differs from
// network mode is the byte source: eBPF-below-TLS instead of AF_PACKET-above-TLS.
//
// This is what lets the host agent see TLS-encrypted MySQL/PostgreSQL sessions that
// passive network capture cannot.

package main

// amd64 only for now — both the GCP and AWS estates are x86_64. (arm64 needs that arch's
// struct pt_regs at build time; add -target arm64 when building natively on arm64.)
//go:generate go run github.com/cilium/ebpf/cmd/bpf2go -cc clang -target amd64 -cflags "-O2 -g -Wall" hostcap hostcap.bpf.c

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"github.com/cilium/ebpf/rlimit"
)

// event byte offsets — must match struct ssl_event in hostcap.bpf.c.
const (
	evtDirRead  = 0
	evtDirWrite = 1
	evtDirClose = 2

	evtHdrLen  = 38 // pid(4)+tid(4)+ssl(8)+len(4)+dir(1)+trunc(1)+comm(16)
	offSSL     = 8
	offLen     = 16
	offDir     = 20
	offComm    = 22
)

// procCommFor maps the engine to the DB server process name (comm, max 15 chars)
// used to filter the system-wide libssl uprobes down to just the database.
func procCommFor(cfg Config) string {
	if v := env("DB_PROC_COMM", ""); v != "" {
		return v
	}
	switch cfg.Engine {
	case "postgresql":
		return "postgres"
	case "mssql":
		return "sqlservr"
	default:
		return "mysqld"
	}
}

func runHost(cfg Config) {
	if err := rlimit.RemoveMemlock(); err != nil {
		log.Printf("host: could not raise memlock rlimit: %v (continuing)", err)
	}

	var objs hostcapObjects
	if err := loadHostcapObjects(&objs, nil); err != nil {
		log.Fatalf("host: load eBPF objects: %v", err)
	}
	defer objs.Close()

	// Two process models need different scoping (MySQL threads aren't all named "mysqld" —
	// query threads are "connection" — so a thread-comm filter would drop everything):
	//   MySQL/MariaDB — ONE multi-threaded process → PID-pin the uprobes to it (catches every
	//                   thread) and disable the comm filter.
	//   PostgreSQL    — ONE process PER connection, all comm="postgres" → attach system-wide and
	//                   filter by comm (backends fork after us, so a PID pin would miss them).
	comm := procCommFor(cfg)
	pidPin := cfg.Engine != "postgresql" // mysql/mariadb/default

	// Locate the DB process and the libssl it maps (retry — the agent may start first).
	sslPath := ""
	dbPid := 0
	for {
		pid := findProcByComm(comm)
		if pid > 0 {
			if p, err := findLibssl(pid); err == nil {
				sslPath, dbPid = p, pid
				log.Printf("host: DB process %q pid=%d uses %s", comm, pid, sslPath)
				break
			} else {
				log.Printf("host: pid %d has no libssl mapped yet (%v) — the DB may not be TLS-enabled; retrying", pid, err)
			}
		} else {
			log.Printf("host: waiting for DB process comm=%q to appear…", comm)
		}
		time.Sleep(5 * time.Second)
	}

	// comm filter: empty (match all) when PID-pinning, else scope to the DB comm.
	var cb [16]byte
	if !pidPin {
		copy(cb[:], comm)
	}
	if err := objs.TargetComm.Put(uint32(0), cb); err != nil {
		log.Fatalf("host: set target comm: %v", err)
	}

	ex, err := link.OpenExecutable(sslPath)
	if err != nil {
		log.Fatalf("host: open %s: %v", sslPath, err)
	}
	var upOpts *link.UprobeOptions
	if pidPin {
		upOpts = &link.UprobeOptions{PID: dbPid}
	}

	dbg := env("CAPTURE_DEBUG", "false") == "true"
	var links []link.Link
	up := func(sym string, prog *ebpf.Program) {
		l, err := ex.Uprobe(sym, prog, upOpts)
		if err != nil {
			log.Printf("host: attach uprobe %s failed: %v", sym, err)
			return
		}
		if dbg {
			log.Printf("host: attached uprobe %s (pidPin=%v)", sym, upOpts != nil)
		}
		links = append(links, l)
	}
	uret := func(sym string, prog *ebpf.Program) {
		l, err := ex.Uretprobe(sym, prog, upOpts)
		if err != nil {
			log.Printf("host: attach uretprobe %s failed: %v", sym, err)
			return
		}
		if dbg {
			log.Printf("host: attached uretprobe %s (pidPin=%v)", sym, upOpts != nil)
		}
		links = append(links, l)
	}
	up("SSL_write", objs.UprobeSslWrite)
	up("SSL_read", objs.UprobeSslRead)
	uret("SSL_read", objs.UretprobeSslRead)
	up("SSL_free", objs.UprobeSslFree)
	if len(links) == 0 {
		log.Fatalf("host: no uprobes attached — is %s the OpenSSL library exporting SSL_read/SSL_write?", sslPath)
	}
	defer func() {
		for _, l := range links {
			l.Close()
		}
	}()

	rd, err := ringbuf.NewReader(objs.Events)
	if err != nil {
		log.Fatalf("host: open ringbuf: %v", err)
	}
	defer rd.Close()

	log.Printf("host agent capturing below-TLS for engine=%s via %s (comm=%s)", cfg.Engine, sslPath, comm)

	conns := map[string]*connState{}
	for {
		rec, err := rd.Read()
		if err != nil {
			if errors.Is(err, ringbuf.ErrClosed) {
				return
			}
			continue
		}
		b := rec.RawSample
		if len(b) < evtHdrLen {
			continue
		}
		ssl := binary.LittleEndian.Uint64(b[offSSL : offSSL+8])
		dlen := int(binary.LittleEndian.Uint32(b[offLen : offLen+4]))
		dir := b[offDir]
		data := b[evtHdrLen:]
		if dlen > len(data) {
			dlen = len(data)
		}
		data = data[:dlen]

		if dbg {
			dirName := map[byte]string{evtDirRead: "READ", evtDirWrite: "WRITE", evtDirClose: "CLOSE"}[dir]
			log.Printf("[host-dbg] %-5s ssl=%x len=%d preview=%q", dirName, ssl, dlen, previewBytes(data, 48))
		}

		key := strconv.FormatUint(ssl, 16)
		if dir == evtDirClose {
			// Flush a query whose response never completed (see below) before dropping the conn.
			if st := conns[key]; st != nil {
				emitCaptured(cfg, st, st.rowCount)
			}
			delete(conns, key)
			continue
		}
		st := conns[key]
		if st == nil {
			st = &connState{principal: "unknown"}
			conns[key] = st
		}

		if dir == evtDirRead { // client→server on the server = the SQL query
			onQuery := func(sql string) {
				// Unlike network mode (which sees whole packets), eBPF caps each SSL_write at
				// MAX_DATA, so a large result set is truncated and parseResponse never sees the
				// terminator — the query would never emit. Flush the previous query here (its
				// full result has been consumed by now, since MySQL is synchronous per conn) so
				// it's captured with a best-effort row count.
				if st.haveQuery {
					emitCaptured(cfg, st, st.rowCount)
				}
				st.pendingSQL = sql
				st.pendingIP = "" // no peer IP below TLS; principal comes from the wire
				st.haveQuery = true
				st.rs = nrIdle
				st.rowCount = 0
			}
			buf := append(st.buf, data...)
			switch cfg.Engine {
			case "postgresql":
				st.buf = frameAndDecodePG(st, buf, onQuery)
			case "mssql":
				st.buf = frameAndDecodeTDS(st, buf, onQuery)
			default:
				st.buf = frameAndDecode(st, buf, onQuery)
			}
		} else { // server→client = the result set
			resp := append(st.respBuf, data...)
			switch cfg.Engine {
			case "postgresql":
				st.respBuf = parseResponsePG(cfg, st, resp)
			case "mssql":
				st.respBuf = parseResponseTDS(cfg, st, resp)
			default:
				st.respBuf = parseResponse(cfg, st, resp)
			}
		}
	}
}

// previewBytes renders up to n bytes for debug logging: printable ASCII as-is, else '.'.
func previewBytes(b []byte, n int) string {
	if len(b) > n {
		b = b[:n]
	}
	out := make([]byte, len(b))
	for i, c := range b {
		if c >= 0x20 && c < 0x7f {
			out[i] = c
		} else {
			out[i] = '.'
		}
	}
	return string(out)
}

// findProcByComm returns the pid of the first process whose comm matches want
// (comm is truncated to 15 chars by the kernel, so we compare on that prefix).
func findProcByComm(want string) int {
	if want == "" {
		return 0
	}
	if len(want) > 15 {
		want = want[:15]
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		c, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
		if err != nil {
			continue
		}
		if strings.TrimSpace(string(c)) == want {
			return pid
		}
	}
	return 0
}

// findLibssl returns a path to the libssl shared object the DB process uses, resolved
// through the process's own mount namespace via /proc/<pid>/root. That matters when the
// agent runs in its own container: the uprobe attaches to a specific inode, so we must
// open the *DB's* libssl (its mount ns), not the copy inside the agent's image — otherwise
// the probe sits on the wrong file and never fires. /proc/<pid>/root also transparently
// covers a DB running directly on the host (root is just /). Needs --pid host + privileges.
func findLibssl(pid int) (string, error) {
	f, err := os.Open(fmt.Sprintf("/proc/%d/maps", pid))
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		i := strings.IndexByte(line, '/')
		if i < 0 {
			continue
		}
		path := strings.TrimSpace(line[i:])
		if strings.Contains(path, "libssl") {
			nsPath := fmt.Sprintf("/proc/%d/root%s", pid, path)
			if _, err := os.Stat(nsPath); err == nil {
				return nsPath, nil // DB's inode as seen through its mount ns
			}
			return path, nil // fall back to our own view (agent running on the host itself)
		}
	}
	return "", errors.New("no libssl mapped")
}
