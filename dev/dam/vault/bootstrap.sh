#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
#  TooVix DAM — Vault bootstrap (dev)
#  Configures Vault so the DAM API holds NO database password:
#   1. Provisions a LEAST-PRIVILEGE broker account on the client DB (the runbook
#      step, automated for the dev demo — NOT root).
#   2. Enables the Database secrets engine; Vault holds the broker credential.
#   3. Defines a scoped JIT role (the ceiling) that mints short-lived read users.
#   4. Creates an AppRole for the DAM API and drops role_id + secret_id onto a
#      shared tmpfs (the only bootstrap identity DAM ever reads; off .env / DB).
# ─────────────────────────────────────────────────────────────────────────────
set -e
export VAULT_ADDR="${VAULT_ADDR:-http://dam-vault:8200}"
export VAULT_TOKEN="${VAULT_BOOTSTRAP_TOKEN:-root}"
BROKER_PW="${BROKER_MYSQL_PASSWORD:-broker-payments-pw}"

echo "[bootstrap] installing mysql-client..."
apk add --no-cache mysql-client >/dev/null 2>&1 || true

echo "[bootstrap] waiting for Vault..."
until vault status >/dev/null 2>&1; do sleep 1; done

echo "[bootstrap] waiting for client-mysql..."
until mysqladmin ping -h client-mysql --silent >/dev/null 2>&1; do sleep 1; done

# 1) LEAST-PRIVILEGE broker account on the client DB (NOT root):
#    CREATE USER + SELECT ON payments.* WITH GRANT OPTION (so Vault can mint
#    read-only users). It deliberately holds nothing beyond that.
echo "[bootstrap] provisioning broker account dam_jit_payments on client-mysql..."
# NOTE: Alpine ships the MariaDB client, which cannot speak MySQL 8's
# caching_sha2_password. This step is therefore best-effort here — in a real
# deployment the DB owner runs the SQL from the runbook. Vault's Go driver has
# no such limitation and connects fine below. Non-fatal so bootstrap proceeds.
mysql -h client-mysql -uroot -p"${CLIENT_MYSQL_ROOT_PASSWORD}" 2>/dev/null <<SQL || echo "[bootstrap] (CLI account step skipped — ensure the broker account exists per runbook)"
CREATE USER IF NOT EXISTS 'dam_jit_payments'@'%' IDENTIFIED BY '${BROKER_PW}';
ALTER USER 'dam_jit_payments'@'%' IDENTIFIED BY '${BROKER_PW}';
GRANT CREATE USER ON *.* TO 'dam_jit_payments'@'%';
GRANT SELECT ON payments.* TO 'dam_jit_payments'@'%' WITH GRANT OPTION;
FLUSH PRIVILEGES;
SQL

# 2) Database secrets engine — Vault holds the broker credential from here on.
echo "[bootstrap] configuring Vault database secrets engine..."
vault secrets enable -path=database database 2>/dev/null || true
vault write database/config/payments-mysql \
  plugin_name=mysql-database-plugin \
  connection_url='{{username}}:{{password}}@tcp(client-mysql:3306)/' \
  allowed_roles="jit-payments-customers-read,jit-payments-read-all" \
  username="dam_jit_payments" \
  password="${BROKER_PW}"

# 3) Scoped JIT roles = the ceiling. Two granularities: one table, or the whole
#    schema (payments.*). Neither can reach outside payments (system tables denied).
vault write database/roles/jit-payments-customers-read \
  db_name=payments-mysql \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT ON payments.customers TO '{{name}}'@'%';" \
  revocation_statements="DROP USER '{{name}}'@'%';" \
  default_ttl="1h" max_ttl="24h"
vault write database/roles/jit-payments-read-all \
  db_name=payments-mysql \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT ON payments.* TO '{{name}}'@'%';" \
  revocation_statements="DROP USER '{{name}}'@'%';" \
  default_ttl="1h" max_ttl="24h"

# 3b) Second instance — client-mysql-2 / inventory (broker account comes from its
#     init.sql). Scoped role mints a user that can ONLY read inventory.items.
echo "[bootstrap] waiting for client-mysql-2..."
until mysqladmin ping -h client-mysql-2 -P 3307 --silent >/dev/null 2>&1; do sleep 1; done
vault write database/config/inventory-mysql \
  plugin_name=mysql-database-plugin \
  connection_url='{{username}}:{{password}}@tcp(client-mysql-2:3307)/' \
  allowed_roles="jit-inventory-items-read,jit-inventory-read-all" \
  username="dam_jit_inventory" \
  password="${BROKER_INVENTORY_PASSWORD:-broker-inventory-pw}"
vault write database/roles/jit-inventory-items-read \
  db_name=inventory-mysql \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT ON inventory.items TO '{{name}}'@'%';" \
  revocation_statements="DROP USER '{{name}}'@'%';" \
  default_ttl="1h" max_ttl="24h"
vault write database/roles/jit-inventory-read-all \
  db_name=inventory-mysql \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT ON inventory.* TO '{{name}}'@'%';" \
  revocation_statements="DROP USER '{{name}}'@'%';" \
  default_ttl="1h" max_ttl="24h"

# 4) AppRole for the DAM API — least-privilege policy (read only these creds + revoke).
echo "[bootstrap] configuring AppRole for dam-api..."
vault auth enable approle 2>/dev/null || true
cat > /tmp/jit-policy.hcl <<POL
path "database/creds/jit-*" { capabilities = ["read"] }
path "sys/leases/revoke"    { capabilities = ["update"] }
POL
vault policy write dam-jit /tmp/jit-policy.hcl
vault write auth/approle/role/dam-api \
  token_policies="dam-jit" token_ttl=20m token_max_ttl=1h \
  secret_id_ttl=0 secret_id_num_uses=0

ROLE_ID=$(vault read -field=role_id auth/approle/role/dam-api/role-id)
SECRET_ID=$(vault write -field=secret_id -f auth/approle/role/dam-api/secret-id)

# 5) Deliver the bootstrap identity to DAM via shared tmpfs. role_id is non-secret;
#    secret_id is DAM's single "secret zero" — never in .env or the database.
mkdir -p /vault-bootstrap
printf '%s' "${ROLE_ID}"   > /vault-bootstrap/role_id
printf '%s' "${SECRET_ID}" > /vault-bootstrap/secret_id
chmod 0640 /vault-bootstrap/role_id /vault-bootstrap/secret_id
echo "[bootstrap] complete — role_id + secret_id written to shared volume."
echo "[bootstrap] DAM holds no DB password; the broker credential lives only in Vault."
