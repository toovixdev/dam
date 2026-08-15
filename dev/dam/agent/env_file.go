package main

import (
	"bufio"
	"log"
	"os"
	"runtime"
	"strings"
)

// defaultEnvFilePath is where the agent looks for a KEY=VALUE config file when one isn't given
// via DAM_AGENT_ENV. On Windows this is how the service — which inherits no user environment —
// gets its settings; on Linux the systemd unit uses an EnvironmentFile instead, so this is just
// a convenience.
func defaultEnvFilePath() string {
	if runtime.GOOS == "windows" {
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return pd + `\TooVix\dam-agent.env`
	}
	return "/etc/toovix/dam-agent.env"
}

// loadEnvFileIfPresent reads a KEY=VALUE file (path from DAM_AGENT_ENV, else the per-OS default)
// and sets each entry in the process environment BEFORE loadConfig reads it. A value already
// present in the real environment always wins, so an operator can still override per run. Absent
// file → silent no-op (the agent then relies purely on real env vars, as before).
func loadEnvFileIfPresent() {
	path := os.Getenv("DAM_AGENT_ENV")
	if path == "" {
		path = defaultEnvFilePath()
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	n := 0
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if k == "" {
			continue
		}
		if _, exists := os.LookupEnv(k); !exists {
			os.Setenv(k, v)
			n++
		}
	}
	log.Printf("loaded %d config entries from %s", n, path)
}
