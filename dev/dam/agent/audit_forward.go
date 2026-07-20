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
	"database/sql"
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"strings"
	"syscall"
	"time"
)

func runAuditForward(cfg Config) {
	// MongoDB has no audit log to tail (Community has no auditing at all) — its source is the
	// profiler COLLECTION, read over the wire. So AUDIT_LOG is required for every engine but
	// mongo, where the lock is keyed to the target instead.
	isMongo := cfg.Engine == "mongodb" || cfg.Engine == "mongo"
	if cfg.AuditLog == "" && !isMongo {
		log.Fatalf("audit-forward: AUDIT_LOG (path to the native audit log) is required")
	}
	lockKey := cfg.AuditLog
	if isMongo {
		lockKey = fmt.Sprintf("mongodb-%s-%s-%s", cfg.TargetHost, cfg.TargetPort, mongoDatabase(cfg))
	}
	// Single-instance guard: only ONE audit-forward agent per host+log may run. Two forwarders
	// tailing the same log double every event — which happens when leftover systemd template
	// instances coexist (e.g. dam-agent@audit + dam-agent@agentlite). Take an exclusive lock
	// keyed to the log path; a duplicate refuses to start rather than double-count.
	if !lockAuditForward(lockKey) {
		log.Printf("audit-forward: another AgentLite is already tailing %s on this host — refusing to start a duplicate (prevents double-counted events). Exiting.", lockKey)
		os.Exit(0)
	}
	log.Printf("AgentLite audit-forward tailing %s (source=%s engine=%s)", lockKey, cfg.AuditSource, cfg.Engine)
	switch cfg.Engine {
	case "mysql", "mariadb", "":
		tailMySQLGeneralLog(cfg, cfg.AuditLog)
	case "postgresql", "postgres":
		tailPostgresLog(cfg, cfg.AuditLog)
	case "mssql", "sqlserver":
		src := strings.ToLower(cfg.AuditSource)
		if strings.Contains(src, "xevent") || strings.Contains(src, "extended") {
			tailSqlServerXEvents(cfg) // richer source: carries row_count
		} else {
			tailSqlServerAudit(cfg)
		}
	case "mongodb", "mongo":
		tailMongoProfiler(cfg) // system.profile over the wire (see mongo_forward.go)
	default:
		log.Printf("audit-forward: engine %q not supported yet (mysql/mariadb/postgresql/mssql/mongodb) — enrolled + idle", cfg.Engine)
		select {}
	}
}

// tailSqlServerAudit forwards SQL Server's own audit trail. Unlike MySQL/PG, SQL Server Audit
// writes a BINARY .sqlaudit trail (not a text log we can tail), so we read it over TDS by polling
// sys.fn_get_audit_file() — which also means the agent can run on a separate Linux host and reach
// a Windows SQL Server over the network (no agent on Windows needed).
//
// Setup required on the DB: a Server Audit (TO FILE) + a Server Audit Specification (e.g.
// BATCH_COMPLETED_GROUP / SCHEMA_OBJECT_ACCESS_GROUP), both ENABLED. The login in DB_USER needs
// CONTROL SERVER (to read the audit file). AUDIT_LOG must be the .sqlaudit path pattern, e.g.
// 'C:\SQLAudit\*.sqlaudit' (Windows) or '/var/opt/mssql/audit/*.sqlaudit' (Linux).
func tailSqlServerAudit(cfg Config) {
	if cfg.DBUser == "" {
		log.Fatalf("audit-forward(mssql): DB_USER/DB_PASSWORD are required — the agent reads the audit over TDS (needs CONTROL SERVER)")
	}
	pollSec := atoiDefault(env("AUDIT_POLL_SEC", "10"), 10)
	db, err := sql.Open("sqlserver", mssqlDSN(cfg, orDefault(cfg.DBName, "master")))
	if err != nil {
		log.Fatalf("audit-forward(mssql): open: %v", err)
	}
	db.SetMaxOpenConns(2)
	defer db.Close()

	const q = `SELECT event_time, sequence_number,
	       COALESCE(server_principal_name, session_server_principal_name, '') AS principal,
	       COALESCE(client_ip, '') AS client_ip,
	       COALESCE(statement, '') AS statement
	FROM sys.fn_get_audit_file(@path, DEFAULT, DEFAULT)
	WHERE event_time > @wm AND statement IS NOT NULL AND LEN(statement) > 0
	ORDER BY event_time, sequence_number`

	// Start from the newest existing record so we don't replay history on (re)start.
	wm := time.Now().UTC()
	_ = db.QueryRow(tagAgentQuery(`SELECT ISNULL(MAX(event_time), SYSUTCDATETIME()) FROM sys.fn_get_audit_file(@path, DEFAULT, DEFAULT)`),
		sql.Named("path", cfg.AuditLog)).Scan(&wm)

	for {
		rows, err := db.Query(tagAgentQuery(q), sql.Named("path", cfg.AuditLog), sql.Named("wm", wm))
		if err != nil {
			log.Printf("audit-forward(mssql): read %s: %v — is SQL Server Audit ON, the path correct, and does DB_USER have CONTROL SERVER? retrying", cfg.AuditLog, err)
			time.Sleep(time.Duration(pollSec) * time.Second)
			continue
		}
		for rows.Next() {
			var et time.Time
			var seq int64
			var principal, clientIP, statement string
			if err := rows.Scan(&et, &seq, &principal, &clientIP, &statement); err != nil {
				continue
			}
			if s := strings.TrimSpace(statement); s != "" && shouldForward(s) {
				forwardEvent(cfg, orDefault(principal, "unknown"), clientIP, s, 0, false)
			}
			if et.After(wm) {
				wm = et
			}
		}
		rows.Close()
		time.Sleep(time.Duration(pollSec) * time.Second)
	}
}

// tailSqlServerXEvents forwards SQL Server statements from an Extended Events session — which,
// unlike SQL Server Audit, carries the ROW COUNT (plus duration/reads). It polls the session's
// .xel file target over TDS via sys.fn_xe_file_target_read_file and pulls each field straight out
// of the event XML in-query (no XML parsing here). Selected with AUDIT_SOURCE=xevents; AUDIT_LOG
// is the .xel path pattern (e.g. 'C:\SQLAudit\ToovixXE*.xel'). DB_USER needs VIEW SERVER STATE.
//
// DB setup: an event session on sqlserver.sql_statement_completed / rpc_completed with the
// server_principal_name + client_hostname actions, filtered to the target DB, to an event_file.
//
// AZURE SQL works through this same collector, with three differences (verified on appdb):
//   - the event_file target must be a BLOB URL, and AUDIT_LOG must be the EXACT generated blob
//     name — a '*' wildcard works for local paths but HANGS against blob storage;
//   - the session is created ON DATABASE, and the principal action is `username`
//     (`server_principal_name` does not exist there) — hence the COALESCE below;
//   - DB_USER needs VIEW DATABASE STATE rather than VIEW SERVER STATE.
func tailSqlServerXEvents(cfg Config) {
	if cfg.DBUser == "" {
		log.Fatalf("audit-forward(mssql/xevents): DB_USER/DB_PASSWORD required (reads the XE target over TDS)")
	}
	pollSec := atoiDefault(env("AUDIT_POLL_SEC", "10"), 10)
	db, err := sql.Open("sqlserver", mssqlDSN(cfg, orDefault(cfg.DBName, "master")))
	if err != nil {
		log.Fatalf("audit-forward(mssql/xevents): open: %v", err)
	}
	db.SetMaxOpenConns(2)
	defer db.Close()

	// NOTE on incremental reads: XEvents' file_offset is BLOCK-level (many events share one), and
	// predicates on fn_xe_file_target_read_file don't filter reliably (a WHERE on timestamp_utc
	// returns nothing even when newer rows exist). So we read the target and de-duplicate in Go by
	// (offset|timestamp|statement). The first pass only seeds the seen-set so we don't replay
	// history. The XE file rolls over (max_file_size/max_rollover_files), which bounds the read.
	const q = `SELECT file_offset, CONVERT(varchar(23), timestamp_utc, 126) AS ts,
	    x.value('(event/data[@name="row_count"]/value)[1]','bigint') AS rows_out,
	    COALESCE(
	      x.value('(event/action[@name="server_principal_name"]/value)[1]','nvarchar(128)'),
	      x.value('(event/action[@name="username"]/value)[1]','nvarchar(128)')
	    ) AS principal,
	    x.value('(event/action[@name="client_hostname"]/value)[1]','nvarchar(256)') AS client_host,
	    x.value('(event/data[@name="statement"]/value)[1]','nvarchar(max)') AS statement
	  FROM sys.fn_xe_file_target_read_file(@path, NULL, @initFile, @initOffset)
	  CROSS APPLY (SELECT TRY_CAST(event_data AS XML)) AS t(x)
	  ORDER BY file_offset`

	seen := map[string]bool{}
	first := true
	// Resume point. Passing initial_file_name + initial_offset makes the function skip every
	// event up to and including that offset, so each poll reads only what is NEW.
	//
	// Without this the collector re-read and re-XML-parsed the WHOLE file every poll, so the
	// cost grew with the file and eventually exceeded the connection timeout — at which point
	// capture stopped permanently, because the file only ever gets bigger. Measured on Azure:
	// ~1,100 events already took 8s for a bare COUNT(*), and the real query (five XML
	// extractions per row) timed out at 20s. A bulk insert is all it takes to tip it over.
	var lastOffset sql.NullInt64

	// Seed the resume point with a CHEAP query — MAX(file_offset) with no XML parsing — rather
	// than by reading the whole file once. On an accumulated target the full parse is exactly
	// what times out, and if the seeding pass times out the offset is never established, so
	// every later poll re-reads everything and the collector never recovers. Starting at the
	// current end also gives the intended "don't replay history on (re)start" behaviour.
	if err := db.QueryRow(tagAgentQuery(
		`SELECT MAX(file_offset) FROM sys.fn_xe_file_target_read_file(@path, NULL, NULL, NULL)`),
		sql.Named("path", cfg.AuditLog)).Scan(&lastOffset); err != nil {
		log.Printf("audit-forward(mssql/xevents): could not seed the read offset (%v) — starting from the beginning of %s", err, cfg.AuditLog)
	} else if lastOffset.Valid {
		log.Printf("audit-forward(mssql/xevents): resuming after file_offset %d (history not replayed)", lastOffset.Int64)
		first = false // nothing before this point should be forwarded, so no seeding pass needed
	}

	for {
		initFile := sql.Named("initFile", nil)
		initOffset := sql.Named("initOffset", nil)
		if lastOffset.Valid {
			initFile = sql.Named("initFile", cfg.AuditLog)
			initOffset = sql.Named("initOffset", lastOffset.Int64)
		}
		rows, err := db.Query(tagAgentQuery(q), sql.Named("path", cfg.AuditLog), initFile, initOffset)
		if err != nil {
			log.Printf("audit-forward(mssql/xevents): read %s: %v — is the XE session started (STATE=START), the path correct, and does DB_USER have VIEW SERVER STATE? retrying", cfg.AuditLog, err)
			time.Sleep(time.Duration(pollSec) * time.Second)
			continue
		}
		cur := make(map[string]bool, len(seen)+16)
		for rows.Next() {
			var offset sql.NullInt64
			var ts sql.NullString
			var rowCount sql.NullInt64
			var principal, clientHost, statement sql.NullString
			if err := rows.Scan(&offset, &ts, &rowCount, &principal, &clientHost, &statement); err != nil {
				continue
			}
			s := strings.TrimSpace(statement.String)
			if s == "" {
				continue
			}
			// Advance the resume point. Offsets are BLOCK-level, so many events share one and
			// resuming from it re-delivers that block's events — the seen-set below absorbs that.
			if offset.Valid && (!lastOffset.Valid || offset.Int64 > lastOffset.Int64) {
				lastOffset = offset
			}
			key := fmt.Sprintf("%d|%s|%s", offset.Int64, ts.String, s)
			cur[key] = true
			if first || seen[key] { // seed on the first pass; skip anything already forwarded
				continue
			}
			if !shouldForward(s) || isMssqlSystemStmt(s) {
				continue
			}
			forwardEvent(cfg, orDefault(principal.String, "unknown"), clientHost.String, s, int(rowCount.Int64), false)
		}
		rows.Close()
		// Keep the previous seen-set when a poll returned nothing. Now that reads are
		// incremental an idle poll yields no rows, and blanking the set would let the next
		// re-delivery of a boundary block be forwarded a second time.
		if len(cur) > 0 {
			seen = cur
		}
		first = false
		time.Sleep(time.Duration(pollSec) * time.Second)
	}
}

// isMssqlSystemStmt drops SQL Server's own catalog/monitoring reads. XEvents is statement-scoped
// (it sees every statement in the DB, unlike the object-scoped audit), so we filter the sys.*/
// information_schema chatter — including the agent's own poll — in code.
func isMssqlSystemStmt(sqlText string) bool {
	u := strings.ToLower(sqlText)
	// sp_reset_connection is emitted by the DRIVER, not by any application statement: pooled
	// connections are reset before being handed to the next user. It represents no user intent
	// and touches no data, but it fires on every pool reuse — measured at 953 of 955 captured
	// events (99.8%) on a lightly used Azure SQL database.
	//
	// The agentQueryTag self-filter cannot catch this: that marks statements the agent ISSUES,
	// whereas this is generated by the driver underneath it, so it carries no marker.
	if strings.Contains(u, "sp_reset_connection") || strings.Contains(u, "sp_resetconnection") {
		return true
	}
	for _, p := range []string{"sys.fn_xe_file_target", "sys.fn_get_audit_file", "information_schema.",
		"sys.database_scoped_configurations", "sys.dm_", "sys.database_audit", "sys.configurations"} {
		if strings.Contains(u, p) {
			return true
		}
	}
	return strings.HasPrefix(strings.TrimSpace(u), "select @@")
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
