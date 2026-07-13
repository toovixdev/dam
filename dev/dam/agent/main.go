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
	_ "github.com/lib/pq"
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
	DBName       string // postgres: the database to classify (information_schema is per-DB in PG)
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
		DBName:    env("DB_NAME", ""),
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
	classifiable := cfg.Engine == "mysql" || cfg.Engine == "postgresql"
	if cfg.Classify && cfg.DBUser != "" && classifiable {
		go classifyLoop(cfg)     // periodic (CLASSIFY_INTERVAL_MIN)
		go scanTriggerLoop(cfg)  // on-demand — the "Run Scan" button
	} else if cfg.Classify {
		log.Printf("classification enabled but skipped (need DB_USER and engine mysql|postgresql; postgres also needs DB_NAME)")
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
var capDebug bool

func runNetwork(cfg Config) {
	iface := env("CAPTURE_IFACE", "eth0")
	// "any" (ifindex 0) sniffs ALL interfaces incl. loopback — handy when SQL is run
	// on the DB host itself (localhost connections travel over lo, not the primary NIC).
	ifIndex := 0
	if iface != "any" && iface != "" {
		ifi, err := net.InterfaceByName(iface)
		if err != nil {
			log.Fatalf("interface %s not found: %v", iface, err)
		}
		ifIndex = ifi.Index
	}
	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, int(htons(0x0003))) // ETH_P_ALL
	if err != nil {
		log.Fatalf("AF_PACKET socket failed: %v (needs CAP_NET_RAW / root)", err)
	}
	defer syscall.Close(fd)
	// Large receive buffer so a burst (e.g. a big result set flooding loopback) doesn't
	// overflow the socket and drop frames — dropped frames desync the packet framer.
	// SO_RCVBUFFORCE (33) bypasses net.core.rmem_max (we hold CAP_NET_ADMIN).
	if e := syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, 33, 64*1024*1024); e != nil {
		syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_RCVBUF, 64*1024*1024)
	}
	if err := syscall.Bind(fd, &syscall.SockaddrLinklayer{Protocol: htons(0x0003), Ifindex: ifIndex}); err != nil {
		log.Fatalf("bind to %s failed: %v", iface, err)
	}
	targetPort := uint16(atoiDefault(cfg.TargetPort, 3306))
	capDebug = env("CAPTURE_DEBUG", "false") == "true"
	log.Printf("network agent sniffing %s for tcp/%d engine=%s (passive capture, debug=%v)", iface, targetPort, cfg.Engine, capDebug)

	conns := map[string]*connState{}
	// Big enough for a full IPv4 packet (65535) + link header, and for loopback GSO
	// super-segments — a too-small buffer truncates large result sets and desyncs framing.
	frame := make([]byte, 262144)
	var frames uint64
	for {
		n, from, err := syscall.Recvfrom(fd, frame, 0)
		if err != nil || n < 14 {
			continue
		}
		// On loopback, each packet is delivered twice (outgoing + incoming copy). Skip the
		// outgoing copy so we don't double-count queries/rows.
		if sll, ok := from.(*syscall.SockaddrLinklayer); ok && sll.Pkttype == packetOutgoing {
			continue
		}
		frames++
		if capDebug && frames%50 == 0 {
			log.Printf("[net-dbg] %d frames seen on %s", frames, iface)
		}
		handleFrame(cfg, frame[:n], targetPort, conns)
	}
}

// handleFrame parses Ethernet/IPv4/TCP. Client→server payload is decoded for SQL;
// server→client payload is parsed to count result rows for the pending query.
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
	dstIP := net.IP(ip[16:20]).String()
	tcp := ip[ihl:]
	srcPort := uint16(tcp[0])<<8 | uint16(tcp[1])
	dstPort := uint16(tcp[2])<<8 | uint16(tcp[3])
	dataOff := int(tcp[12]>>4) * 4
	if len(tcp) < dataOff {
		return
	}
	payload := tcp[dataOff:]
	if len(payload) == 0 {
		return
	}
	pg := cfg.Engine == "postgresql"
	// A connection is keyed by the CLIENT's ip:port, computed the same in both directions.
	if dstPort == targetPort { // client → server (queries)
		key := fmt.Sprintf("%s:%d", srcIP, srcPort)
		st := conns[key]
		if st == nil {
			st = &connState{principal: "unknown"}
			conns[key] = st
		}
		// Defer emitting until the server's response is parsed so we know the row count.
		onQuery := func(sql string) {
			st.pendingSQL = sql
			st.pendingIP = srcIP
			st.haveQuery = true
			st.rs = nrIdle
			st.rowCount = 0
		}
		if pg {
			st.buf = frameAndDecodePG(st, append(st.buf, payload...), onQuery)
		} else {
			st.buf = frameAndDecode(st, append(st.buf, payload...), onQuery)
		}
	} else if srcPort == targetPort { // server → client (result sets)
		key := fmt.Sprintf("%s:%d", dstIP, dstPort)
		st := conns[key]
		if st == nil {
			return // response for a connection we never saw open — ignore
		}
		if pg {
			st.respBuf = parseResponsePG(cfg, st, append(st.respBuf, payload...))
		} else {
			st.respBuf = parseResponse(cfg, st, append(st.respBuf, payload...))
		}
	}
}

// parseResponse frames server→client MySQL packets and counts result rows for the
// pending query, emitting the event when the result set (or OK/ERR) completes.
func parseResponse(cfg Config, st *connState, buf []byte) []byte {
	for len(buf) >= 4 {
		plen := int(buf[0]) | int(buf[1])<<8 | int(buf[2])<<16
		if len(buf) < 4+plen {
			break
		}
		payload := buf[4 : 4+plen]
		buf = buf[4+plen:]
		b0 := byte(0xff)
		if plen > 0 {
			b0 = payload[0]
		}
		if !st.authDone {
			if plen > 0 && (b0 == 0x00 || b0 == 0xff) { // first OK/ERR → command phase
				st.authDone = true
			}
			continue
		}
		if !st.haveQuery {
			continue // a response with no query we tracked (e.g. mid-stream start)
		}
		switch st.rs {
		case nrIdle:
			if plen == 0 || b0 == 0x00 || b0 == 0xff || b0 == 0xfb || (b0 == 0xfe && plen < 9) {
				// OK / ERR / EOF / LOCAL INFILE — not a SELECT result set.
				n := 0
				if b0 == 0x00 { // OK packet → affected_rows (INSERT/UPDATE/DELETE)
					if v, ln := readLenencInt(payload[1:]); ln > 0 {
						n = int(v)
					}
				}
				emitCaptured(cfg, st, n)
			} else if cnt, ln := readLenencInt(payload); ln > 0 {
				st.colsLeft = int(cnt)
				st.rowCount = 0
				st.rs = nrCols
			}
		case nrCols:
			if st.colsLeft--; st.colsLeft <= 0 {
				if st.deprecateEof {
					st.rs = nrRows
				} else {
					st.rs = nrColEof
				}
			}
		case nrColEof:
			st.rs = nrRows // EOF terminating the column defs
		case nrRows:
			if b0 == 0xfe && (plen < 9 || st.deprecateEof) { // result-set terminator
				emitCaptured(cfg, st, st.rowCount)
			} else {
				st.rowCount++
			}
		}
	}
	return buf
}

// emitCaptured ships the pending query with its real row count, then resets.
func emitCaptured(cfg Config, st *connState, rowCount int) {
	if st.haveQuery {
		forwardEvent(cfg, st.principal, st.pendingIP, st.pendingSQL, rowCount)
	}
	st.haveQuery = false
	st.rs = nrIdle
	st.rowCount = 0
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
				st.deprecateEof = caps&0x01000000 != 0 // CLIENT_DEPRECATE_EOF
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

// ── PostgreSQL v3 wire decode (network mode) ─────────────────────────────────
// Engine-branched from handleFrame (cfg.Engine == "postgresql"); the MySQL path above
// is untouched. Passive — observes cleartext protocol only (TLS'd connections are opaque,
// same limitation as MySQL). Simple ('Q') and extended ('P' Parse) queries are captured.

func be32(b []byte) int {
	return int(b[0])<<24 | int(b[1])<<16 | int(b[2])<<8 | int(b[3])
}

// pgStr returns the bytes up to the first NUL (Postgres strings are NUL-terminated).
func pgStr(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		return string(b[:i])
	}
	return string(b)
}

// lastIntInTag pulls the trailing integer from a CommandComplete tag
// ("SELECT 5"→5, "INSERT 0 3"→3, "UPDATE 2"→2, "DELETE 1"→1); -1 if none (e.g. "CREATE TABLE").
func lastIntInTag(tag string) int {
	end := len(tag)
	for end > 0 && (tag[end-1] < '0' || tag[end-1] > '9') {
		end--
	}
	if end == 0 {
		return -1
	}
	start := end
	for start > 0 && tag[start-1] >= '0' && tag[start-1] <= '9' {
		start--
	}
	n := 0
	for i := start; i < end; i++ {
		n = n*10 + int(tag[i]-'0')
	}
	return n
}

// frameAndDecodePG frames client→server messages. The first (untyped) startup message is
// parsed once to pull the connecting user (principal); thereafter each message is
// [type:1][len:4 incl. itself][body]. SQL comes from 'Q' (simple) and 'P' (Parse) bodies.
func frameAndDecodePG(st *connState, buf []byte, onQuery func(sql string)) []byte {
	for {
		if !st.pgStartupDone {
			if len(buf) < 8 {
				return buf
			}
			mlen := be32(buf[0:4])
			if mlen < 8 || mlen > 1<<20 { // not a startup we understand → treat rest as typed
				st.pgStartupDone = true
				continue
			}
			if len(buf) < mlen {
				return buf
			}
			code := be32(buf[4:8])
			body := buf[8:mlen]
			buf = buf[mlen:]
			switch code {
			case 80877103, 80877102: // SSLRequest / GSSENCRequest: the server sends a 1-byte
				// reply, then (if it declines) the REAL StartupMessage follows in cleartext.
				// Stay in startup state so we parse that real startup next; flag the server side
				// to consume the 1-byte reply.
				st.pgSSLReplyPending = true
				continue
			case 196608: // protocol 3.0 → params are key\0value\0…\0\0
				parts := bytes.Split(body, []byte{0})
				for i := 0; i+1 < len(parts); i += 2 {
					if string(parts[i]) == "user" && st.principal == "unknown" {
						st.principal = string(parts[i+1])
					}
				}
			}
			st.pgStartupDone = true
			continue
		}
		if len(buf) < 5 {
			return buf
		}
		mlen := be32(buf[1:5]) // length includes these 4 bytes, excludes the 1 type byte
		if mlen < 4 || mlen > 1<<24 {
			return nil // desync (likely TLS/binary) — drop the buffer to resync
		}
		total := 1 + mlen
		if len(buf) < total {
			return buf
		}
		typ := buf[0]
		body := buf[5:total]
		buf = buf[total:]
		switch typ {
		case 'Q': // Simple Query — NUL-terminated SQL
			if sql := pgStr(body); strings.TrimSpace(sql) != "" {
				onQuery(strings.TrimSpace(sql))
			}
		case 'P': // Parse (extended) — stmtName\0 query\0 paramTypes…
			if i := bytes.IndexByte(body, 0); i >= 0 {
				if sql := pgStr(body[i+1:]); strings.TrimSpace(sql) != "" {
					onQuery(strings.TrimSpace(sql))
				}
			}
		}
	}
}

// parseResponsePG frames server→client messages, counting DataRow ('D') and emitting the
// pending query on CommandComplete ('C') — whose tag carries the authoritative row count —
// or on ErrorResponse ('E', captured as a failed attempt with 0 rows).
func parseResponsePG(cfg Config, st *connState, buf []byte) []byte {
	for {
		if st.pgSSLReplyPending { // consume the server's 1-byte SSL reply ('S'=accept, 'N'=decline)
			if len(buf) < 1 {
				return buf
			}
			ssl := buf[0]
			buf = buf[1:]
			st.pgSSLReplyPending = false
			if ssl == 'S' { // SSL accepted → the rest is TLS, undecodable
				return nil
			}
			// 'N' (declined) → cleartext continues; fall through to normal message parsing
		}
		if len(buf) < 5 {
			return buf
		}
		mlen := be32(buf[1:5])
		if mlen < 4 || mlen > 1<<24 {
			return nil
		}
		total := 1 + mlen
		if len(buf) < total {
			return buf
		}
		typ := buf[0]
		body := buf[5:total]
		buf = buf[total:]
		switch typ {
		case 'D': // DataRow — fallback counter
			st.rowCount++
		case 'C': // CommandComplete — tag = "SELECT 5" / "INSERT 0 3" / …
			n := lastIntInTag(pgStr(body))
			if n < 0 {
				n = st.rowCount
			}
			emitCaptured(cfg, st, n)
			st.rowCount = 0
		case 'E': // ErrorResponse — the query failed; still capture the attempt
			emitCaptured(cfg, st, 0)
			st.rowCount = 0
		}
	}
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

// scanTriggerLoop makes the Classification page's "Run Scan" button work: it polls the
// control plane for an on-demand scan request for this agent's tenant and runs immediately.
func scanTriggerLoop(cfg Config) {
	client := &http.Client{Timeout: 10 * time.Second}
	pollURL := cfg.ControlPlane + "/api/classification/scan-pending?token=" + url.QueryEscape(cfg.EnrollToken)
	for {
		time.Sleep(12 * time.Second)
		resp, err := client.Get(pollURL)
		if err != nil {
			continue
		}
		var body struct {
			Pending bool `json:"pending"`
		}
		json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if body.Pending {
			log.Printf("on-demand classification scan requested")
			if err := runClassificationScan(cfg); err != nil {
				log.Printf("on-demand classification scan failed: %v", err)
			}
		}
	}
}

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

type scanTarget struct {
	driver  string
	dsn     string
	query   string
	dbLabel string // "" → MySQL (schema IS the database); else the PostgreSQL database name
}

// pgDSN builds a lib/pq DSN for one Postgres database. sslmode=disable keeps the scan in
// cleartext (so the sniffer sees it too); scram auth still works over a non-TLS socket.
func pgDSN(cfg Config, dbname string) string {
	return fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable connect_timeout=8",
		cfg.TargetHost, cfg.TargetPort, cfg.DBUser, cfg.DBPass, dbname)
}

// resolvePGDatabases turns DB_NAME into the Postgres databases to scan:
//   "inventory"          → [inventory]
//   "inventory,billing"  → [inventory, billing]
//   "" or "*"            → auto-discover every non-template, connectable database
func resolvePGDatabases(cfg Config) ([]string, error) {
	auto := strings.TrimSpace(cfg.DBName) == ""
	var explicit []string
	for _, p := range strings.Split(cfg.DBName, ",") {
		if p = strings.TrimSpace(p); p == "*" {
			auto = true
		} else if p != "" {
			explicit = append(explicit, p)
		}
	}
	if !auto {
		return explicit, nil
	}
	boot := "postgres" // a database to connect to just for the discovery query
	if len(explicit) > 0 {
		boot = explicit[0]
	}
	db, err := sql.Open("postgres", pgDSN(cfg, boot))
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(`SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn = true ORDER BY datname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if rows.Scan(&n) == nil {
			out = append(out, n)
		}
	}
	return out, nil
}

// scanTargets is the list of DB connections classification should read. MySQL is one
// connection (its information_schema is server-wide); PostgreSQL is one per database.
func scanTargets(cfg Config) ([]scanTarget, error) {
	if cfg.Engine == "postgresql" {
		dbList, err := resolvePGDatabases(cfg)
		if err != nil {
			return nil, err
		}
		if len(dbList) == 0 {
			return nil, fmt.Errorf("postgres classification: no databases to scan (set DB_NAME=<db>[,<db>] or '*')")
		}
		const q = `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
			WHERE table_schema NOT IN ('pg_catalog','information_schema')
			ORDER BY table_schema, table_name, ordinal_position`
		ts := make([]scanTarget, 0, len(dbList))
		for _, d := range dbList {
			ts = append(ts, scanTarget{driver: "postgres", dsn: pgDSN(cfg, d), query: q, dbLabel: d})
		}
		return ts, nil
	}
	const q = `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
		WHERE table_schema NOT IN ('mysql','sys','information_schema','performance_schema')
		ORDER BY table_schema, table_name, ordinal_position`
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/information_schema?timeout=8s&readTimeout=20s&allowNativePasswords=true", cfg.DBUser, cfg.DBPass, cfg.TargetHost, cfg.TargetPort)
	return []scanTarget{{driver: "mysql", dsn: dsn, query: q, dbLabel: ""}}, nil
}

func runClassificationScan(cfg Config) error {
	targets, err := scanTargets(cfg)
	if err != nil {
		return err
	}

	type objAgg struct {
		dbName, schema, table string
		total                 int
		cols                  []map[string]interface{}
	}
	objs := map[string]*objAgg{}
	var objOrder []string
	for _, t := range targets {
		db, err := sql.Open(t.driver, t.dsn)
		if err != nil {
			log.Printf("classification: connect to %q failed: %v", t.dbLabel, err)
			continue
		}
		db.SetConnMaxLifetime(30 * time.Second)
		rows, err := db.Query(t.query)
		if err != nil {
			db.Close()
			log.Printf("classification: query %q failed: %v", t.dbLabel, err)
			continue
		}
		for rows.Next() {
			var sch, tbl, col, dt string
			if err := rows.Scan(&sch, &tbl, &col, &dt); err != nil {
				continue
			}
			dbName := t.dbLabel
			if dbName == "" {
				dbName = sch // MySQL: the schema IS the database
			}
			key := dbName + "\x00" + sch + "\x00" + tbl
			o := objs[key]
			if o == nil {
				o = &objAgg{dbName: dbName, schema: sch, table: tbl}
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
		rows.Close()
		db.Close()
	}

	// Group by schema (= database in MySQL). We report EVERY scanned schema — including
	// those with zero sensitive columns — with per-database totals, so the control plane
	// can compute real classification coverage (columns scanned vs. sensitive found).
	dbs := map[string]map[string]interface{}{}
	newSens := map[string][]string{} // table → policy tags, rebuilt each scan
	var dbOrder []string
	ensureDB := func(name string) map[string]interface{} {
		d := dbs[name]
		if d == nil {
			d = map[string]interface{}{"name": name, "objects": []interface{}{}, "columns_total": 0, "objects_total": 0, "sensitive_total": 0}
			dbs[name] = d
			dbOrder = append(dbOrder, name)
		}
		return d
	}
	for _, key := range objOrder {
		o := objs[key]
		d := ensureDB(o.dbName)
		d["columns_total"] = d["columns_total"].(int) + o.total
		d["objects_total"] = d["objects_total"].(int) + 1
		if len(o.cols) == 0 {
			continue // object has no sensitive columns — counted in totals, not in the inventory
		}
		best := "low"
		for _, c := range o.cols {
			if sensRank[c["sensitivity"].(string)] > sensRank[best] {
				best = c["sensitivity"].(string)
			}
		}
		d["sensitive_total"] = d["sensitive_total"].(int) + len(o.cols)
		d["objects"] = append(d["objects"].([]interface{}), map[string]interface{}{
			"schema_name": o.schema, "object_name": o.table, "object_type": "table",
			"column_count": o.total, "sensitivity": best, "columns": o.cols,
		})
		// Record this table's policy tags so captured reads of it get tagged sensitive.
		tset := map[string]bool{}
		for _, c := range o.cols {
			for _, t := range c["tags"].([]string) {
				tset[policyTagFor(t)] = true
			}
		}
		tags := []string{}
		for t := range tset {
			tags = append(tags, t)
		}
		newSens[strings.ToLower(o.table)] = tags
		newSens[strings.ToLower(o.schema+"."+o.table)] = tags
		newSens[strings.ToLower(o.dbName+"."+o.table)] = tags
	}
	sensTablesMu.Lock()
	sensTables = newSens
	sensTablesMu.Unlock()

	databases := []interface{}{}
	for _, s := range dbOrder {
		databases = append(databases, dbs[s])
	}
	if len(databases) == 0 {
		log.Printf("classification: scan complete, no user schemas found")
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
	// network mode: server→client response parsing, to attach a real row_count to the
	// query that produced it (so volume-threshold policies like "bulk read" can fire).
	respBuf     []byte
	authDone    bool
	rs          int // nrIdle | nrCols | nrColEof | nrRows
	colsLeft    int
	rowCount    int
	pendingSQL  string // the query awaiting its result set
	pendingIP   string
	haveQuery   bool
	pgStartupDone bool // postgres: startup message consumed (principal pulled from it)
	pgSSLReplyPending bool // postgres: client sent SSLRequest; skip the server's 1-byte reply
}

// network-mode response-parser states (mirror the proxy's masking state machine).
const (
	nrIdle = iota
	nrCols
	nrColEof
	nrRows
)

const packetOutgoing = 4 // linux PACKET_OUTGOING (loopback delivers a tx + rx copy)

// sensTables maps a classified-sensitive table name → policy-taxonomy tags, refreshed by
// each classification scan. Used to tag captured queries that read a sensitive table.
var (
	sensTablesMu sync.Mutex
	sensTables   = map[string][]string{}
)

// policyTagFor collapses the classifier's fine-grained tag into the policy taxonomy.
func policyTagFor(t string) string {
	switch t {
	case "pci":
		return "pci"
	case "aadhaar":
		return "aadhaar"
	default:
		return "pii"
	}
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
				forwardEvent(cfg, st.principal, clientIP, sql, 0)
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

// ── Event forwarding to the control plane ────────────────────────────
func forwardEvent(cfg Config, principal, clientIP, sql string, rowCount int) {
	sql = strings.TrimSpace(sql)
	if sql == "" {
		return
	}
	tags := detectTags(sql)
	tags = append(tags, classifyTags(sql)...) // tags from the agent's own classification scan
	ev := map[string]interface{}{
		"database_name": cfg.TargetDB,
		"principal":     principal,
		"client_ip":     clientIP,
		"operation":     detectOp(sql),
		"sql_text":      truncate(sql, 500),
		"tags":          dedupTags(tags),
		"agent_type":    agentTypeByMode[cfg.Mode],
		"row_count":     rowCount,
		"anomaly_score": 0,
		"source_host":   cfg.TargetHost,
		"timestamp":     time.Now().UTC().Format("2006-01-02 15:04:05"),
	}
	// Ship OUTBOUND to the control plane (not straight to ClickHouse, which isn't
	// reachable from a customer network). The control plane writes it to the data plane.
	payload := map[string]interface{}{"token": cfg.EnrollToken, "host": cfg.TargetHost, "events": []interface{}{ev}}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(cfg.ControlPlane+"/api/agents/events", "application/json", bytes.NewReader(body))
	if err != nil {
		log.Printf("[capture] event ship failed: %v", err)
	} else {
		resp.Body.Close()
	}
	log.Printf("[capture] %-6s rows=%-6d %-14s %s", detectOp(sql), rowCount, principal, truncate(sql, 70))
}

// classifyTags maps the agent's classification scan (sensitive tables) to policy-taxonomy
// tags (pii/pci/aadhaar), so a read of a sensitive table is tagged even when the query
// doesn't name a sensitive column (e.g. SELECT *).
func classifyTags(sql string) []string {
	sensTablesMu.Lock()
	defer sensTablesMu.Unlock()
	if len(sensTables) == 0 {
		return nil
	}
	lower := strings.ToLower(sql)
	out := []string{}
	seen := map[string]bool{}
	for tbl, tags := range sensTables {
		if strings.Contains(lower, tbl) {
			for _, t := range tags {
				if !seen[t] {
					seen[t] = true
					out = append(out, t)
				}
			}
		}
	}
	return out
}

func dedupTags(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, t := range in {
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
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
	case strings.HasPrefix(u, "GRANT"), strings.HasPrefix(u, "REVOKE"):
		return "GRANT" // privilege change (GRANT/REVOKE) — drives privileged-access policies
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
