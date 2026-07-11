// TooVix DAM Agent — single binary, MODE-selectable capture.
//
// One image, three installable modes (network | host | proxy). This build implements the
// inline PROXY for MySQL end-to-end (a real TCP proxy clients connect through; it decodes
// the MySQL wire protocol, captures queries, and forwards events to the DAM data plane).
// network/host modes enroll + heartbeat but their capture is not implemented in this build.
//
// Pure standard library — no external deps, so the container image builds trivially.
package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type Config struct {
	Mode         string // network | host | proxy
	Engine       string // mysql | postgresql | mongodb | ...
	TargetHost   string // instance host the agent monitors
	TargetPort   string // instance port
	TargetDB     string // display name used as database_name on events
	ListenPort   string // proxy: port the agent listens on
	Upstream     string // proxy: host:port of the real DB
	EnrollToken  string
	ControlPlane string // http://dam-api:3000
	ClickHouse    string // http://dam-clickhouse:8123
	CHUser        string
	CHPassword    string
	AgentHost     string
	Version       string
	TenantID      string   // resolved from the enroll response; tags captured events
	BlockPatterns []string // case-insensitive substrings; a matching query is blocked
	// Classification (schema scan) — orthogonal to capture: the agent logs into the DB
	// as a least-privilege reader and classifies columns by name (PII/PCI).
	Classify     bool
	DBUser       string
	DBPass       string
	ClassifyMins int
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func loadConfig() Config {
	c := Config{
		Mode:         env("MODE", "proxy"),
		Engine:       env("DB_ENGINE", "mysql"),
		TargetHost:   env("TARGET_HOST", "client-mysql"),
		TargetPort:   env("TARGET_PORT", "3306"),
		TargetDB:     env("TARGET_DB", ""),
		ListenPort:   env("LISTEN_PORT", "3306"),
		Upstream:     env("UPSTREAM", "client-mysql:3306"),
		EnrollToken:  env("AGENT_ENROLL_TOKEN", "dev-agent-enroll-token"),
		ControlPlane: strings.TrimRight(env("CONTROL_PLANE", "http://dam-api:3000"), "/"),
		ClickHouse:   strings.TrimRight(env("CLICKHOUSE_URL", "http://dam-clickhouse:8123"), "/"),
		CHUser:       env("CLICKHOUSE_USER", "dam_writer"),
		CHPassword:   env("CLICKHOUSE_PASSWORD", "dam_click_secret"),
		// Stable identity across restarts (env(...) used directly, not the container hostname),
		// so re-enrollment reuses the same agent row instead of creating duplicates.
		AgentHost: "dam-agent-" + env("MODE", "proxy") + "-" + env("TARGET_HOST", "client-mysql") + "-" + env("TARGET_PORT", "3306"),
		Version:   "0.1.0",
		Classify:  env("CLASSIFY", "false") == "true",
		DBUser:    env("DB_USER", ""),
		DBPass:    env("DB_PASSWORD", ""),
		ClassifyMins: atoiDefault(env("CLASSIFY_INTERVAL_MIN", "30"), 30),
	}
	if c.TargetDB == "" {
		c.TargetDB = c.TargetHost + ":" + c.TargetPort
	}
	for _, p := range strings.Split(env("BLOCK_PATTERNS", "DROP TABLE,DROP DATABASE,TRUNCATE,GRANT ALL"), ",") {
		if p = strings.TrimSpace(p); p != "" {
			c.BlockPatterns = append(c.BlockPatterns, strings.ToUpper(p))
		}
	}
	return c
}

var agentTypeByMode = map[string]string{"network": "network", "host": "host_ebpf", "proxy": "inline_proxy"}

func main() {
	cfg := loadConfig()
	log.SetFlags(log.Ltime)
	log.Printf("=== TooVix DAM Agent v%s · mode=%s engine=%s target=%s:%s ===", cfg.Version, cfg.Mode, cfg.Engine, cfg.TargetHost, cfg.TargetPort)

	agentID, tenantID := enrollWithRetry(cfg)
	cfg.TenantID = tenantID
	go heartbeatLoop(cfg, agentID)

	// Classification runs alongside ANY capture mode (it just needs a DB read login).
	if cfg.Classify && cfg.DBUser != "" && cfg.Engine == "mysql" {
		go classifyLoop(cfg)
	} else if cfg.Classify {
		log.Printf("classification enabled but skipped (need DB_USER and engine=mysql in this build)")
	}

	switch cfg.Mode {
	case "proxy":
		runProxy(cfg)
	case "network":
		runNetwork(cfg)
	default:
		log.Printf("mode %q: capture not implemented in this build — enrolled + heartbeating only", cfg.Mode)
		select {}
	}
}

// ── Network agent (passive libpcap-style capture via AF_PACKET) ──────
// Shares the DB container's network namespace and sniffs its interface, decoding the MySQL
// wire protocol on the client→server direction. Passive — observes, never blocks.
func runNetwork(cfg Config) {
	iface := env("CAPTURE_IFACE", "eth0")
	ifi, err := net.InterfaceByName(iface)
	if err != nil {
		log.Fatalf("interface %s not found: %v", iface, err)
	}
	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, int(htons(0x0003))) // ETH_P_ALL
	if err != nil {
		log.Fatalf("AF_PACKET socket failed: %v (needs CAP_NET_RAW / root)", err)
	}
	defer syscall.Close(fd)
	if err := syscall.Bind(fd, &syscall.SockaddrLinklayer{Protocol: htons(0x0003), Ifindex: ifi.Index}); err != nil {
		log.Fatalf("bind to %s failed: %v", iface, err)
	}
	targetPort := uint16(atoiDefault(cfg.TargetPort, 3306))
	log.Printf("network agent sniffing %s for tcp/%d (passive capture)", iface, targetPort)

	conns := map[string]*connState{}
	frame := make([]byte, 65536)
	for {
		n, _, err := syscall.Recvfrom(fd, frame, 0)
		if err != nil || n < 14 {
			continue
		}
		handleFrame(cfg, frame[:n], targetPort, conns)
	}
}

// handleFrame parses Ethernet/IPv4/TCP and feeds client→server payload to the MySQL decoder.
func handleFrame(cfg Config, f []byte, targetPort uint16, conns map[string]*connState) {
	if len(f) < 14 || (uint16(f[12])<<8|uint16(f[13])) != 0x0800 { // IPv4 only
		return
	}
	ip := f[14:]
	if len(ip) < 20 || ip[9] != 6 { // TCP only
		return
	}
	ihl := int(ip[0]&0x0f) * 4
	if len(ip) < ihl+20 {
		return
	}
	srcIP := net.IP(ip[12:16]).String()
	tcp := ip[ihl:]
	srcPort := uint16(tcp[0])<<8 | uint16(tcp[1])
	dstPort := uint16(tcp[2])<<8 | uint16(tcp[3])
	if dstPort != targetPort { // only client→server
		return
	}
	dataOff := int(tcp[12]>>4) * 4
	if len(tcp) < dataOff {
		return
	}
	payload := tcp[dataOff:]
	if len(payload) == 0 {
		return
	}
	key := fmt.Sprintf("%s:%d", srcIP, srcPort)
	st := conns[key]
	if st == nil {
		st = &connState{principal: "unknown"}
		conns[key] = st
	}
	st.buf = frameAndDecode(st, append(st.buf, payload...), func(sql string) {
		forwardEvent(cfg, st.principal, srcIP, sql)
	})
}

// frameAndDecode frames complete MySQL client→server packets, decoding the login username
// (handshake response, seq 1) and COM_QUERY SQL. Returns unconsumed remainder. Capture-only.
func frameAndDecode(st *connState, buf []byte, onQuery func(sql string)) []byte {
	for len(buf) >= 4 {
		plen := int(buf[0]) | int(buf[1])<<8 | int(buf[2])<<16
		if plen == 0 || len(buf) < 4+plen {
			break
		}
		seq := buf[3]
		payload := buf[4 : 4+plen]
		if seq == 1 && !st.gotUser {
			st.gotUser = true
			if len(payload) >= 4 {
				caps := uint32(payload[0]) | uint32(payload[1])<<8 | uint32(payload[2])<<16 | uint32(payload[3])<<24
				st.queryAttrs = caps&0x08000000 != 0
			}
			if len(payload) > 33 {
				if end := bytes.IndexByte(payload[32:], 0); end > 0 {
					st.principal = string(payload[32 : 32+end])
				}
			}
		} else if len(payload) > 0 && payload[0] == 0x03 {
			q := payload[1:]
			if st.queryAttrs {
				q = skipQueryAttrs(q)
			}
			onQuery(strings.TrimSpace(string(q)))
		}
		buf = buf[4+plen:]
	}
	return buf
}

func htons(i uint16) uint16 { return (i<<8)&0xff00 | i>>8 }

func atoiDefault(s string, d int) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return d
		}
		n = n*10 + int(c-'0')
	}
	if s == "" {
		return d
	}
	return n
}

// ── Enrollment + heartbeat ───────────────────────────────────────────
func enrollWithRetry(cfg Config) (string, string) {
	body, _ := json.Marshal(map[string]interface{}{
		"token":      cfg.EnrollToken,
		"host":       cfg.TargetHost,
		"port":       atoiOrNil(cfg.TargetPort),
		"engine":     cfg.Engine,
		"agent_type": agentTypeByMode[cfg.Mode],
		"agent_host": cfg.AgentHost,
		"version":    cfg.Version,
	})
	for {
		resp, err := http.Post(cfg.ControlPlane+"/api/agents/enroll", "application/json", bytes.NewReader(body))
		if err == nil && resp.StatusCode == 200 {
			var out struct {
				AgentID    string `json:"agent_id"`
				InstanceID string `json:"instance_id"`
				TenantID   string `json:"tenant_id"`
			}
			json.NewDecoder(resp.Body).Decode(&out)
			resp.Body.Close()
			log.Printf("enrolled: agent=%s instance=%s tenant=%s", out.AgentID, out.InstanceID, out.TenantID)
			return out.AgentID, out.TenantID
		}
		if resp != nil {
			resp.Body.Close()
		}
		log.Printf("enroll failed (%v) — retrying in 5s", err)
		time.Sleep(5 * time.Second)
	}
}

func heartbeatLoop(cfg Config, agentID string) {
	for {
		time.Sleep(15 * time.Second)
		resp, err := http.Post(cfg.ControlPlane+"/api/agents/"+agentID+"/heartbeat", "application/json", nil)
		if err != nil {
			log.Printf("heartbeat error: %v", err)
			continue
		}
		resp.Body.Close()
	}
}

// ── Classification (schema scan) ─────────────────────────────────────
// Connects to the DB as a least-privilege reader, reads information_schema, classifies
// columns by NAME (PII/PCI), and reports to the control plane. Independent of capture mode.
type nameClassifier struct {
	re   *regexp.Regexp
	tag  string
	sens string
}

var nameClassifiers = []nameClassifier{
	{regexp.MustCompile(`(?i)aadhaar|aadhar`), "aadhaar", "critical"},
	{regexp.MustCompile(`(?i)ssn|social_security|(^|_)sin(_|$)`), "ssn", "critical"},
	{regexp.MustCompile(`(?i)card_number|card_no|ccnum|creditcard|card_num|pan_number`), "pci", "critical"},
	{regexp.MustCompile(`(?i)cvv|cvc|card_sec`), "pci", "critical"},
	{regexp.MustCompile(`(?i)card_expiry|exp_date|(^|_)expiry`), "pci", "high"},
	{regexp.MustCompile(`(?i)card_last4|last4`), "pci", "medium"},
	{regexp.MustCompile(`(?i)(^|_)email`), "email", "high"},
	{regexp.MustCompile(`(?i)first_name|last_name|full_name|fullname|cardholder|customer_name|contact_name`), "name", "high"},
	{regexp.MustCompile(`(?i)(^|_)dob(_|$)|date_of_birth|birth_date`), "dob", "high"},
	{regexp.MustCompile(`(?i)passport|tax_id|taxid|(^|_)tin(_|$)|(^|_)pan(_|$)`), "gov_id", "high"},
	{regexp.MustCompile(`(?i)(^|_)phone|mobile_no|contact_no`), "phone", "medium"},
	{regexp.MustCompile(`(?i)(^|_)address|postal_code|pincode|zip_code`), "address", "medium"},
}

func classifyCol(name string) (tag, sens string, ok bool) {
	for _, c := range nameClassifiers {
		if c.re.MatchString(name) {
			return c.tag, c.sens, true
		}
	}
	return "", "", false
}

var sensRank = map[string]int{"low": 0, "medium": 1, "high": 2, "critical": 3}

func classifyLoop(cfg Config) {
	every := time.Duration(cfg.ClassifyMins) * time.Minute
	if every < time.Minute {
		every = 30 * time.Minute
	}
	// Small initial delay so enrollment settles first.
	time.Sleep(10 * time.Second)
	for {
		if err := runClassificationScan(cfg); err != nil {
			log.Printf("classification scan failed: %v", err)
		}
		time.Sleep(every)
	}
}

func runClassificationScan(cfg Config) error {
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/information_schema?timeout=8s&readTimeout=20s&allowNativePasswords=true", cfg.DBUser, cfg.DBPass, cfg.TargetHost, cfg.TargetPort)
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetConnMaxLifetime(30 * time.Second)

	rows, err := db.Query(`SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
		WHERE table_schema NOT IN ('mysql','sys','information_schema','performance_schema')
		ORDER BY table_schema, table_name, ordinal_position`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type objAgg struct {
		schema, table string
		total         int
		cols          []map[string]interface{}
	}
	objs := map[string]*objAgg{}
	var objOrder []string
	for rows.Next() {
		var sch, tbl, col, dt string
		if err := rows.Scan(&sch, &tbl, &col, &dt); err != nil {
			continue
		}
		key := sch + "\x00" + tbl
		o := objs[key]
		if o == nil {
			o = &objAgg{schema: sch, table: tbl}
			objs[key] = o
			objOrder = append(objOrder, key)
		}
		o.total++
		if tag, sens, ok := classifyCol(col); ok {
			o.cols = append(o.cols, map[string]interface{}{
				"column_name": col, "data_type": dt, "tags": []string{tag},
				"sensitivity": sens, "detection_method": "pattern", "confidence": 0.85, "is_masked": false,
			})
		}
	}

	// Group sensitive objects by schema (= database in MySQL).
	dbs := map[string]map[string]interface{}{}
	var dbOrder []string
	for _, key := range objOrder {
		o := objs[key]
		if len(o.cols) == 0 {
			continue // only report objects with at least one sensitive column
		}
		best := "low"
		for _, c := range o.cols {
			if sensRank[c["sensitivity"].(string)] > sensRank[best] {
				best = c["sensitivity"].(string)
			}
		}
		d := dbs[o.schema]
		if d == nil {
			d = map[string]interface{}{"name": o.schema, "objects": []interface{}{}}
			dbs[o.schema] = d
			dbOrder = append(dbOrder, o.schema)
		}
		d["objects"] = append(d["objects"].([]interface{}), map[string]interface{}{
			"schema_name": o.schema, "object_name": o.table, "object_type": "table",
			"column_count": o.total, "sensitivity": best, "columns": o.cols,
		})
	}

	databases := []interface{}{}
	for _, s := range dbOrder {
		databases = append(databases, dbs[s])
	}
	if len(databases) == 0 {
		log.Printf("classification: scan complete, no sensitive columns found")
		return nil
	}

	payload := map[string]interface{}{
		"token": cfg.EnrollToken, "host": cfg.TargetHost,
		"port": atoiDefault(cfg.TargetPort, 3306), "engine": cfg.Engine, "databases": databases,
	}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(cfg.ControlPlane+"/api/classification/scan-results", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	log.Printf("classification reported (%d db): %s", len(databases), strings.TrimSpace(string(b)))
	return nil
}

// ── Inline proxy (MySQL) ─────────────────────────────────────────────
func runProxy(cfg Config) {
	ln, err := net.Listen("tcp", ":"+cfg.ListenPort)
	if err != nil {
		log.Fatalf("listen :%s failed: %v", cfg.ListenPort, err)
	}
	log.Printf("inline proxy listening on :%s → %s (clients connect here)", cfg.ListenPort, cfg.Upstream)
	startQuarantinePoller(cfg)
	for {
		client, err := ln.Accept()
		if err != nil {
			continue
		}
		go handleConn(cfg, client)
	}
}

// ── Account quarantine enforcement ───────────────────────────────────
// The control plane holds the set of quarantined principals; the agent refuses
// their traffic INLINE (drops the live session) until they are released. This is
// the real containment action — there is no session "resume" or query replay.
var (
	qMu         sync.RWMutex
	quarantined = map[string]bool{}
)

func isQuarantined(principal string) bool {
	qMu.RLock()
	defer qMu.RUnlock()
	return quarantined[principal]
}

func fetchQuarantineList(cfg Config) {
	resp, err := http.Get(cfg.ControlPlane + "/api/agents/quarantine-list?token=" + url.QueryEscape(cfg.EnrollToken))
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var out struct {
		Principals []string `json:"principals"`
	}
	if json.NewDecoder(resp.Body).Decode(&out) != nil {
		return
	}
	m := make(map[string]bool, len(out.Principals))
	for _, p := range out.Principals {
		m[p] = true
	}
	qMu.Lock()
	quarantined = m
	qMu.Unlock()
}

func startQuarantinePoller(cfg Config) {
	fetchQuarantineList(cfg)
	go func() {
		for {
			time.Sleep(8 * time.Second)
			fetchQuarantineList(cfg)
		}
	}()
}

type connState struct {
	mu           sync.Mutex // guards fields shared with the server→client (masking) goroutine
	principal    string
	firstSeen    bool   // proxy mode: first client packet seen
	gotUser      bool   // network mode: handshake response (seq 1) decoded
	queryAttrs   bool   // MySQL 8 CLIENT_QUERY_ATTRIBUTES negotiated → COM_QUERY has a param header
	deprecateEof bool   // CLIENT_DEPRECATE_EOF → result sets have no intermediate/terminal EOF packets
	buf          []byte // network mode: per-connection reassembly buffer
}

// Read the fields the masking goroutine needs (set once during the client handshake).
func (st *connState) snap() (principal string, deprecateEof bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.principal, st.deprecateEof
}

func handleConn(cfg Config, client net.Conn) {
	defer client.Close()
	upstream, err := net.Dial("tcp", cfg.Upstream)
	if err != nil {
		log.Printf("upstream dial failed: %v", err)
		return
	}
	defer upstream.Close()

	clientIP := "127.0.0.1"
	if a, ok := client.RemoteAddr().(*net.TCPAddr); ok {
		clientIP = a.IP.String()
	}

	st := &connState{principal: "unknown"}

	// upstream → client: frame result sets and redact masked columns per the connecting
	// principal (falls back to a straight copy on TLS/unparseable streams).
	go maskedPipe(cfg, st, upstream, client)

	// client → upstream: frame MySQL packets; capture queries, and forward or BLOCK per packet.
	var buf []byte
	tmp := make([]byte, 32*1024)
	for {
		n, rerr := client.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			buf = processPackets(cfg, st, buf, client, upstream, clientIP)
		}
		if rerr != nil {
			return
		}
	}
}

// processPackets frames complete client→server packets. It extracts the login username
// (first packet) and the SQL of COM_QUERY packets; an allowed query's packet is forwarded
// upstream, a denied one is dropped and a MySQL error is returned to the client (inline block).
func processPackets(cfg Config, st *connState, buf []byte, client, upstream net.Conn, clientIP string) []byte {
	for len(buf) >= 4 {
		plen := int(buf[0]) | int(buf[1])<<8 | int(buf[2])<<16
		if plen == 0 || len(buf) < 4+plen {
			break // incomplete packet
		}
		seq := buf[3]
		payload := buf[4 : 4+plen]
		packet := buf[:4+plen]
		blocked := false

		if !st.firstSeen {
			// Handshake response (protocol 41):
			// [4B capability flags LE][4B max packet][1B charset][23B reserved][NUL-term username].
			st.firstSeen = true
			st.mu.Lock()
			if len(payload) >= 4 {
				caps := uint32(payload[0]) | uint32(payload[1])<<8 | uint32(payload[2])<<16 | uint32(payload[3])<<24
				st.queryAttrs = caps&0x08000000 != 0   // CLIENT_QUERY_ATTRIBUTES
				st.deprecateEof = caps&0x01000000 != 0 // CLIENT_DEPRECATE_EOF
			}
			if len(payload) > 33 {
				if end := bytes.IndexByte(payload[32:], 0); end > 0 {
					st.principal = string(payload[32 : 32+end])
				}
			}
			st.mu.Unlock()
		} else if payload[0] == 0x03 { // COM_QUERY
			q := payload[1:]
			if st.queryAttrs {
				q = skipQueryAttrs(q)
			}
			sql := strings.TrimSpace(string(q))
			if isQuarantined(st.principal) {
				// Quarantined account: refuse and DROP the live session (no resume).
				writeMySQLError(client, seq+1, 1142, "Session quarantined by TooVix DAM — account access is blocked")
				log.Printf("[QUARANTINED] %-14s session dropped: %s", st.principal, truncate(sql, 60))
				client.Close()
				return nil
			}
			if denied(cfg, sql) {
				blocked = true
				writeMySQLError(client, seq+1, 1142, "Query blocked by TooVix DAM policy")
				log.Printf("[BLOCKED] %-14s %s", st.principal, truncate(sql, 80))
				go raiseAlert(cfg, st.principal, clientIP, sql)
				go quarantineSession(cfg, st.principal, clientIP, sql)
			} else {
				forwardEvent(cfg, st.principal, clientIP, sql)
			}
		}

		if !blocked {
			if _, werr := upstream.Write(packet); werr != nil {
				return buf[4+plen:]
			}
		}
		buf = buf[4+plen:]
	}
	return buf
}

// ── Result-set masking (server → client) ─────────────────────────────
// The masking policy (which columns to redact, the method, and which DB principals
// bypass) is fetched from the control plane and refreshed so UI toggles take effect.
type maskPolicy struct {
	cols         map[string]string          // "db|table|col" and "*|table|col" → method
	bypassByDb   map[string]map[string]bool // db → principals that see real values for that db
	bypassGlobal map[string]bool            // principals that bypass for every db (rarely used)
}

func (m *maskPolicy) methodFor(db, table, col string) string {
	if m == nil {
		return ""
	}
	if v, ok := m.cols[db+"|"+table+"|"+col]; ok {
		return v
	}
	if v, ok := m.cols["*|"+table+"|"+col]; ok {
		return v
	}
	return ""
}

// isBypassed reports whether a DB principal sees unmasked data for a given database.
func (m *maskPolicy) isBypassed(db, principal string) bool {
	if m == nil {
		return false
	}
	if m.bypassGlobal[principal] {
		return true
	}
	if s, ok := m.bypassByDb[db]; ok && s[principal] {
		return true
	}
	return false
}

func fetchMaskPolicy(cfg Config) *maskPolicy {
	p := &maskPolicy{cols: map[string]string{}, bypassByDb: map[string]map[string]bool{}, bypassGlobal: map[string]bool{}}
	resp, err := http.Get(cfg.ControlPlane + "/api/agents/masking-policy?token=" + url.QueryEscape(cfg.EnrollToken))
	if err != nil {
		return p
	}
	defer resp.Body.Close()
	var out struct {
		Columns []struct {
			DB, Table, Column, Method string
		} `json:"columns"`
		BypassByDb   map[string][]string `json:"bypassByDb"`
		BypassGlobal []string            `json:"bypassGlobal"`
	}
	if json.NewDecoder(resp.Body).Decode(&out) != nil {
		return p
	}
	for _, c := range out.Columns {
		p.cols[c.DB+"|"+c.Table+"|"+c.Column] = c.Method
		p.cols["*|"+c.Table+"|"+c.Column] = c.Method
	}
	for db, users := range out.BypassByDb {
		set := map[string]bool{}
		for _, u := range users {
			set[u] = true
		}
		p.bypassByDb[db] = set
	}
	for _, u := range out.BypassGlobal {
		p.bypassGlobal[u] = true
	}
	return p
}

type maskCol struct {
	mask   bool
	method string
}

// maskedPipe frames MySQL packets from the server, runs the text-protocol result-set
// state machine (column-count → column defs → rows), and rewrites flagged column
// values per row. Falls back to a raw copy on any framing/parse panic (e.g. TLS).
func maskedPipe(cfg Config, st *connState, upstream, client net.Conn) {
	defer func() {
		if r := recover(); r != nil {
			io.Copy(client, upstream) // give up masking, keep the connection alive
		}
	}()
	pol := fetchMaskPolicy(cfg)
	lastFetch := time.Now()

	const (
		rsIdle = iota
		rsCols
		rsColEof
		rsRows
	)
	authDone := false
	rs := rsIdle
	colsLeft := 0
	anyMask := false
	var cols []maskCol

	var buf []byte
	tmp := make([]byte, 32*1024)
	for {
		n, rerr := upstream.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			for len(buf) >= 4 {
				plen := int(buf[0]) | int(buf[1])<<8 | int(buf[2])<<16
				if len(buf) < 4+plen {
					break // incomplete packet
				}
				seq := buf[3]
				payload := buf[4 : 4+plen]
				out := buf[:4+plen] // default: pass through unchanged
				b0 := byte(0xff)
				if plen > 0 {
					b0 = payload[0]
				}

				if !authDone {
					// Connection/auth phase: command phase begins at the first OK/ERR.
					if plen > 0 && (b0 == 0x00 || b0 == 0xff) {
						authDone = true
					}
				} else {
					_, deprecateEof := st.snap()
					switch rs {
					case rsIdle:
						if plen == 0 || b0 == 0x00 || b0 == 0xff || b0 == 0xfb || (b0 == 0xfe && plen < 9) {
							// OK / ERR / LOCAL INFILE / EOF — not a result set
						} else if cnt, ln := readLenencInt(payload); ln > 0 {
							colsLeft = int(cnt)
							cols = make([]maskCol, 0, colsLeft)
							anyMask = false
							rs = rsCols
						}
					case rsCols:
						principal, _ := st.snap()
						mc := parseColDef(payload, pol, principal)
						if mc.mask {
							anyMask = true
						}
						cols = append(cols, mc)
						if colsLeft--; colsLeft <= 0 {
							if deprecateEof {
								rs = rsRows
							} else {
								rs = rsColEof
							}
						}
					case rsColEof:
						rs = rsRows // column-def terminator EOF; pass through
					case rsRows:
						if b0 == 0xfe && (plen < 9 || deprecateEof) {
							rs = rsIdle // end of result set
						} else if anyMask {
							if np := maskRow(payload, cols); np != nil {
								out = buildPacket(seq, np)
							}
						}
					}
				}

				if _, werr := client.Write(out); werr != nil {
					return
				}
				buf = buf[4+plen:]
			}
		}
		if rerr != nil {
			return
		}
		if time.Since(lastFetch) > 20*time.Second {
			pol = fetchMaskPolicy(cfg)
			lastFetch = time.Now()
		}
	}
}

func readLenencStr(b []byte) ([]byte, int) {
	if len(b) == 0 {
		return nil, 0
	}
	if b[0] == 0xfb { // NULL
		return nil, 1
	}
	l, ln := readLenencInt(b)
	if ln == 0 || ln+int(l) > len(b) {
		return nil, 0
	}
	return b[ln : ln+int(l)], ln + int(l)
}

// parseColDef extracts schema/org_table/org_name from a ColumnDefinition41 packet and
// resolves whether this column should be masked for the connecting principal.
func parseColDef(payload []byte, pol *maskPolicy, principal string) maskCol {
	if pol == nil {
		return maskCol{}
	}
	p := payload
	read := func() []byte {
		v, n := readLenencStr(p)
		if n == 0 {
			p = nil
			return nil
		}
		p = p[n:]
		return v
	}
	read()             // catalog
	schema := read()   // schema (db)
	read()             // table (alias)
	orgTable := read() // org_table
	read()             // name (alias)
	orgName := read()  // org_name
	if p == nil {
		return maskCol{}
	}
	if pol.isBypassed(string(schema), principal) { // per-database bypass
		return maskCol{}
	}
	method := pol.methodFor(string(schema), string(orgTable), string(orgName))
	if method == "" {
		return maskCol{}
	}
	return maskCol{mask: true, method: method}
}

// maskRow rewrites a text-protocol result row, replacing flagged column values.
// Returns nil if the row can't be cleanly parsed (caller then passes the original).
func maskRow(payload []byte, cols []maskCol) []byte {
	out := make([]byte, 0, len(payload)+16)
	p := payload
	for i := 0; i < len(cols); i++ {
		if len(p) == 0 {
			return nil
		}
		if p[0] == 0xfb { // NULL
			out = append(out, 0xfb)
			p = p[1:]
			continue
		}
		l, ln := readLenencInt(p)
		if ln == 0 || ln+int(l) > len(p) {
			return nil
		}
		val := p[ln : ln+int(l)]
		p = p[ln+int(l):]
		if cols[i].mask {
			out = append(out, encodeLenencStr([]byte(applyMask(cols[i].method, string(val))))...)
		} else {
			out = append(out, encodeLenencStr(val)...)
		}
	}
	return append(out, p...)
}

func encodeLenencInt(n uint64) []byte {
	switch {
	case n < 251:
		return []byte{byte(n)}
	case n < 1<<16:
		return []byte{0xfc, byte(n), byte(n >> 8)}
	case n < 1<<24:
		return []byte{0xfd, byte(n), byte(n >> 8), byte(n >> 16)}
	default:
		b := make([]byte, 9)
		b[0] = 0xfe
		for i := 0; i < 8; i++ {
			b[1+i] = byte(n >> (8 * i))
		}
		return b
	}
}

func encodeLenencStr(b []byte) []byte { return append(encodeLenencInt(uint64(len(b))), b...) }

func buildPacket(seq byte, payload []byte) []byte {
	l := len(payload)
	pkt := make([]byte, 4+l)
	pkt[0], pkt[1], pkt[2], pkt[3] = byte(l), byte(l>>8), byte(l>>16), seq
	copy(pkt[4:], payload)
	return pkt
}

func applyMask(method, s string) string {
	switch method {
	case "last-4":
		return maskLast4(s)
	case "email":
		return maskEmail(s)
	default: // redact
		return maskRedact(s)
	}
}

func maskLast4(s string) string {
	if len(s) <= 4 {
		return strings.Repeat("X", len(s))
	}
	return strings.Repeat("X", len(s)-4) + s[len(s)-4:]
}

func maskRedact(s string) string {
	out := []byte(s)
	for i, r := range out {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			out[i] = 'X'
		}
	}
	return string(out)
}

func maskEmail(s string) string {
	at := strings.IndexByte(s, '@')
	if at <= 0 {
		return maskRedact(s)
	}
	if at == 1 {
		return "*" + s[at:]
	}
	return s[:1] + strings.Repeat("*", at-1) + s[at:]
}

func denied(cfg Config, sql string) bool {
	u := strings.ToUpper(sql)
	for _, p := range cfg.BlockPatterns {
		if strings.Contains(u, p) {
			return true
		}
	}
	return false
}

// classifyBlock maps a blocked statement to a human-readable threat category
// (shown as the quarantine reason), so reviewers see "Privilege escalation"
// rather than a generic "policy match".
func classifyBlock(sql string) string {
	u := strings.ToUpper(sql)
	switch {
	case strings.Contains(u, "GRANT"):
		return "Privilege escalation"
	case strings.Contains(u, "DROP DATABASE"):
		return "Destructive DDL — database drop"
	case strings.Contains(u, "DROP TABLE"):
		return "Sensitive table modification — table drop"
	case strings.Contains(u, "TRUNCATE"):
		return "Sensitive table modification — table truncation"
	case strings.Contains(u, "ALTER"):
		return "Schema modification on protected object"
	case strings.Contains(u, "DELETE"):
		return "Mass row deletion"
	default:
		return "Blocking policy match"
	}
}

// writeMySQLError sends a protocol-41 ERR packet so the client sees a clean error (not a hang).
func writeMySQLError(client net.Conn, seq byte, code uint16, msg string) {
	payload := []byte{0xff, byte(code), byte(code >> 8), '#'}
	payload = append(payload, []byte("HY000")...)
	payload = append(payload, []byte(msg)...)
	n := len(payload)
	client.Write(append([]byte{byte(n), byte(n >> 8), byte(n >> 16), seq}, payload...))
}

func raiseAlert(cfg Config, principal, clientIP, sql string) {
	body, _ := json.Marshal(map[string]interface{}{
		"token":     cfg.EnrollToken,
		"host":      cfg.TargetHost,
		"port":      atoiOrNil(cfg.TargetPort),
		"principal": principal,
		"client_ip": clientIP,
		"summary":   "Blocked by policy: " + truncate(sql, 120),
		"severity":  "high",
		"raw_sql":   truncate(sql, 500),
	})
	resp, err := http.Post(cfg.ControlPlane+"/api/agents/alert", "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
}

// quarantineSession holds the offending session for human review: a blocked query
// not only alerts but also lands on the Quarantine screen so a reviewer can
// release (resume) or kill (terminate) the principal's session.
func quarantineSession(cfg Config, principal, clientIP, sql string) {
	dbName := cfg.TargetDB
	if dbName == "" {
		dbName = cfg.TargetHost
	}
	body, _ := json.Marshal(map[string]interface{}{
		"token":         cfg.EnrollToken,
		"session_id":    fmt.Sprintf("sess-%s-%d", principal, time.Now().UnixNano()),
		"principal":     principal,
		"database_name": dbName,
		"query_preview": truncate(sql, 200),
		"full_sql":      sql, // complete statement so a reviewer can release → execute it
		"engine":        cfg.Engine,
		"db_host":       cfg.TargetHost,
		"db_port":       atoiDefault(cfg.TargetPort, 0),
		"severity":      "critical",
		"reason":        classifyBlock(sql),
		"client_ip":     clientIP,
	})
	resp, err := http.Post(cfg.ControlPlane+"/api/quarantine", "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
}

// skipQueryAttrs strips the MySQL 8 query-attributes header from a COM_QUERY payload
// (the part after the 0x03 command byte): a length-encoded parameter_count and
// parameter_set_count, then — when parameter_count is 0 — the SQL text follows directly.
func skipQueryAttrs(q []byte) []byte {
	_, n1 := readLenencInt(q) // parameter_count
	if n1 == 0 || n1 > len(q) {
		return q
	}
	rest := q[n1:]
	_, n2 := readLenencInt(rest) // parameter_set_count
	if n2 == 0 || n2 > len(rest) {
		return q
	}
	return rest[n2:] // parameter_count==0 for typical queries → SQL starts here
}

func readLenencInt(b []byte) (uint64, int) {
	if len(b) == 0 {
		return 0, 0
	}
	switch {
	case b[0] < 0xfb:
		return uint64(b[0]), 1
	case b[0] == 0xfc:
		if len(b) < 3 {
			return 0, 0
		}
		return uint64(b[1]) | uint64(b[2])<<8, 3
	case b[0] == 0xfd:
		if len(b) < 4 {
			return 0, 0
		}
		return uint64(b[1]) | uint64(b[2])<<8 | uint64(b[3])<<16, 4
	case b[0] == 0xfe:
		if len(b) < 9 {
			return 0, 0
		}
		var v uint64
		for i := 0; i < 8; i++ {
			v |= uint64(b[1+i]) << (8 * i)
		}
		return v, 9
	}
	return 0, 0
}

// ── Event forwarding to ClickHouse ───────────────────────────────────
func forwardEvent(cfg Config, principal, clientIP, sql string) {
	sql = strings.TrimSpace(sql)
	if sql == "" {
		return
	}
	tenantID := cfg.TenantID
	if tenantID == "" {
		tenantID = "dev-tenant" // fallback if enrollment hasn't resolved a tenant yet
	}
	ev := map[string]interface{}{
		"tenant_id":     tenantID,
		"database_name": cfg.TargetDB,
		"principal":     principal,
		"client_ip":     clientIP,
		"operation":     detectOp(sql),
		"sql_text":      truncate(sql, 500),
		"sql_hash":      simpleHash(sql),
		"tags":          detectTags(sql),
		"agent_type":    agentTypeByMode[cfg.Mode],
		"row_count":     0,
		"duration_ms":   0,
		"anomaly_score": 0,
		"timestamp":     time.Now().UTC().Format("2006-01-02 15:04:05"),
	}
	body, _ := json.Marshal(ev)
	q := url.Values{}
	q.Set("query", "INSERT INTO dam_analytics.events FORMAT JSONEachRow")
	q.Set("user", cfg.CHUser)
	q.Set("password", cfg.CHPassword)
	resp, err := http.Post(cfg.ClickHouse+"/?"+q.Encode(), "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
	log.Printf("[capture] %-6s %-14s %s", detectOp(sql), principal, truncate(sql, 80))
}

// ── Helpers ──────────────────────────────────────────────────────────
func detectOp(sql string) string {
	u := strings.ToUpper(strings.TrimSpace(sql))
	switch {
	case strings.HasPrefix(u, "SELECT"):
		return "SELECT"
	case strings.HasPrefix(u, "INSERT"):
		return "INSERT"
	case strings.HasPrefix(u, "UPDATE"):
		return "UPDATE"
	case strings.HasPrefix(u, "DELETE"):
		return "DELETE"
	case strings.HasPrefix(u, "CREATE"), strings.HasPrefix(u, "ALTER"), strings.HasPrefix(u, "DROP"):
		return "DDL"
	default:
		return "OTHER"
	}
}

func detectTags(sql string) []string {
	u := strings.ToUpper(sql)
	tags := []string{}
	add := func(t string) { tags = append(tags, t) }
	if strings.Contains(u, "SSN") || strings.Contains(u, "SOCIAL_SECURITY") {
		add("ssn")
	}
	if strings.Contains(u, "CARD") || strings.Contains(u, "PAN_VAULT") {
		add("pci")
	}
	if strings.Contains(u, "AADHAAR") {
		add("aadhaar")
	}
	if strings.Contains(u, "EMAIL") || strings.Contains(u, "PHONE") || strings.Contains(u, "ADDRESS") || strings.Contains(u, "DOB") {
		add("pii")
	}
	return tags
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func simpleHash(s string) string {
	var h uint32 = 2166136261
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return fmt.Sprintf("%08x", h)
}

func atoiOrNil(s string) interface{} {
	if s == "" {
		return nil
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return nil
		}
		n = n*10 + int(c-'0')
	}
	return n
}
