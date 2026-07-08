#!/usr/bin/env bash
# MySQL 8 install on Ubuntu 22.04. Runs once at first boot.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

# Idempotency guard so re-runs don't reinstall.
if [ -f /var/lib/dam/mysql-bootstrapped ]; then
  exit 0
fi
mkdir -p /var/lib/dam

apt-get update -y
apt-get install -y mysql-server

# Listen on the private interface so other VMs in the subnet can connect.
sed -i 's/^bind-address.*/bind-address = 0.0.0.0/' /etc/mysql/mysql.conf.d/mysqld.cnf || true

systemctl enable mysql
systemctl restart mysql

# NOTE: set a real root password / create app users here, ideally pulling the
# secret from Secret Manager rather than hardcoding. Example scaffold:
#
#   ROOT_PW="$(gcloud secrets versions access latest --secret=mysql-root-pw)"
#   mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY '${ROOT_PW}';"
#   mysql -e "CREATE DATABASE IF NOT EXISTS appdb;"

touch /var/lib/dam/mysql-bootstrapped
