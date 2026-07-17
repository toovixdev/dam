// TooVix DAM Agent — AgentLite (audit-forward) capture mode.
//
// A lightweight forwarder that tails the database's OWN native audit log on the host and
// ships each statement as an event — no wire tap, no path change, and no DB connection to
// capture (the DB writes the audit after it decrypts, so this is transport-independent).
// Detective only: after-the-fact, cannot block. This build parses the MySQL/MariaDB general
// query log; other engines' audit formats are TODO.
package main

import (
	"bufio"
	"io"
	"log"
	"os"
	"regexp"
	"strings"
	"syscall"
	"time"
)

func runAuditForward(cfg Config) {
	if cfg.AuditLog == "" {
		log.Fatalf("audit-forward: AUDIT_LOG (path to the native audit log) is required")
	}
	// Single-instance guard: only ONE audit-forward agent per host+log may run. Two forwarders
	// tailing the same log double every event — which happens when leftover systemd template
	// instances coexist (e.g. dam-agent@audit + dam-agent@agentlite). Take an exclusive lock
	// keyed to the log path; a duplicate refuses to start rather than double-count.
	if !lockAuditForward(cfg.AuditLog) {
		log.Printf("audit-forward: another AgentLite is already tailing %s on this host — refusing to start a duplicate (prevents double-counted events). Exiting.", cfg.AuditLog)
		os.Exit(0)
	}
	log.Printf("AgentLite audit-forward tailing %s (source=%s engine=%s)", cfg.AuditLog, cfg.AuditSource, cfg.Engine)
	switch cfg.Engine {
	case "mysql", "mariadb", "":
		tailMySQLGeneralLog(cfg, cfg.AuditLog)
	case "postgresql", "postgres":
		tailPostgresLog(cfg, cfg.AuditLog)
	default:
		log.Printf("audit-forward: engine %q not supported yet (mysql/mariadb/postgresql) — enrolled + idle", cfg.Engine)
		select {}
	}
}

// auditLockFile holds the single-instance lock for the process lifetime (the OS releases it on exit).
var auditLockFile *os.File

// lockAuditForward takes an exclusive, non-blocking flock keyed to the audit-log path so only one
// audit-forward agent per host+log can run. Returns false if another live instance holds the lock;
// returns true (fail-open) if no lock file can be created, so a lock-file quirk never blocks capture.
func lockAuditForward(path string) bool {
	name := "toovix-agentlite" + strings.ReplaceAll(path, "/", "_") + ".lock"
	for _, dir := range []string{"/run", "/tmp"} {
		f, err := os.OpenFile(dir+"/"+name, os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			continue
		}
		if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			f.Close()
			return false // held by another live audit-forward instance
		}
		auditLockFile = f // keep open for the process lifetime
		return true
	}
	return true // couldn't create a lock file anywhere — don't block capture over that
}

// MySQL general-log FILE line: "<time>\t   <id> <Command>\t<argument>". The time column is
// blank when it hasn't changed; the command line's id is space-padded before the command.
var mysqlLogRe = regexp.MustCompile(`^(\S*)\t\s*(\d+)\s+([A-Za-z ]+?)\t(.*)$`)

func tailMySQLGeneralLog(cfg Config, path string) {
	connUser := map[string]string{} // connection id → user
	connHost := map[string]string{} // connection id → client host
	var pendID, pendSQL string
	var havePend bool

	flush := func() {
		if havePend {
			if sql := strings.TrimSpace(pendSQL); sql != "" && shouldForward(sql) {
				forwardEvent(cfg, orDefault(connUser[pendID], "unknown"), connHost[pendID], sql, 0, false)
			}
			havePend, pendSQL = false, ""
		}
	}

	process := func(line string) {
		m := mysqlLogRe.FindStringSubmatch(line)
		if m == nil {
			if havePend { // continuation of a multi-line query argument
				pendSQL += "\n" + line
			}
			return
		}
		flush() // a new entry ends the previous one
		id, cmd, arg := m[2], strings.TrimSpace(m[3]), m[4]
		switch cmd {
		case "Connect":
			u, h := parseConnect(arg) // "user@host on db using SSL/TLS"
			connUser[id], connHost[id] = u, h
		case "Query", "Execute":
			pendID, pendSQL, havePend = id, arg, true
		case "Quit":
			delete(connUser, id)
			delete(connHost, id)
		}
	}

	tailLines(path, process, flush)
}

// tailLines follows a growing / rotating log file: it seeks to the end (no history replay
// on start), reads each new line into process(), and calls flush() at every EOF. Shared by
// the MySQL and PostgreSQL audit-forward parsers.
func tailLines(path string, process func(string), flush func()) {
	var offset int64
	if fi, err := os.Stat(path); err == nil {
		offset = fi.Size() // start at end — don't replay history on (re)start
	}
	for {
		f, err := os.Open(path)
		if err != nil {
			log.Printf("audit-forward: open %s: %v — is the DB's audit/general log ON and writing here? retrying", path, err)
			time.Sleep(5 * time.Second)
			continue
		}
		if fi, _ := f.Stat(); fi != nil && fi.Size() < offset {
			offset = 0 // file rotated / truncated — restart from the top
		}
		f.Seek(offset, io.SeekStart)
		r := bufio.NewReader(f)
		for {
			line, err := r.ReadString('\n')
			if len(line) > 0 {
				offset += int64(len(line))
				process(strings.TrimRight(line, "\r\n"))
			}
			if err != nil {
				break // EOF
			}
		}
		flush()
		f.Close()
		time.Sleep(1 * time.Second)
	}
}

// ── PostgreSQL stderr log (audit-forward) ────────────────────────────────────
// Needs log_statement='all' and log_line_prefix='%m [%p] %q%u@%d ', so each statement is:
//   2026-01-02 15:04:05.000 UTC [1234] user@db LOG:  statement: SELECT ...
// The extended/prepared protocol logs "execute <name>: <sql>". Background / session-less
// lines carry no user@db (the %q stops the prefix there) and so never match.
var pgLogRe = regexp.MustCompile(`^\S+ \S+ \S+ \[\d+\] (\S+)@(\S+) LOG:\s+(?:statement|execute[^:]*): (.*)$`)

func tailPostgresLog(cfg Config, path string) {
	var pendUser, pendSQL string
	var havePend bool

	flush := func() {
		if havePend {
			if sql := strings.TrimSpace(pendSQL); sql != "" && shouldForward(sql) {
				forwardEvent(cfg, orDefault(pendUser, "unknown"), "", sql, 0, false)
			}
			havePend, pendSQL = false, ""
		}
	}

	process := func(line string) {
		m := pgLogRe.FindStringSubmatch(line)
		if m == nil {
			if havePend { // continuation of a multi-line statement
				pendSQL += "\n" + line
			}
			return
		}
		flush()                                     // a new statement ends the previous one
		pendUser, pendSQL, havePend = m[1], m[3], true // m[2] = database (unused; event uses TARGET_DB)
	}

	tailLines(path, process, flush)
}

// parseConnect pulls user + client host from "user@host on db using SSL/TLS".
func parseConnect(arg string) (user, host string) {
	arg = strings.TrimSpace(arg)
	if i := strings.Index(arg, " on "); i >= 0 {
		arg = arg[:i]
	}
	if i := strings.Index(arg, " using "); i >= 0 {
		arg = arg[:i]
	}
	if at := strings.LastIndex(arg, "@"); at >= 0 {
		return arg[:at], arg[at+1:]
	}
	return arg, ""
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// shouldForward drops obvious client/monitoring noise so the trail stays about real activity.
func shouldForward(sql string) bool {
	u := strings.ToUpper(strings.TrimSpace(sql))
	switch {
	case u == "", u == "COMMIT", u == "ROLLBACK", u == "PING":
		return false
	case strings.HasPrefix(u, "SET "), strings.HasPrefix(u, "SHOW "), strings.HasPrefix(u, "/*"):
		return false
	}
	return true
}
