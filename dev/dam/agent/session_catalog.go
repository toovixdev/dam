package main

// ── Session-catalog principal enrichment ─────────────────────────────────────
//
// Wire-capture modes (network/host/proxy) learn the DB user from the LOGIN handshake, which is
// only observable as the FIRST packet on a connection. A pre-existing connection pool (opened
// before the agent started, or surviving an agent restart) never shows the agent a handshake, so
// its queries are attributed to "unknown" — and the pool is long-lived, so that's the bulk of the
// traffic and it cannot self-heal without restarting the app.
//
// The fix is server-side and needs no handshake, no TLS visibility, and no app restart: every
// engine exposes a live SESSION CATALOG that lists each current session's authenticated user AND
// its client network endpoint (ip:port). We poll it with the agent's read-only monitoring login
// and join wire connections (keyed by the client's ip:port, exactly what the sniffer sees) to the
// real user. One interface, one poller, one cache; per-engine query strategies below.
//
// Scope: this enriches the three WIRE-protocol engines (mysql, postgresql, mssql). Oracle and
// MongoDB have no wire decoder in this agent — they capture via their audit/profiler forwarders
// (unified_audit_trail / db.currentOp+profiler), which already carry the principal server-side —
// so newSessionCatalog returns nil for them (their catalogs, V$SESSION / $currentOp, would slot in
// here unchanged if wire capture is ever added).

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

// catSession is one live server session: which user is behind a client endpoint.
type catSession struct {
	ip   string
	port string
	user string
}

// SessionCatalog enumerates the current server sessions for one engine.
type SessionCatalog interface {
	snapshot(ctx context.Context) ([]catSession, error)
	name() string
}

// sessionCache maps a client endpoint → DB user. Written by the poller goroutine, read by the
// capture goroutine(s), so guarded by an RWMutex; replaced wholesale each poll.
type sessionCache struct {
	mu    sync.RWMutex
	byKey map[string]string // "ip:port" -> user (exact match)
	byIP  map[string]string // "ip" -> user (fallback; only when that ip has ONE distinct user)
}

func newSessionCache() *sessionCache {
	return &sessionCache{byKey: map[string]string{}, byIP: map[string]string{}}
}

func (c *sessionCache) replace(sessions []catSession) {
	byKey := make(map[string]string, len(sessions))
	ipUsers := map[string]map[string]struct{}{}
	for _, s := range sessions {
		if s.user == "" || s.ip == "" {
			continue
		}
		if s.port != "" {
			byKey[s.ip+":"+s.port] = s.user
		}
		if ipUsers[s.ip] == nil {
			ipUsers[s.ip] = map[string]struct{}{}
		}
		ipUsers[s.ip][s.user] = struct{}{}
	}
	// ip-only fallback is safe only when a single user is seen from that client ip (the common
	// app-host case). If a host runs services as different DB users, we require the exact port.
	byIP := make(map[string]string, len(ipUsers))
	for ip, users := range ipUsers {
		if len(users) == 1 {
			for u := range users {
				byIP[ip] = u
			}
		}
	}
	c.mu.Lock()
	c.byKey, c.byIP = byKey, byIP
	c.mu.Unlock()
}

// lookup resolves a user: exact ip:port first, then an unambiguous ip-only match.
func (c *sessionCache) lookup(ipPort, ip string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if ipPort != "" {
		if u := c.byKey[ipPort]; u != "" {
			return u
		}
	}
	if ip != "" {
		return c.byIP[ip]
	}
	return ""
}

// Package-level cache the capture path reads; nil until a poller starts (enrichment off).
var sessCache *sessionCache

// enrichPrincipal backfills st.principal from the session catalog when the login handshake was
// never observed (pooled/pre-existing connection). No-op once a real user is known, or when the
// connection has no client endpoint to join on (host/eBPF mode reads below TCP).
func enrichPrincipal(st *connState) {
	if sessCache == nil || st.gotUser {
		return
	}
	if st.principal != "" && st.principal != "unknown" {
		return
	}
	if st.clientKey == "" && st.clientIPOnly == "" {
		return
	}
	if u := sessCache.lookup(st.clientKey, st.clientIPOnly); u != "" {
		st.principal = u
		st.gotUser = true // learned — stop re-looking (a later handshake would only re-confirm)
	}
}

// maybeStartSessionPoller starts enrichment when the mode is wire-capture, a monitoring DB login
// is configured, and the engine has a catalog. Returns quietly otherwise.
func maybeStartSessionPoller(cfg Config) {
	if cfg.Mode != "network" && cfg.Mode != "host" && cfg.Mode != "proxy" {
		return
	}
	if cfg.DBUser == "" {
		return
	}
	cat := newSessionCatalog(cfg)
	if cat == nil {
		return
	}
	every := time.Duration(atoiDefault(env("SESSION_POLL_SECS", "5"), 5)) * time.Second
	if every < time.Second {
		every = 5 * time.Second
	}
	go runSessionPoller(cfg, cat, every)
}

func runSessionPoller(cfg Config, cat SessionCatalog, every time.Duration) {
	sessCache = newSessionCache()
	log.Printf("session-principal enrichment ON (%s, every %s) — attributes pooled/pre-existing connections without an app restart", cat.name(), every)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		sessions, err := cat.snapshot(ctx)
		cancel()
		if err != nil {
			log.Printf("[session-catalog] %s snapshot failed: %v", cat.name(), err)
		} else {
			sessCache.replace(sessions)
		}
		time.Sleep(every)
	}
}

// newSessionCatalog returns the per-engine catalog, or nil when the engine has no wire-capture
// path that needs enrichment (oracle/mongo carry the principal via their forwarders).
func newSessionCatalog(cfg Config) SessionCatalog {
	switch cfg.Engine {
	case "mysql":
		return &mysqlCatalog{cfg: cfg}
	case "postgresql":
		return &pgCatalog{cfg: cfg}
	case "mssql":
		return &mssqlCatalog{cfg: cfg}
	}
	return nil
}

// splitHostPort splits "ip:port" on the LAST colon (IPv4-safe); a bare host degrades to ip-only.
func splitHostPort(h string) (ip, port string) {
	h = strings.TrimSpace(h)
	if i := strings.LastIndex(h, ":"); i > 0 {
		return h[:i], h[i+1:]
	}
	return h, ""
}

// ── MySQL: information_schema.PROCESSLIST (privilege: PROCESS) ────────────────
type mysqlCatalog struct {
	cfg Config
	db  *sql.DB
}

func (m *mysqlCatalog) name() string { return "mysql/processlist" }

func (m *mysqlCatalog) snapshot(ctx context.Context) ([]catSession, error) {
	if m.db == nil {
		dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/information_schema?timeout=8s&readTimeout=8s&allowNativePasswords=true",
			m.cfg.DBUser, m.cfg.DBPass, m.cfg.TargetHost, m.cfg.TargetPort)
		db, err := sql.Open("mysql", dsn)
		if err != nil {
			return nil, err
		}
		db.SetMaxOpenConns(1)
		db.SetConnMaxLifetime(30 * time.Minute)
		m.db = db
	}
	// HOST is "ip:port" for TCP sessions (the join key), "localhost" for the unix socket.
	rows, err := m.db.QueryContext(ctx, `SELECT USER, HOST FROM information_schema.PROCESSLIST WHERE HOST <> '' AND USER IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []catSession
	for rows.Next() {
		var user, host string
		if err := rows.Scan(&user, &host); err != nil {
			continue
		}
		ip, port := splitHostPort(host)
		if ip == "" || strings.EqualFold(ip, "localhost") {
			continue // socket session — no wire connection to attribute
		}
		out = append(out, catSession{ip: ip, port: port, user: user})
	}
	return out, rows.Err()
}

// ── PostgreSQL: pg_stat_activity (privilege: pg_read_all_stats / pg_monitor) ──
type pgCatalog struct {
	cfg Config
	db  *sql.DB
}

func (p *pgCatalog) name() string { return "postgresql/pg_stat_activity" }

func (p *pgCatalog) snapshot(ctx context.Context) ([]catSession, error) {
	if p.db == nil {
		boot := strings.TrimSpace(p.cfg.DBName)
		if boot == "" || strings.Contains(boot, ",") {
			boot = "postgres" // pg_stat_activity is cluster-wide from any database
		}
		db, err := sql.Open("postgres", pgDSN(p.cfg, boot))
		if err != nil {
			return nil, err
		}
		db.SetMaxOpenConns(1)
		db.SetConnMaxLifetime(30 * time.Minute)
		p.db = db
	}
	// client_addr/client_port are visible for OTHER users' rows only with pg_read_all_stats.
	rows, err := p.db.QueryContext(ctx,
		`SELECT usename, host(client_addr), client_port
		   FROM pg_stat_activity
		  WHERE client_addr IS NOT NULL AND usename IS NOT NULL AND pid <> pg_backend_pid()`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []catSession
	for rows.Next() {
		var user, ip string
		var port sql.NullInt64
		if err := rows.Scan(&user, &ip, &port); err != nil {
			continue
		}
		ps := ""
		if port.Valid && port.Int64 > 0 {
			ps = fmt.Sprintf("%d", port.Int64)
		}
		out = append(out, catSession{ip: ip, port: ps, user: user})
	}
	return out, rows.Err()
}

// ── SQL Server: sys.dm_exec_connections ⋈ sys.dm_exec_sessions (VIEW SERVER STATE) ──
type mssqlCatalog struct {
	cfg Config
	db  *sql.DB
}

func (s *mssqlCatalog) name() string { return "mssql/dm_exec_sessions" }

func (s *mssqlCatalog) snapshot(ctx context.Context) ([]catSession, error) {
	if s.db == nil {
		boot := strings.TrimSpace(s.cfg.DBName)
		if boot == "" || strings.Contains(boot, ",") {
			boot = "master"
		}
		db, err := sql.Open("sqlserver", mssqlDSN(s.cfg, boot))
		if err != nil {
			return nil, err
		}
		db.SetMaxOpenConns(1)
		db.SetConnMaxLifetime(30 * time.Minute)
		s.db = db
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT se.login_name, c.client_net_address, c.client_tcp_port
		   FROM sys.dm_exec_connections c
		   JOIN sys.dm_exec_sessions se ON se.session_id = c.session_id
		  WHERE c.client_net_address IS NOT NULL AND se.login_name IS NOT NULL
		    AND c.session_id <> @@SPID`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []catSession
	for rows.Next() {
		var user, ip string
		var port sql.NullInt64
		if err := rows.Scan(&user, &ip, &port); err != nil {
			continue
		}
		ps := ""
		if port.Valid && port.Int64 > 0 {
			ps = fmt.Sprintf("%d", port.Int64)
		}
		out = append(out, catSession{ip: ip, port: ps, user: user})
	}
	return out, rows.Err()
}
