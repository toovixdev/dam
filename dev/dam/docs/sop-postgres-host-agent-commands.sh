#!/usr/bin/env bash
#
# sop-postgres-host-agent-commands.sh
# Companion command sheet for docs/sop-postgres-host-agent.md
#
# Host (eBPF) capture for PostgreSQL on a VM. Reads plaintext BELOW TLS via libssl uprobes,
# so it ONLY works when the DB uses TLS and the app connects over TLS (pre-checks C & D).
#
# REFERENCE runbook, not a one-shot installer. Run it ON the Postgres VM:
#   source sop-postgres-host-agent-commands.sh
#   prechecks           # A-E; do F (token) in the DAM console
#   install_deb         # or install_docker
#   verify
# Edit the CONFIG block (or export the vars) first.

set -uo pipefail

# ------------------------------------------------------------------ CONFIG ----
: "${CONTROL_PLANE:=https://dam.suchirasoistories.in}"    # control-plane URL
: "${ENROLL_TOKEN:=tvxenr_xxxxxxxxxxxxxxxxxxxx}"           # per-tenant token (DAM console)
: "${DB_VM_HOST:=10.0.0.30}"                               # this VM's private IP (unique per DB)
: "${DB_PORT:=5432}"
: "${DB_NAME:=yourdb}"                                     # for the verify/TLS checks
: "${DB_SUPERUSER:=postgres}"                              # a psql login for SHOW ssl / pg_stat_ssl
: "${AGENT_IMAGE:=<your-dam-agent-image>}"
: "${DB_PROC_COMM:=}"                                      # set ONLY if pgrep shows e.g. 'postmaster'
# ------------------------------------------------------------------------------

_hdr() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

prechecks() {  # Part 1 A-E  [ON DB HOST]
  _hdr "A. host & kernel (eBPF)"
  echo -n "arch:   "; uname -m         # PASS: x86_64
  echo -n "kernel: "; uname -r         # PASS: >= 5.8
  ls -l /sys/kernel/btf/vmlinux 2>/dev/null && echo "BTF ✓" || echo "BTF MISSING"
  echo -n "uid:    "; id -u

  _hdr "B. postgres process discoverable"
  if pgrep -x postgres >/dev/null; then pgrep -x postgres | tr '\n' ' '; echo "(comm=postgres ✓)"
  else echo "no 'postgres' comm — check 'postmaster' and set DB_PROC_COMM"; pgrep -x postmaster; fi

  _hdr "C. TLS enabled AND libssl mapped (make-or-break)"
  sudo -u "$DB_SUPERUSER" psql -tAc "SHOW ssl;" 2>/dev/null    # PASS: on
  local pid; pid=$(pgrep -x postgres | head -1)
  if [ -n "${pid:-}" ] && sudo grep -lq libssl /proc/"$pid"/maps 2>/dev/null; then
    echo "libssl mapped ✓"; else echo "NO libssl — host mode will capture NOTHING"; fi

  _hdr "D. does the app connect over TLS? (need ssl=t)"
  sudo -u "$DB_SUPERUSER" psql -d "$DB_NAME" -c \
    "SELECT s.ssl, count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a ON a.pid=s.pid WHERE a.backend_type='client backend' GROUP BY s.ssl;"
  echo "PASS: your app rows show ssl = t. ssl=f (plaintext) or unix-socket -> use network mode instead."

  _hdr "E. egress to control plane"
  curl -sS -o /dev/null -w "egress=%{http_code}\n" "$CONTROL_PLANE/api/health"   # PASS: 200

  _hdr "F. (DAM console) Agents -> Deploy monitoring -> Host (eBPF): copy tvxenr_ token; register instance"
}

enable_tls() {  # Appendix A — enable Postgres TLS when SHOW ssl = off (run as ROOT)
  _hdr "Appendix A — enable PostgreSQL TLS"
  echo "⚠ changes DB config AND requires the app's DSN to move to sslmode=require. Maintenance window!"
  local PGDATA; PGDATA=$(sudo -u "$DB_SUPERUSER" psql -tAc "SHOW data_directory;")
  echo "data_directory: $PGDATA"
  echo "-- A2. create self-signed server cert/key (idempotent-ish; skips if present):"
  if [ ! -f "$PGDATA/server.key" ]; then
    ( cd "$PGDATA" && openssl req -new -x509 -days 825 -nodes -text \
        -out server.crt -keyout server.key -subj "/CN=$(hostname)" )
    chown postgres:postgres "$PGDATA/server.key" "$PGDATA/server.crt"
    chmod 600 "$PGDATA/server.key"
    echo "created server.crt/server.key (key chmod 600)"
  else
    echo "server.key already exists — leaving it"
  fi
  echo "-- A3. enable ssl + reload:"
  sudo -u "$DB_SUPERUSER" psql -c "ALTER SYSTEM SET ssl = 'on';"
  sudo -u "$DB_SUPERUSER" psql -c "SELECT pg_reload_conf();"
  sudo -u "$DB_SUPERUSER" psql -tAc "SHOW ssl;"     # want: on (else: systemctl restart postgresql)
  cat <<'EOT'
-- A4. NOW move the app onto TLS (mandatory), then restart the app:
     postgresql://user:pass@dbhost:5432/yourdb?sslmode=require
     JDBC: jdbc:postgresql://dbhost:5432/yourdb?ssl=true&sslmode=require
-- (optional hardening, AFTER app is on TLS) force it in pg_hba.conf: change 'host' -> 'hostssl'
     then: sudo -u postgres psql -c "SELECT pg_reload_conf();"
-- A5. re-run:  prechecks   (need SHOW ssl=on, libssl mapped, app rows ssl=t) then install_deb
EOT
}

install_deb() {  # Part 2 Option A  [ON DB HOST]
  _hdr "install via .deb + systemd"
  curl -fsSL "${CONTROL_PLANE}/api/download/dam-agent_amd64.deb" -o dam-agent.deb
  sudo dpkg -i dam-agent.deb
  sudo mkdir -p /etc/toovix
  {
    echo "MODE=host"
    echo "DB_ENGINE=postgresql"
    echo "TARGET_HOST=${DB_VM_HOST}"
    echo "TARGET_PORT=${DB_PORT}"
    echo "AGENT_ENROLL_TOKEN=${ENROLL_TOKEN}"
    echo "CONTROL_PLANE=${CONTROL_PLANE}"
    [ -n "$DB_PROC_COMM" ] && echo "DB_PROC_COMM=${DB_PROC_COMM}"
  } | sudo tee /etc/toovix/agent-host.env >/dev/null
  sudo systemctl enable --now dam-agent@host
  echo "-- watch it attach:"
  echo "   journalctl -u dam-agent@host -f"
  echo 'PASS: host: DB process "postgres" pid=... uses .../libssl.so + attached uprobe SSL_write'
}

install_docker() {  # Part 2 Option B  [ON DB HOST]
  _hdr "install via Docker (host namespaces)"
  docker run -d --name toovix-agent-host --restart unless-stopped \
    --privileged --pid host --network host \
    -e MODE=host \
    -e DB_ENGINE=postgresql \
    -e TARGET_HOST="${DB_VM_HOST}" \
    -e TARGET_PORT="${DB_PORT}" \
    ${DB_PROC_COMM:+-e DB_PROC_COMM="${DB_PROC_COMM}"} \
    -e AGENT_ENROLL_TOKEN="${ENROLL_TOKEN}" \
    -e CONTROL_PLANE="${CONTROL_PLANE}" \
    "${AGENT_IMAGE}"
  echo "-- watch it attach:  docker logs -f toovix-agent-host"
}

verify() {  # Part 3 — MUST be TCP + TLS (unix-socket local psql won't show)
  _hdr "verify over TCP+TLS"
  psql "host=${DB_VM_HOST} port=${DB_PORT} dbname=${DB_NAME} sslmode=require" \
    -c "SELECT 'dam-host-verify-123', now();"
  echo "Now: DAM console -> Databases -> your instance -> Database Activity (same workspace as the token)."
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  cat <<EOF
Reference runbook. Source it, then run a step:
  source ${0##*/}
  prechecks
  enable_tls         # ONLY if SHOW ssl = off and you want to stay on host mode (Appendix A)
  install_deb        # or install_docker
  verify
Edit the CONFIG block (or export CONTROL_PLANE/ENROLL_TOKEN/DB_VM_HOST/... first).
Host mode is TLS-only: if pre-check C/D fail, either enable_tls (+ move the app to sslmode=require)
or switch to network mode / AgentLite instead.
EOF
fi
