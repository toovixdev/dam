// TooVix DAM Agent — AgentLite (audit-forward) collector for Oracle Database.
//
// Oracle's telemetry is Unified Auditing: every audited action lands in the AUDSYS view
// UNIFIED_AUDIT_TRAIL. Like SQL Server (and unlike MySQL/PG) there is no text log to tail, so
// this collector POLLS the view over SQL*Net with an EVENT_TIMESTAMP watermark. That means it
// runs on any host with 1521 reachability and a read-only login — nothing is installed on the
// DB host, and it therefore covers Oracle on a VM, on RDS, and on OCI equally.
//
// Row counts: UNIFIED_AUDIT_TRAIL carries NO rows-returned column and no SQL_ID, so the count
// is recovered by joining V$SQLSTATS on the statement text. V$SQLSTATS (not V$SQL) is used
// deliberately — V$SQL cursors age out of the shared pool within seconds on a small SGA, so a
// poller would routinely find nothing; V$SQLSTATS retains the stats after the cursor is gone.
// The join is exact for ad-hoc statements (unique SQL_ID, EXECUTIONS=1) and an ESTIMATE for
// parameterised app traffic (ROWS_PROCESSED is cumulative across executions) — hence the
// per-execution average and the executions count carried alongside. Verified on Oracle 23ai:
// `SELECT * FROM CUSTOMERS` → ROWS_PROCESSED=25, EXECUTIONS=1.
//
// DB setup: unified auditing on (23ai is pure-unified by default) plus an audit policy, e.g.
//   CREATE AUDIT POLICY toovix_dml ACTIONS SELECT, INSERT, UPDATE, DELETE;
//   AUDIT POLICY toovix_dml BY <appuser>;
// The DB_USER login needs AUDIT_VIEWER (reads UNIFIED_AUDIT_TRAIL) and SELECT_CATALOG_ROLE
// (reads V$SQLSTATS, and ALL_TAB_COLUMNS for classification).
//
// Detective only: after-the-fact, cannot block.
package main

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"

	go_ora "github.com/sijms/go-ora/v2" // canonical URL builder — handles TLS/wallet encoding
)

// oracleDSN builds a go-ora connection URL. Oracle connects to a SERVICE NAME (the PDB), which
// TARGET_DB carries; DB_NAME overrides it when the display name and the service differ.
//
// TLS: on-VM/on-prem Oracle uses plain TCP (1521). A managed endpoint — OCI Autonomous Database,
// notably — uses TCPS (one-way TLS on 1522) and the connection fails without SSL. TLS is enabled
// when ORACLE_SSL=true, or auto-detected for the OCI ADB endpoint (host *.oraclecloud.com or
// port 1522). ORACLE_SSL_VERIFY defaults to false: ADB one-way TLS presents a server cert we
// don't ship the CA for, so verification is skipped (the ACL on the ADB is the access control).
// For the mutual-TLS/wallet path instead, set ORACLE_WALLET to the unzipped wallet directory.
func oracleDSN(cfg Config) string {
	// ORACLE_SERVICE wins for the connection service name — OCI ADB service names are long
	// (…_toovixadb_low.adb.oraclecloud.com), so this lets DB_NAME stay a short display label
	// while the real service is passed separately. Falls back to DB_NAME for on-VM Oracle.
	svc := orDefault(env("ORACLE_SERVICE", ""), orDefault(cfg.DBName, "FREEPDB1"))
	host := orDefault(cfg.TargetHost, "127.0.0.1")
	port := atoiDefault(orDefault(cfg.TargetPort, "1521"), 1521)

	opts := map[string]string{}
	ssl := env("ORACLE_SSL", "")
	if ssl == "" && (strings.Contains(strings.ToLower(host), "oraclecloud.com") || port == 1522) {
		ssl = "true" // auto-detect OCI ADB
	}
	if ssl == "true" || ssl == "enable" {
		opts["ssl"] = "true"
		if w := env("ORACLE_WALLET", ""); w != "" {
			opts["wallet"] = w // mutual TLS
		} else {
			opts["ssl verify"] = env("ORACLE_SSL_VERIFY", "false") // one-way TLS, no wallet
		}
	}
	// BuildUrl encodes the service name and option keys (incl. the space in "ssl verify") correctly.
	return go_ora.BuildUrl(host, port, svc, cfg.DBUser, cfg.DBPass, opts)
}

// tailOracleAudit polls UNIFIED_AUDIT_TRAIL, enriches each row with a row count from
// V$SQLSTATS, and forwards it. Mirrors tailSqlServerAudit's watermark + de-dupe shape.
func tailOracleAudit(cfg Config) {
	if cfg.DBUser == "" {
		log.Fatalf("audit-forward(oracle): DB_USER/DB_PASSWORD are required — the agent reads UNIFIED_AUDIT_TRAIL over SQL*Net (needs AUDIT_VIEWER)")
	}
	pollSec := atoiDefault(env("AUDIT_POLL_SEC", "10"), 10)
	db, err := sql.Open("oracle", oracleDSN(cfg))
	if err != nil {
		log.Fatalf("audit-forward(oracle): open: %v", err)
	}
	db.SetMaxOpenConns(2)
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatalf("audit-forward(oracle): ping %s: %v — check TARGET_HOST/PORT, the service name (DB_NAME), and DB_USER/DB_PASSWORD", cfg.TargetHost, err)
	}

	// EVENT_TIMESTAMP is TIMESTAMP(6) with NO time zone (Oracle stores it in UTC). Binding a Go
	// time.Time makes go-ora apply a session-timezone conversion, which shifts the watermark and
	// silently excludes every row. So the watermark is carried as a UTC string and compared with
	// an explicit TO_TIMESTAMP — no driver time conversion touches it. The timestamp is also
	// SELECTed back as a formatted string so advancing the watermark uses the same representation.
	//
	// SQL_TEXT is a CLOB; DBMS_LOB.SUBSTR yields a VARCHAR2 that can be joined and returned. 1000
	// chars matches V$SQLSTATS.SQL_TEXT's width. The LEFT JOIN is essential — a V$SQLSTATS miss
	// must still forward the audit event (rows=0), never drop it.
	const tsFmt = `YYYY-MM-DD HH24:MI:SS.FF6`

	// Exclude Oracle-maintained accounts/schemas IN THE QUERY, not in Go. On OCI Autonomous DB
	// the automatic SQL-tuning task generates enormous internal traffic — measured at 50,733 SYS
	// records in 20 minutes on an idle instance — so filtering it in Go means reading all of it
	// over the wire every poll (and, with the lookback below, repeatedly). Excluding it at the
	// source keeps each poll to real user activity.
	var q []string
	for k := range oracleInternalSchemas {
		q = append(q, "'"+k+"'")
	}
	inList := strings.Join(q, ",")
	query := `SELECT
	    TO_CHAR(a.EVENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS.FF6'),
	    a.DBUSERNAME,
	    NVL(a.OBJECT_SCHEMA, ''),
	    NVL(a.OBJECT_NAME, ''),
	    NVL(a.USERHOST, ''),
	    NVL(a.ACTION_NAME, ''),
	    a.RETURN_CODE,
	    DBMS_LOB.SUBSTR(a.SQL_TEXT, 4000, 1),
	    NVL(s.ROWS_PROCESSED, 0),
	    NVL(s.EXECUTIONS, 0),
	    NVL(a.SESSIONID, 0), NVL(a.ENTRY_ID, 0),
	    NVL(a.CLIENT_PROGRAM_NAME, '')
	  FROM UNIFIED_AUDIT_TRAIL a
	  LEFT JOIN V$SQLSTATS s
	    ON RTRIM(s.SQL_TEXT, CHR(0)||CHR(10)||CHR(13)||CHR(9)||' ')
	     = RTRIM(DBMS_LOB.SUBSTR(a.SQL_TEXT, 4000, 1), CHR(0)||CHR(10)||CHR(13)||CHR(9)||' ')
	  WHERE a.EVENT_TIMESTAMP > TO_TIMESTAMP(:wm, 'YYYY-MM-DD HH24:MI:SS.FF6') - NUMTODSINTERVAL(:lb, 'SECOND')
	    AND a.SQL_TEXT IS NOT NULL
	    -- ORACLE_MAINTAINED='Y' is the authoritative flag for accounts Oracle runs itself: not
	    -- just SYS, but the Autonomous-bundled tooling (ODI_REPO_USER, ORDS, GRAPH$, …) whose
	    -- background jobs also flood the trail. The hardcoded list is a fallback in case
	    -- DBA_USERS is unreadable or a flag is wrong.
	    AND NVL(a.DBUSERNAME, 'x') NOT IN (SELECT username FROM DBA_USERS WHERE ORACLE_MAINTAINED = 'Y')
	    AND NVL(a.OBJECT_SCHEMA, 'x') NOT IN (SELECT username FROM DBA_USERS WHERE ORACLE_MAINTAINED = 'Y')
	    AND NVL(a.DBUSERNAME, 'x') NOT IN (` + inList + `)
	    AND NVL(a.OBJECT_SCHEMA, 'x') NOT IN (` + inList + `)
	  ORDER BY a.EVENT_TIMESTAMP`

	// Lookback + de-dupe, because UNIFIED_AUDIT_TRAIL becomes visible with a LAG and OUT OF ORDER
	// vs EVENT_TIMESTAMP: a statement at 08:17 can surface after the watermark has already
	// advanced past it, so a plain "event_timestamp > watermark" silently loses it — verified on
	// ADB, where real user DML was in the trail but never captured. We instead re-scan a window
	// (watermark − lookback) each poll and de-dupe in Go by (timestamp|session|entry). Default 15
	// min covers ADB's flush lag; tune with ORACLE_AUDIT_LOOKBACK_SEC.
	lookback := atoiDefault(env("ORACLE_AUDIT_LOOKBACK_SEC", "900"), 900)
	seen := map[string]bool{}
	first := true

	// Start from the newest existing record (as a UTC string) so a (re)start does not replay
	// history. SYS_EXTRACT_UTC keeps the fallback in the same UTC frame as EVENT_TIMESTAMP.
	var wm string
	_ = db.QueryRow(tagAgentQuery(
		`SELECT TO_CHAR(NVL(MAX(EVENT_TIMESTAMP), SYS_EXTRACT_UTC(SYSTIMESTAMP)), '` + tsFmt + `') FROM UNIFIED_AUDIT_TRAIL`,
	)).Scan(&wm)
	if wm == "" {
		wm = time.Now().UTC().Format("2006-01-02 15:04:05.000000")
	}
	log.Printf("audit-forward(oracle): polling UNIFIED_AUDIT_TRAIL every %ds (watermark %s, lookback %ds)", pollSec, wm, lookback)

	for {
		rows, err := db.Query(tagAgentQuery(query), sql.Named("wm", wm), sql.Named("lb", lookback))
		if err != nil {
			log.Printf("audit-forward(oracle): read UNIFIED_AUDIT_TRAIL: %v — is unified auditing on, an audit policy enabled, and does DB_USER have AUDIT_VIEWER? retrying", err)
			time.Sleep(time.Duration(pollSec) * time.Second)
			continue
		}
		cur := map[string]bool{}
		for rows.Next() {
			var etStr, principal, objSchema, objName, userHost, action, statement, clientProg string
			var returnCode, rowsProcessed, executions, sessionID, entryID int64
			if err := rows.Scan(&etStr, &principal, &objSchema, &objName, &userHost, &action,
				&returnCode, &statement, &rowsProcessed, &executions, &sessionID, &entryID, &clientProg); err != nil {
				continue
			}
			// De-dupe key: a record is uniquely (event_timestamp, session, entry). Within the
			// re-scanned window the same record reappears every poll; forward it only once.
			fp := fmt.Sprintf("%s|%d|%d", etStr, sessionID, entryID)
			cur[fp] = true
			// Advance the watermark to the max event_timestamp seen. The lookback below rewinds
			// the actual query start, so this only needs to track how far the window has moved.
			if etStr > wm {
				wm = etStr
			}
			if first || seen[fp] { // seed on first poll (don't replay history); skip already-sent
				continue
			}
			// The audit trail NUL-terminates SQL_TEXT (a C-string artifact); strip the NUL and any
			// surrounding whitespace so the stored statement is clean and de-dupe/match is stable.
			s := strings.TrimRight(statement, "\x00")
			s = strings.TrimSpace(s)
			// Internal users/schemas are already excluded in SQL; this drops the remaining
			// data-dictionary chatter and the agent's own catalog reads by text.
			if s == "" || !shouldForward(s) || isOracleSystemStmt(s) {
				continue
			}
			// Per-execution row count. Exact when EXECUTIONS<=1 (ad-hoc statement); an average
			// for parameterised statements whose stats accumulate across runs.
			rc := int(rowsProcessed)
			if executions > 1 {
				rc = int(rowsProcessed / executions)
			}
			// A failed statement (RETURN_CODE<>0, e.g. ORA-00942 table-not-found probing) carries
			// no meaningful row count; surface it but zero the count so it can't trip volume rules.
			if returnCode != 0 {
				rc = 0
			}
			forwardEventOp(cfg, orDefault(principal, "unknown"), userHost, s, oracleOp(action, s), clientProg, rc, false)
		}
		rows.Close()
		// The window's fingerprints become the new seen-set: anything still inside the lookback
		// window is retained (so it isn't re-sent next poll), anything that aged out is dropped
		// (bounding the set). Keep the old set on an empty poll so a transient gap can't clear it.
		if len(cur) > 0 {
			seen = cur
		}
		first = false
		time.Sleep(time.Duration(pollSec) * time.Second)
	}
}

// oracleOp maps the audit ACTION_NAME to the canonical operation. ACTION_NAME is authoritative
// (it is what Oracle recorded), so prefer it and fall back to sniffing the text only when blank.
func oracleOp(action, sqlText string) string {
	switch strings.ToUpper(strings.TrimSpace(action)) {
	case "SELECT":
		return "SELECT"
	case "INSERT":
		return "INSERT"
	case "UPDATE":
		return "UPDATE"
	case "DELETE":
		return "DELETE"
	case "LOGON":
		return "LOGIN"
	case "LOGOFF":
		return "LOGOUT"
	case "GRANT", "REVOKE":
		return "GRANT"
	case "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "TRUNCATE TABLE":
		return "DDL"
	}
	return detectOp(sqlText)
}

// isOracleSystemStmt filters Oracle's own recursive/data-dictionary chatter and the agent's
// own catalog reads, the same way isMssqlSystemStmt does for SQL Server. Recursive SQL against
// SYS objects is not user intent and would otherwise flood the trail.
func isOracleSystemStmt(sqlText string) bool {
	u := strings.ToLower(strings.TrimSpace(sqlText))
	// The XS_SYS_CONTEXT / DECODE(USER,'XS$NULL',...) probe fires on every session establish; it
	// is Oracle internal, carries no user intent, and appears on virtually every connection.
	if strings.Contains(u, "xs_sys_context") || strings.Contains(u, "opt_dyn_samp") {
		return true
	}
	for _, p := range []string{
		"unified_audit_trail", "v$sqlstats", "v$sql", "dbms_lob.substr",
		"all_tab_columns", "sys.", "dba_", "gv$", "x$",
		// AWR / SQL-tuning-set internal tables. On OCI Autonomous DB the automatic tuning task
		// hammers these constantly — measured at ~87% of all captured events on an idle ADB —
		// so without this the real user activity is buried. wri$/wrh$/wrr$ = the AWR families.
		"wri$_", "wrh$_", "wrr$_", "dbms_stats", "dbms_space", "aw$", "sqlobj$",
	} {
		if strings.Contains(u, p) {
			return true
		}
	}
	return false
}

// oracleInternalSchemas are the accounts/schemas Oracle maintains itself — their activity is
// dictionary/AWR housekeeping, never customer intent. Filtering on the audit record's own
// principal + object owner (not just text) is what actually silences OCI Autonomous DB's
// automatic tuning, which runs as SYS against SYS-owned objects. Mirrors how cloudSqlNoise
// drops the cloudsql* maintenance users on the managed-MySQL path.
var oracleInternalSchemas = map[string]bool{
	"SYS": true, "SYSTEM": true, "AUDSYS": true, "WMSYS": true, "DBSNMP": true,
	"XDB": true, "CTXSYS": true, "MDSYS": true, "DVSYS": true, "DVF": true, "LBACSYS": true,
	"OLAPSYS": true, "ORDSYS": true, "ORDDATA": true, "GSMADMIN_INTERNAL": true, "APPQOSSYS": true,
	"DBSFWUSER": true, "OUTLN": true, "SYS$UMF": true, "REMOTE_SCHEDULER_AGENT": true,
	"ORACLE_OCM": true, "GGSYS": true, "DGPDB_INT": true, "SYSRAC": true, "SYSKM": true,
	"SYSBACKUP": true, "SYSDG": true, "C##CLOUD$SERVICE": true,
}

// (The principal/schema exclusion is applied IN THE QUERY — see the NOT IN clause built from
// oracleInternalSchemas — so there is no Go-side actor filter; doing it in SQL avoids reading
// the huge internal volume over the wire every poll.)
