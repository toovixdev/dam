#!/usr/bin/env bash
# Oracle Database 21c Express Edition (XE) on Oracle Linux 8. Runs once at boot.
# Oracle XE is free to use. It needs >= 2 GB RAM (we default the VM to 8 GB).
set -euxo pipefail

if [ -f /var/lib/dam/oracle-bootstrapped ]; then
  exit 0
fi
mkdir -p /var/lib/dam

# Preinstall package sets kernel params, limits, and the 'oracle' user.
dnf install -y oracle-database-preinstall-21c

# Oracle XE 21c RPM (freely downloadable from Oracle).
dnf install -y https://download.oracle.com/otn-pub/otn_software/db-express/oracle-database-xe-21c-1.0-1.ol8.x86_64.rpm

# Configure the database. This creates the CDB (XE) + PDB (XEPDB1) and the
# listener on 1521. SYS/SYSTEM passwords are set to the value below — replace
# with a Secret Manager lookup for anything real.
#
#   ORACLE_PW="$(gcloud secrets versions access latest --secret=oracle-sys-pw)"
ORACLE_PW="ChangeMe_$(openssl rand -hex 6)"
echo "Generated Oracle admin password (rotate this): ${ORACLE_PW}" > /root/oracle-initial-pw.txt
chmod 600 /root/oracle-initial-pw.txt

(echo "${ORACLE_PW}"; echo "${ORACLE_PW}") | /etc/init.d/oracle-xe-21c configure

systemctl enable oracle-xe-21c
systemctl start oracle-xe-21c

# Make the listener reachable on the private IP (default already binds all).
touch /var/lib/dam/oracle-bootstrapped
