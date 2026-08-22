#!/usr/bin/env bash
# Turn THIS Linux VM into a simulated on-prem MySQL server monitored by SecurEra DAM.
# Installs MySQL, enables its general query log (the AgentLite audit source), seeds a
# realistic app schema with PII/PCI, then installs and starts the DAM AgentLite agent
# (audit-forward) which ships activity to your DAM control plane over HTTPS.
#
# Run INSIDE the Ubuntu VM (needs sudo):
#   ENROLL_TOKEN=tvxenr_xxx ./setup-onprem.sh
set -euo pipefail

CONTROL_PLANE="${CONTROL_PLANE:-https://dam.suchirasoistories.in}"
ENROLL_TOKEN="${ENROLL_TOKEN:?Set ENROLL_TOKEN — DAM console: Agents -> Deploy monitoring -> AgentLite}"
# How this instance is identified in DAM. Default: the VM's primary IP (realistic + always
# reachable). MySQL is bound to 0.0.0.0 below so classification can connect to it.
DB_IDENTITY="${DB_IDENTITY:-$(hostname -I | awk '{print $1}')}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> [1/5] Installing MySQL server..."
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq mysql-server curl

echo "==> [2/5] Enabling the general query log + binding MySQL for classification..."
sudo mkdir -p /var/log/mysql
sudo chown mysql:mysql /var/log/mysql
sudo tee /etc/mysql/mysql.conf.d/zz-toovix-audit.cnf >/dev/null <<'EOF'
[mysqld]
log_output       = FILE
general_log      = 1
general_log_file = /var/log/mysql/general.log
bind-address     = 0.0.0.0
EOF
sudo systemctl restart mysql

echo "==> [3/5] Seeding app schema + sensitive data + monitoring/app logins..."
sudo mysql < "$HERE/seed.sql"

echo "==> [4/5] Installing the SecurEra DAM agent (.deb) from the control plane..."
curl -fsSL "$CONTROL_PLANE/api/download/dam-agent_amd64.deb" -o /tmp/dam-agent.deb
sudo dpkg -i /tmp/dam-agent.deb || sudo apt-get -f install -y

echo "==> [5/5] Configuring + starting the AgentLite (audit-forward) instance..."
sudo mkdir -p /etc/toovix
sudo tee /etc/toovix/agent-onprem.env >/dev/null <<EOF
MODE=audit-forward
DB_ENGINE=mysql
AUDIT_SOURCE=general_log
AUDIT_LOG=/var/log/mysql/general.log
TARGET_HOST=$DB_IDENTITY
TARGET_PORT=3306
TARGET_DB=MYSQL-ONPREM-LAPTOP
CLASSIFY=true
DB_NAME=appdb
DB_USER=dam_svc
DB_PASSWORD=dam_svc_secret
AGENT_ENROLL_TOKEN=$ENROLL_TOKEN
CONTROL_PLANE=$CONTROL_PLANE
EOF
sudo systemctl enable --now dam-agent@onprem
sleep 3

echo
echo "Instance identity in DAM: $DB_IDENTITY  (label: MYSQL-ONPREM-LAPTOP)"
sudo systemctl --no-pager --full status dam-agent@onprem | head -8 || true
echo
echo "Watch the agent:     sudo journalctl -u dam-agent@onprem -f"
echo "Generate activity:   $HERE/gen-traffic.sh"
echo "Then open DAM -> Databases -> MYSQL-ONPREM-LAPTOP -> Database Activity."
