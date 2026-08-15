#!/usr/bin/env bash
#
# sop-postgres-network-agent-commands.sh
# Companion command sheet for docs/sop-postgres-network-agent.md
#
# Network (passive AF_PACKET) capture for PostgreSQL on a VM. Decodes the wire protocol in the
# CLEAR — so it needs PLAINTEXT traffic over TCP. No eBPF/kernel requirement, no DB/app changes.
#
# REFERENCE runbook, not a one-shot installer. Run it ON the Postgres VM:
#   source sop-postgres-network-agent-commands.sh
#   prechecks            # A-E; do F (token) in the DAM console
#   install_deb          # or install_docker
#   verify
# Edit the CONFIG block (or export the vars) first.

set -uo pipefail

# ------------------------------------------------------------------ CONFIG ----
: "${CONTROL_PLANE:=https://dam.suchirasoistories.in}"    # control-plane URL
: "${ENROLL_TOKEN:=tvxenr_xxxxxxxxxxxxxxxxxxxx}"           # per-tenant token (DAM console)
: "${DB_VM_HOST:=10.0.0.30}"                               # this VM's private IP (unique per DB)
: "${DB_PORT:=5432}"
: "${DB_NAME:=yourdb}"                                     # for the plaintext/TCP checks
: "${DB_SUPERUSER:=postgres}"                              # a psql login for the checks
: "${CAPTURE_IFACE:=any}"                                  # eth0 / ens5 / lo / any (pre-check D)
: "${AGENT_IMAGE:=<your-dam-agent-image>}"
# ------------------------------------------------------------------------------

_hdr() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

prechecks() {  # Part 1 A-E  [ON DB HOST]
  _hdr "A. host & privileges (no eBPF/kernel reqs for network mode)"
  echo -n "arch: "; uname -m           # PASS: x86_64
  echo -n "uid:  "; id -u              # PASS: 0 or sudo

  _hdr "B. traffic PLAINTEXT? network mode can't read TLS (want ssl=f)"
  sudo -u "$DB_SUPERUSER" psql -tAc "SHOW ssl;"
  sudo -u "$DB_SUPERUSER" psql -d "$DB_NAME" -c \
    "SELECT s.ssl, count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a ON a.pid=s.pid WHERE a.backend_type='client backend' GROUP BY s.ssl;"
  echo "PASS: app rows ssl=f. ssl=t sessions are opaque -> host mode for those."

  _hdr "C. traffic over TCP? (unix-socket = no packets to sniff)"
  sudo -u "$DB_SUPERUSER" psql -d "$DB_NAME" -c \
    "SELECT COALESCE(host(client_addr)::text,'unix-socket') AS conn, count(*) FROM pg_stat_activity WHERE backend_type='client backend' GROUP BY 1;"
  echo "PASS: app rows show an IP. 'unix-socket' only -> use AgentLite."

  _hdr "D. which interface carries the app<->DB packets? (#1 cause of 0 events)"
  echo "-- peers connected to ${DB_PORT}:"
  ss -tnH state established "( sport = :${DB_PORT} )" 2>/dev/null | awk '{print $4"  <-  "$5}'
  echo "-- this host's interfaces:"
  ip -o -4 addr show | awk '{print $2, $4}'
  echo "Set CAPTURE_IFACE: remote peers -> that NIC; 127.0.0.1 -> lo; unsure/mixed -> any."

  _hdr "E. egress to control plane"
  curl -sS -o /dev/null -w "egress=%{http_code}\n" "$CONTROL_PLANE/api/health"   # PASS: 200

  _hdr "F. (DAM console) Agents -> Deploy monitoring -> Network: copy tvxenr_ token; register instance"
}

install_deb() {  # Part 2 Option A  [ON DB HOST]
  _hdr "install via .deb + systemd (CAPTURE_IFACE=${CAPTURE_IFACE})"
  curl -fsSL "${CONTROL_PLANE}/api/download/dam-agent_amd64.deb" -o dam-agent.deb
  sudo dpkg -i dam-agent.deb
  sudo mkdir -p /etc/toovix
  sudo tee /etc/toovix/agent-network.env >/dev/null <<EOF
MODE=network
DB_ENGINE=postgresql
TARGET_HOST=${DB_VM_HOST}
TARGET_PORT=${DB_PORT}
CAPTURE_IFACE=${CAPTURE_IFACE}
AGENT_ENROLL_TOKEN=${ENROLL_TOKEN}
CONTROL_PLANE=${CONTROL_PLANE}
# CAPTURE_DEBUG=true   # uncomment to log "N frames seen on <iface>" while troubleshooting
EOF
  sudo systemctl enable --now dam-agent@network
  echo "-- watch it start:  journalctl -u dam-agent@network -f"
  echo "PASS: 'network agent sniffing ${CAPTURE_IFACE} for tcp/${DB_PORT} engine=postgresql' + [capture] lines"
}

install_docker() {  # Part 2 Option B  [ON DB HOST]
  _hdr "install via Docker (host network required)"
  docker run -d --name toovix-agent-network --restart unless-stopped \
    --network host --cap-add NET_RAW --cap-add NET_ADMIN \
    -e MODE=network \
    -e DB_ENGINE=postgresql \
    -e TARGET_HOST="${DB_VM_HOST}" \
    -e TARGET_PORT="${DB_PORT}" \
    -e CAPTURE_IFACE="${CAPTURE_IFACE}" \
    -e AGENT_ENROLL_TOKEN="${ENROLL_TOKEN}" \
    -e CONTROL_PLANE="${CONTROL_PLANE}" \
    "${AGENT_IMAGE}"
  echo "-- watch it start:  docker logs -f toovix-agent-network"
}

verify() {  # Part 3 — over TCP; match CAPTURE_IFACE (VM IP for a NIC, 127.0.0.1 for lo/any)
  _hdr "verify over TCP (plaintext)"
  psql "host=${DB_VM_HOST} port=${DB_PORT} dbname=${DB_NAME} sslmode=disable" \
    -c "SELECT 'dam-net-verify-123', now();"
  echo "Now: DAM console -> Databases -> your instance -> Database Activity (same workspace as the token)."
  echo "No event? set CAPTURE_DEBUG=true; 0 frames = wrong CAPTURE_IFACE (try 'any')."
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  cat <<EOF
Reference runbook. Source it, then run a step:
  source ${0##*/}
  prechecks
  install_deb        # or install_docker
  verify
Edit the CONFIG block (or export CONTROL_PLANE/ENROLL_TOKEN/DB_VM_HOST/CAPTURE_IFACE/... first).
Network mode needs PLAINTEXT over TCP: if traffic is TLS use host mode; if unix-socket use AgentLite.
EOF
fi
