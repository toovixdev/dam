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
	"strconv"
	"strings"
	"sync"
	"time"
)

// catSession is one live server session: which user is behind a client endpoint and/or
// connection id. (Audit-forward joins by connID — MySQL's PROCESSLIST.ID == the general log's
// connection id — which is exact; wire modes join by ip:port.)
type catSession struct {
	ip     string
	port   string
	user   string
	connID string
}

// SessionCatalog enumerates the current server sessions for one engine.
type SessionCatalog interface {
	snapshot(ctx context.Context) ([]catSession, error)
	name() string
}

// sessionCache maps a client endpoint → DB user. Written by the poller goroutine, read by the
// capture goroutine(s), so guarded by an RWMutex; replaced wholesale each poll.
type sessionCache struct {
	mu       sync.RWMutex
	byKey    map[string]string // "ip:port" -> user (exact, wire modes)
	byIP     map[string]string // "ip" -> user (fallback; only when that ip has ONE distinct user)
	byConnID map[string]string // connection id -> user (exact, audit-forward)
}

func newSessionCache() *sessionCache {
	return &sessionCache{byKey: map[string]string{}, byIP: map[string]string{}, byConnID: map[string]string{}}
}

func (c *sessionCache) replace(sessions []catSession) {
	byKey := map[string]string{}
	byConnID := map[string]string{}
	ipUsers := map[string]map[string]struct{}{}
	for _, s := range sessions {
		if s.user == "" {
			continue
		}
		if s.connID != "" {
			byConnID[s.connID] = s.user
		}
		if s.ip == "" {
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
	byIP := map[string]string{}
	for ip, users := range ipUsers {
		if len(users) == 1 {
			for u := range users {
				byIP[ip] = u
			}
		}
	}
	c.mu.Lock()
	c.byKey, c.byIP, c.byConnID = byKey, byIP, byConnID
	c.mu.Unlock()
}

func (c *sessionCache) lookupConnID(id string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.byConnID[id]
}

// lookup resolves a user: exact ip:port first, then — only if the ip-only fallback is enabled —
// an unambiguous ip-only match. The ip-only path is a GUESS (a client host with a single user at
// poll time), so it is OFF by default: for an audit trail we prefer "unknown" over a wrong user.
func (c *sessionCache) lookup(ipPort, ip string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if ipPort != "" {
		if u := c.byKey[ipPort]; u != "" {
			return u
		}
	}
	if sessIPFallback && ip != "" {
		return c.byIP[ip]
	}
	return ""
}

// Package-level cache the capture path reads; nil until a poller starts (enrichment off).
var sessCache *sessionCache

// sessIPFallback enables the ip-only enrichment fallback (SESSION_ENRICH_IP_FALLBACK=true).
// Default false — exact ip:port only, so enrichment is "correct or unknown, never wrong".
var sessIPFallback bool

// sessionUserByConnID resolves a DB user from the session-catalog poll by connection id — used by
// the MySQL audit-forward path, whose general-log connection id matches PROCESSLIST.ID exactly.
// Returns "" when enrichment is off or the id isn't currently live. Nil-safe.
func sessionUserByConnID(id string) string {
	if sessCache == nil || id == "" {
		return ""
	}
	return sessCache.lookupConnID(id)
}

// enrichPrincipal backfills st.principal from the session catalog when the login handshake was
// never observed (pooled/pre-existing connection). Safety-critical for an audit trail:
//   - A principal set from the WIRE (handshake/startup) is authoritative and is NEVER overridden.
//   - We do NOT pin the result on the connState (no gotUser): the value is RE-RESOLVED from the
//     fresh (≤poll-interval) cache on every emit, so if this ip:port is reused by a different
//     session the attribution self-corrects, and a real handshake still wins if one arrives.
//   - If a previously-enriched session is no longer live in the catalog, we revert to "unknown"
//     rather than keep asserting a user we can no longer confirm.
// No-op when the connection has no client endpoint to join on (host/eBPF reads below TCP).
func enrichPrincipal(st *connState) {
	if sessCache == nil {
		return
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	// Authoritative wire principal (handshake/startup) → never touch. Enriched values carry the
	// `enriched` flag so they remain re-resolvable here.
	if st.principal != "" && st.principal != "unknown" && !st.enriched {
		return
	}
	if st.clientKey == "" && st.clientIPOnly == "" {
		return
	}
	if u := sessCache.lookup(st.clientKey, st.clientIPOnly); u != "" {
		st.principal = u
		st.enriched = true
	} else if st.enriched {
		st.principal = "unknown" // session gone / port reused in flight — stop asserting it
		st.enriched = false
	}
}

// maybeStartSessionPoller starts enrichment when the mode is wire-capture, a monitoring DB login
// is configured, and the engine has a catalog. Returns quietly otherwise.
func maybeStartSessionPoller(cfg Config) {
	// Wire modes join by ip:port; MySQL audit-forward joins by connection id (PROCESSLIST.ID ==
	// the general log's connection id) to attribute pre-existing pooled connections whose Connect
	// line predates the tail. Other engines' audit-forward paths carry the principal natively.
	wire := cfg.Mode == "network" || cfg.Mode == "host" || cfg.Mode == "proxy"
	auditMySQL := cfg.Mode == "audit-forward" && cfg.Engine == "mysql"
	if !wire && !auditMySQL {
		return
	}
	if cfg.DBUser == "" {
		return
	}
	cat := newSessionCatalog(cfg)
	if cat == nil {
		return
	}
	sessIPFallback = env("SESSION_ENRICH_IP_FALLBACK", "false") == "true"
	every := time.Duration(atoiDefault(env("SESSION_POLL_SECS", "5"), 5)) * time.Second
	if every < time.Second {
		every = 5 * time.Second
	}
	go runSessionPoller(cfg, cat, every)
}

func runSessionPoller(cfg Config, cat SessionCatalog, every time.Duration) {
	sessCache = newSessionCache()
	match := "exact ip:port only"
	if sessIPFallback {
		match = "ip:port + ip-only fallback"
	}
	log.Printf("session-principal enrichment ON (%s, every %s, %s) — attributes pooled/pre-existing connections without an app restart", cat.name(), every, match)
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

// normalizeCatalogIP maps a resolved loopback hostname back to the numeric address the wire
// sniffer sees. MySQL with skip_name_resolve=OFF reports a loopback TCP client as "localhost",
// which would never equal the packet's "127.0.0.1". (For non-loopback remote clients resolved to
// a hostname, set skip_name_resolve=ON so HOST is the IP — otherwise the join can't match.)
func normalizeCatalogIP(ip string) string {
	switch strings.ToLower(ip) {
	case "localhost", "localhost.localdomain":
		return "127.0.0.1"
	case "ip6-localhost", "ip6-loopback":
		return "::1"
	}
	return ip
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
	// ID = connection id (audit-forward join). HOST = "ip:port" for TCP (wire join), "localhost"
	// for the unix socket. We keep EVERY row for the connID map; ip:port is added only for TCP.
	rows, err := m.db.QueryContext(ctx, `SELECT ID, USER, HOST FROM information_schema.PROCESSLIST WHERE USER IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []catSession
	for rows.Next() {
		var id sql.NullInt64
		var user, host string
		if err := rows.Scan(&id, &user, &host); err != nil {
			continue
		}
		cs := catSession{user: user}
		if id.Valid {
			cs.connID = strconv.FormatInt(id.Int64, 10)
		}
		if ip, port := splitHostPort(host); port != "" {
			cs.ip, cs.port = normalizeCatalogIP(ip), port
		}
		out = append(out, cs)
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
