// VA Scanner — database security assessment executed by the agent.
//
// A VA scan is the same shape as classification: log in as the least-privilege reader, run
// READ-ONLY catalog/config queries, evaluate each against an expected value, and POST the
// findings. Checks are DATA (vaCheck records), not code — adding coverage is adding rows.
// Each check maps to a CIS section + framework refs so findings roll up into Compliance.
//
// Checks that need catalog access the reader lacks (e.g. mysql.user, pg_hba_file_rules)
// degrade to status "error" for that check — never fail the whole scan.
package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type vaExpect struct {
	Op     string // equals|notEquals|contains|notContains|empty|notEmpty|gte|lte|rowsZero|rowsNonZero
	Column string // column of the first row to read (empty → first column)
	Value  string
}

type vaCheck struct {
	ID          string
	Section     string
	Title       string
	Severity    string // critical|high|medium|low|info
	Query       string
	Expect      vaExpect
	Remediation string
	Refs        []string
}

type vaFinding struct {
	CheckID     string   `json:"check_id"`
	Section     string   `json:"section"`
	Title       string   `json:"title"`
	Severity    string   `json:"severity"`
	Status      string   `json:"status"` // pass|fail|error
	Detail      string   `json:"detail,omitempty"`
	Evidence    string   `json:"evidence,omitempty"`
	Remediation string   `json:"remediation,omitempty"`
	Refs        []string `json:"refs,omitempty"`
}

// normalize collapses common boolean/state spellings so ON==on==YES==t==true==1, making the
// equals/notEquals checks robust across MySQL (ON/OFF, Y/N) and Postgres (on/off, t/f).
func vaNormalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	switch s {
	case "on", "yes", "y", "t", "true", "1", "enabled":
		return "true"
	case "off", "no", "n", "f", "false", "0", "disabled":
		return "false"
	}
	return s
}

func vaToFloat(s string) float64 { f, _ := strconv.ParseFloat(strings.TrimSpace(s), 64); return f }

// evalExpect runs the comparison and returns (pass, evidence).
func vaEval(e vaExpect, cols []string, rows [][]string) (bool, string) {
	// Row-count operators (offending-rows pattern): the query returns the bad rows.
	if e.Op == "rowsZero" || e.Op == "rowsNonZero" {
		sample := ""
		if len(rows) > 0 {
			var parts []string
			for i, r := range rows {
				if i >= 3 {
					parts = append(parts, fmt.Sprintf("+%d more", len(rows)-3))
					break
				}
				parts = append(parts, strings.Join(r, " "))
			}
			sample = " · " + strings.Join(parts, ", ")
		}
		if e.Op == "rowsZero" {
			return len(rows) == 0, fmt.Sprintf("%d matching row(s)%s", len(rows), sample)
		}
		return len(rows) > 0, fmt.Sprintf("%d matching row(s)%s", len(rows), sample)
	}
	if len(rows) == 0 {
		return false, "no rows returned"
	}
	idx := 0
	if e.Column != "" {
		for i, c := range cols {
			if strings.EqualFold(c, e.Column) {
				idx = i
				break
			}
		}
	}
	val := ""
	if idx < len(rows[0]) {
		val = rows[0][idx]
	}
	ev := cols[idx] + " = " + val
	switch e.Op {
	case "equals":
		return vaNormalize(val) == vaNormalize(e.Value), ev
	case "notEquals":
		return vaNormalize(val) != vaNormalize(e.Value), ev
	case "contains":
		return strings.Contains(strings.ToLower(val), strings.ToLower(e.Value)), ev
	case "notContains":
		return !strings.Contains(strings.ToLower(val), strings.ToLower(e.Value)), ev
	case "empty":
		return strings.TrimSpace(val) == "", ev
	case "notEmpty":
		return strings.TrimSpace(val) != "", ev
	case "gte":
		return vaToFloat(val) >= vaToFloat(e.Value), ev
	case "lte":
		return vaToFloat(val) <= vaToFloat(e.Value), ev
	}
	return false, ev
}

func runVaCheck(db *sql.DB, c vaCheck) vaFinding {
	f := vaFinding{CheckID: c.ID, Section: c.Section, Title: c.Title, Severity: c.Severity, Remediation: c.Remediation, Refs: c.Refs}
	rows, err := db.Query(tagAgentQuery(c.Query))
	if err != nil {
		f.Status = "error"
		f.Detail = "check could not run: " + err.Error()
		return f
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	var all [][]string
	for rows.Next() {
		raw := make([]sql.RawBytes, len(cols))
		ptrs := make([]interface{}, len(cols))
		for i := range raw {
			ptrs[i] = &raw[i]
		}
		if rows.Scan(ptrs...) != nil {
			continue
		}
		row := make([]string, len(cols))
		for i := range raw {
			row[i] = string(raw[i])
		}
		all = append(all, row)
	}
	pass, evidence := vaEval(c.Expect, cols, all)
	if pass {
		f.Status = "pass"
	} else {
		f.Status = "fail"
	}
	f.Evidence = evidence
	return f
}

// vaConnect opens a read-only connection appropriate to the engine.
func vaConnect(cfg Config) (*sql.DB, string, error) {
	switch cfg.Engine {
	case "mysql":
		dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/?timeout=8s&readTimeout=20s&allowNativePasswords=true", cfg.DBUser, cfg.DBPass, cfg.TargetHost, cfg.TargetPort)
		db, err := sql.Open("mysql", dsn)
		return db, "CIS MySQL 8.0", err
	case "postgresql":
		dbname := "postgres"
		for _, p := range strings.Split(cfg.DBName, ",") {
			if p = strings.TrimSpace(p); p != "" && p != "*" {
				dbname = p
				break
			}
		}
		db, err := sql.Open("postgres", pgDSN(cfg, dbname))
		return db, "CIS PostgreSQL", err
	}
	return nil, "", fmt.Errorf("VA scan unsupported for engine %q", cfg.Engine)
}

// vaDatabaseLabel is the database name findings are attributed to (must line up with a
// databases row the user sees). Prefer an explicit DB_NAME, else the display target.
func vaDatabaseLabel(cfg Config) string {
	for _, p := range strings.Split(cfg.DBName, ",") {
		if p = strings.TrimSpace(p); p != "" && p != "*" {
			return p
		}
	}
	if cfg.TargetDB != "" {
		return cfg.TargetDB
	}
	return cfg.TargetHost
}

func runVaScan(cfg Config) error {
	db, benchmark, err := vaConnect(cfg)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(2)
	if err := db.Ping(); err != nil {
		return fmt.Errorf("VA scan connect failed: %w", err)
	}
	var checks []vaCheck
	switch cfg.Engine {
	case "mysql":
		checks = mysqlVaChecks
	case "postgresql":
		checks = postgresVaChecks
	}
	findings := make([]vaFinding, 0, len(checks))
	var pass, fail, errc int
	for _, c := range checks {
		f := runVaCheck(db, c)
		f.Refs = c.Refs
		switch f.Status {
		case "pass":
			pass++
		case "fail":
			fail++
		default:
			errc++
		}
		findings = append(findings, f)
	}
	payload := map[string]interface{}{
		"token": cfg.EnrollToken, "host": cfg.TargetHost, "port": atoiDefault(cfg.TargetPort, 3306),
		"engine": cfg.Engine, "database": vaDatabaseLabel(cfg), "benchmark": benchmark, "checks": findings,
	}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(cfg.ControlPlane+"/api/va/scan-results", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	log.Printf("VA scan reported (%s): %d pass / %d fail / %d error — %s", benchmark, pass, fail, errc, strings.TrimSpace(string(b)))
	return nil
}

// vaScanLoop runs a scan periodically (VA_SCAN_INTERVAL_MIN, default 12h).
func vaScanLoop(cfg Config) {
	every := time.Duration(atoiDefault(env("VA_SCAN_INTERVAL_MIN", "720"), 720)) * time.Minute
	if every < time.Minute {
		every = 12 * time.Hour
	}
	time.Sleep(20 * time.Second) // let enrollment settle
	for {
		if err := runVaScan(cfg); err != nil {
			log.Printf("VA scan failed: %v", err)
		}
		time.Sleep(every)
	}
}

// vaScanTriggerLoop makes the VA page's "Run scan" button work (mirrors scanTriggerLoop).
func vaScanTriggerLoop(cfg Config) {
	client := &http.Client{Timeout: 10 * time.Second}
	pollURL := cfg.ControlPlane + "/api/va/scan-pending?token=" + url.QueryEscape(cfg.EnrollToken)
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
			log.Printf("on-demand VA scan requested")
			if err := runVaScan(cfg); err != nil {
				log.Printf("on-demand VA scan failed: %v", err)
			}
		}
	}
}
