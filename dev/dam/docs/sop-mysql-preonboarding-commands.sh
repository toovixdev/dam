#!/usr/bin/env bash
#
# sop-mysql-preonboarding-commands.sh
# Companion command sheet for docs/sop-mysql-preonboarding.md
#
# This is a REFERENCE runbook, not a one-shot installer. Some steps are interactive
# (mysql -p prompts) and some happen in the DAM console (Phase 5). Run phases one at a
# time and check each PASS criterion before moving on.
#
# Usage:
#   1. Edit the CONFIG block below (or export the vars in your shell first).
#   2. Source it:            source sop-mysql-preonboarding-commands.sh
#   3. Run a phase:          phase2   (or phase0, phase1, ... phase8, rollback)
#      Or just copy/paste the commands from the phase you need.
#
# NOTE: run the phases marked "[ON DB HOST]" on the MySQL box itself — AgentLite tails a
# local log file. The rest can run from any host with a mysql client + network reach.

set -uo pipefail

# ------------------------------------------------------------------ CONFIG ----
# Fill these in (or export them before sourcing this file).
: "${DB_HOST:=10.0.0.10}"                              # DB private IP/hostname (unique per DB)
: "${DB_ADMIN:=root}"                                  # a MySQL admin login (will be prompted for pw)
: "${DAM_URL:=https://dam.suchirasoistories.in}"            # control-plane URL
: "${ENROLL_TOKEN:=tvxenr_xxxxxxxxxxxxxxxxxxxx}"       # per-tenant token from the DAM console
: "${AUDIT_LOG:=/var/log/mysql/general.log}"           # general log path
: "${AGENT_IMAGE:=<your-dam-agent-image>}"             # e.g. registry.yourcompany.com/dam-agent:latest
: "${SVC_PW:=}"                                         # dam_svc password (leave blank to be prompted)
# ------------------------------------------------------------------------------

# admin mysql client — prompts for the admin password (never inline it: shell history)
myadmin() { mysql -h "$DB_HOST" -u "$DB_ADMIN" -p "$@"; }

_hdr() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

phase0() {  # Instance profile
  _hdr "Phase 0 — instance profile"
  myadmin -e "SELECT VERSION();"                       # 0.1 engine + version
  echo "-- 0.5 OS/kernel/arch (run this ON the DB host):"
  echo "   uname -srm"
}

phase1() {  # Capture-mode decision — per-connection TLS reality
  _hdr "Phase 1.3 — per-connection TLS (run while the app is live)"
  myadmin -e "
SELECT t.processlist_user AS usr, t.processlist_host AS src,
       COALESCE(NULLIF(s.variable_value,''),'(plaintext)') AS tls
FROM performance_schema.status_by_thread s
JOIN performance_schema.threads t ON t.thread_id = s.thread_id
WHERE s.variable_name = 'Ssl_cipher'
ORDER BY usr;"
  echo "PASS: you know per connection whether it's TLS or plaintext."
  echo "AgentLite captures either way; this only rules out a wire mode that can't see the traffic."
}

phase2() {  # MySQL server readiness
  _hdr "Phase 2.1 — version"
  myadmin -e "SELECT VERSION();"                       # PASS: 5.7/8.x or MariaDB 10.x

  _hdr "Phase 2.2a — enable general log to a FILE (runtime)"
  myadmin -e "
SET GLOBAL log_output      = 'FILE';
SET GLOBAL general_log_file = '$AUDIT_LOG';
SET GLOBAL general_log      = 'ON';"

  _hdr "Phase 2.2b — persist across restarts  [ON DB HOST]"
  cat <<EOF
sudo tee /etc/mysql/mysql.conf.d/zz-toovix-audit.cnf >/dev/null <<'CNF'
[mysqld]
log_output       = FILE
general_log      = 1
general_log_file = $AUDIT_LOG
CNF
# RHEL/Rocky: use /etc/my.cnf.d/ instead of /etc/mysql/mysql.conf.d/
EOF

  _hdr "Phase 2.3a — verify settings"
  myadmin -e "SHOW VARIABLES LIKE 'general_log%'; SHOW VARIABLES LIKE 'log_output';"

  _hdr "Phase 2.3b — verify it's writing (two shells)"
  cat <<EOF
# shell A:
sudo tail -f "$AUDIT_LOG"
# shell B:
mysql -h 127.0.0.1 -u "$DB_ADMIN" -p -e "SELECT 'dam-preflight', NOW();"
# PASS: the dam-preflight line appears in the tail.
EOF

  _hdr "Phase 2.4 — (optional) read-only monitoring user"
  local pw="$SVC_PW"
  if [ -z "$pw" ]; then read -rsp "New dam_svc password: " pw; echo; fi
  myadmin -e "
CREATE USER 'dam_svc'@'%' IDENTIFIED BY '$pw';
GRANT SELECT, PROCESS ON *.* TO 'dam_svc'@'%';
FLUSH PRIVILEGES;"
  myadmin -e "SHOW GRANTS FOR 'dam_svc'@'%';"          # PASS: SELECT, PROCESS only
  echo "-- login test:"
  mysql -h "$DB_HOST" -u dam_svc -p"$pw" -e "SELECT COUNT(*) FROM information_schema.columns;"
  echo "-- does the DB force TLS on connections?"
  myadmin -e "SHOW VARIABLES LIKE 'require_secure_transport';"
}

phase3() {  # Agent host readiness  [ON DB HOST]
  _hdr "Phase 3 — agent host readiness  [ON DB HOST]"
  uname -m                                             # 3.1 PASS: x86_64
  docker --version 2>/dev/null || echo "(no docker — use native .deb/.rpm)"
  systemctl --version >/dev/null 2>&1 && echo "systemd: yes"
  sudo test -r "$AUDIT_LOG" && echo "log readable" || echo "FIX perms (add CAP_DAC_READ_SEARCH / --user 0)"
  df -h /var/log
  ls -l /etc/logrotate.d/ | grep -i mysql || echo "(no mysql logrotate rule — add one)"
  echo "-- host(eBPF) mode only: kernel must be >= 5.8"; uname -r
}

phase4() {  # Network & connectivity  [ON AGENT/DB HOST]
  _hdr "Phase 4 — connectivity  [ON AGENT/DB HOST]"
  nc -zv "$DB_HOST" 3306                                                   # 4.1 DB reachable
  curl -sS -o /dev/null -w "egress http=%{http_code}\n" "$DAM_URL/api/health"  # 4.2 PASS: 200
  curl -sS -I "$DAM_URL/api/health" | head -1                             # 4.3 DNS/TLS clean
}

phase5() {  # Control plane — console only
  _hdr "Phase 5 — control-plane readiness (DAM console, no shell)"
  cat <<EOF
1. Confirm the client tenant/workspace exists (note its slug).
2. Agents -> Deploy monitoring -> AgentLite (Audit Forwarder) -> copy the tvxenr_ token.
3. Databases -> register instance with TARGET_HOST = $DB_HOST (unique per DB).
PASS: token starts tvxenr_ and belongs to THIS client's workspace.
EOF
}

phase6_docker() {  # Deploy — Docker  [ON DB HOST]
  _hdr "Phase 6 (Option A) — Docker deploy  [ON DB HOST]"
  docker run -d --name toovix-agent-audit --restart unless-stopped \
    --user 0 \
    -v "${AUDIT_LOG}:${AUDIT_LOG}:ro" \
    -e MODE=audit-forward \
    -e DB_ENGINE=mysql \
    -e TARGET_HOST="${DB_HOST}" \
    -e TARGET_PORT=3306 \
    -e AUDIT_SOURCE=general_log \
    -e AUDIT_LOG="${AUDIT_LOG}" \
    -e AGENT_ENROLL_TOKEN="${ENROLL_TOKEN}" \
    -e CONTROL_PLANE="${DAM_URL}" \
    "${AGENT_IMAGE}"
    # + classification: append  -e CLASSIFY=true -e DB_USER=dam_svc -e DB_PASSWORD=<pw>
  echo "-- watch it enroll:"
  echo "   docker logs -f toovix-agent-audit"
}

phase6_systemd() {  # Deploy — native .deb + systemd  [ON DB HOST]
  _hdr "Phase 6 (Option B) — native .deb + systemd  [ON DB HOST]"
  curl -fsSL "${DAM_URL}/api/download/dam-agent_amd64.deb" -o dam-agent.deb
  sudo dpkg -i dam-agent.deb
  sudo mkdir -p /etc/toovix
  sudo tee /etc/toovix/agent-audit.env >/dev/null <<EOF
MODE=audit-forward
DB_ENGINE=mysql
TARGET_HOST=${DB_HOST}
TARGET_PORT=3306
AUDIT_SOURCE=general_log
AUDIT_LOG=${AUDIT_LOG}
AGENT_ENROLL_TOKEN=${ENROLL_TOKEN}
CONTROL_PLANE=${DAM_URL}
EOF
  sudo systemctl enable --now dam-agent@audit
  echo "-- watch it enroll:"
  echo "   journalctl -u dam-agent@audit -f"
  echo "PASS: 'enrolled: agent=... instance=... tenant=...' + 'AgentLite audit-forward tailing ...general.log'"
}

phase7() {  # Verification
  _hdr "Phase 7 — smoke test"
  mysql -h 127.0.0.1 -u "$DB_ADMIN" -p -e "SELECT 'dam-verify-123', NOW();"
  echo "Now in the console: Databases -> your instance -> Database Activity -> see the SELECT (same workspace)."
}

phase8() {  # Handover hardening (shell bits)
  _hdr "Phase 8 — handover"
  cat <<EOF
# 8.2 rotate dam_svc on handover:
mysql -h "$DB_HOST" -u "$DB_ADMIN" -p -e "ALTER USER 'dam_svc'@'%' IDENTIFIED BY '<new-strong-pw>';"
# 8.3 lock down the cleartext general log  [ON DB HOST]:
sudo chmod 640 "$AUDIT_LOG"
EOF
}

rollback() {
  _hdr "Rollback — clean removal"
  cat <<EOF
docker rm -f toovix-agent-audit                     # Option A
sudo systemctl disable --now dam-agent@audit        # Option B
mysql -h "$DB_HOST" -u "$DB_ADMIN" -p -e "SET GLOBAL general_log='OFF';"
sudo rm -f /etc/mysql/mysql.conf.d/zz-toovix-audit.cnf
mysql -h "$DB_HOST" -u "$DB_ADMIN" -p -e "DROP USER 'dam_svc'@'%';"
EOF
}

# If executed directly (not sourced), print how to use it.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  cat <<EOF
This is a reference runbook. Source it, then run a phase:
  source ${0##*/}
  phase0 ; phase1 ; phase2 ; phase3 ; phase4 ; phase5
  phase6_docker    # or phase6_systemd
  phase7 ; phase8 ; rollback
Edit the CONFIG block (or export DB_HOST/DAM_URL/ENROLL_TOKEN/... first).
EOF
fi
