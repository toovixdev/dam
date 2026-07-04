# JIT Broker Setup — Prerequisites & Runbook

Just-in-Time (JIT) access lets an approver grant a user **temporary, scoped,
auto-expiring** access to a client database. For this to work, DAM needs a
**broker** on that database — a *least-privilege* account whose credential lives
**only in Vault**, never in DAM's database, `.env`, or config.

> **A database only becomes offerable for JIT after a healthy broker is registered
> for it.** No broker ⇒ it does not appear in the JIT request dropdown.

This runbook is what a **DB owner** runs once per database. It is deliberately
*not* run by DAM.

---

## 0. What the broker may do — and may not
The broker needs exactly two capabilities, and nothing more:

1. **Create/drop login accounts** — to mint and remove the ephemeral JIT users.
2. **Grant *only* the privileges JIT may issue**, in *grantable* form (`WITH GRANT
   OPTION` / role `ADMIN OPTION`), scoped to the allowed schemas/objects.

It is **NOT** `root` / `SUPER` / a DBA. It cannot grant DBA, cannot reach schemas
outside its scope, cannot change server config. DAM's health check **refuses** a
broker that turns out to be over-privileged.

---

## 1. MySQL / MariaDB

Create the broker (reachable **only** from Vault's egress), scoped to just the
schema + privilege JIT should ever issue on this instance:

```sql
-- Broker restricted to Vault's network. Replace the host mask with your subnet.
CREATE USER 'dam_jit_payments'@'10.20.%'    IDENTIFIED BY '<strong-random-pw>';

-- (1) create/drop the ephemeral JIT users (CREATE USER priv also permits DROP USER)
GRANT CREATE USER ON *.* TO 'dam_jit_payments'@'10.20.%';

-- (2) ONLY the privilege JIT may hand out, in grantable form, scoped to the schema
GRANT SELECT ON payments.* TO 'dam_jit_payments'@'10.20.%' WITH GRANT OPTION;
--   add write ONLY if JIT should be allowed to grant it:
-- GRANT INSERT, UPDATE, DELETE ON payments.* TO 'dam_jit_payments'@'10.20.%' WITH GRANT OPTION;

FLUSH PRIVILEGES;
```

Verify it is correctly *narrow*:
```sql
SHOW GRANTS FOR 'dam_jit_payments'@'10.20.%';
-- must NOT contain: ALL PRIVILEGES ON *.*, GRANT OPTION ON *.*, or SUPER
```

## 2. PostgreSQL

```sql
-- (1) create/drop login roles
CREATE ROLE dam_jit_crm LOGIN PASSWORD '<strong-random-pw>' CREATEROLE;

-- (2) grantable read on the allowed scope (or use the role approach below)
GRANT SELECT ON ALL TABLES IN SCHEMA crm TO dam_jit_crm WITH GRANT OPTION;

-- Cleaner: pre-make a role and give the broker ADMIN OPTION on it, so the
-- broker itself need not hold the data privilege directly:
--   CREATE ROLE crm_read;
--   GRANT USAGE ON SCHEMA crm TO crm_read;
--   GRANT SELECT ON ALL TABLES IN SCHEMA crm TO crm_read;
--   GRANT crm_read TO dam_jit_crm WITH ADMIN OPTION;
```

> **PostgreSQL 16+** scopes `CREATEROLE` tightly (it can only manage roles it
> created and grant privileges it has admin option on) — prefer 16+.

Verify:
```sql
\du dam_jit_crm      -- must NOT show Superuser
```

---

## 3. Hand the broker credential to Vault (not to DAM)

DAM never sees this credential. Vault does — and rotates/mints from it. Configure
the Database secrets engine + a **scoped role** (the ceiling):

```sh
vault secrets enable -path=database database   # once

vault write database/config/payments-mysql \
  plugin_name=mysql-database-plugin \
  connection_url='{{username}}:{{password}}@tcp(<db-host>:3306)/' \
  allowed_roles="jit-payments-customers-read" \
  username="dam_jit_payments" password="<strong-random-pw>"

# The role defines EXACTLY what a minted JIT user can do (the ceiling):
vault write database/roles/jit-payments-customers-read \
  db_name=payments-mysql \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT ON payments.customers TO '{{name}}'@'%';" \
  revocation_statements="DROP USER '{{name}}'@'%';" \
  default_ttl="1h" max_ttl="24h"
```

> **Rotate the seed:** after configuring, run
> `vault write -f database/rotate-root/payments-mysql` so even the initial broker
> password is replaced by one only Vault knows.

*(In this dev repo, steps 1 + 3 are automated by `dev/dam/vault/bootstrap.sh`.)*

---

## 4. Register the broker in DAM

Access Governance → **Brokers** → *Add broker*:

| Field | Example |
|---|---|
| Engine / host / port | `mysql` · `client-mysql` · `3306` |
| Vault mount / role   | `database` / *(role name from step 3)* per scope |
| Allowed scopes       | `[{ id, label, privilege: read, schema: payments, object: customers, vault_role: jit-payments-customers-read }]` |
| Rate limit / hour    | `10` (circuit breaker) |

Then click **Run health check**. DAM asks Vault to mint a probe user, connects as
it, confirms it is **in-scope and not over-privileged**, and revokes it. Only a
`healthy` broker gates its database into the JIT dropdown.

---

## 5. Security model & caveats (read this)

- **Least privilege:** one broker per database, scoped to only the read/write
  JIT may issue. DAM's health check fails a broker that has `SUPER`/superuser or
  global grants.
- **No standing password in DAM:** the broker credential lives in Vault; DAM
  authenticates via **AppRole** and receives only short-lived, scoped, minted
  credentials per grant. Its bootstrap `secret_id` is delivered on a shared tmpfs
  — never in `.env` or the database.
- **The broker is powerful** (`CREATE USER`/`CREATEROLE`). Keep it **network-
  restricted to Vault, rotated (`rotate-root`), and audited.**
- **Compromise of DAM alone is insufficient:** provisioning requires a signature
  from the **Approval Signer** (a separate service whose key DAM never holds), so
  a compromised DAM can *request* but cannot *self-approve*. See the Approval
  Signer notes. It also cannot exceed the broker's scoped ceiling, and a per-DB
  **circuit breaker** trips + alerts on a burst of grants.
- **Honest dev limitation:** in this repo Vault runs in dev mode (in-memory) and
  the signer's key sits on a local volume; a *host-level* root compromise still
  reaches both. In production, use a real Vault (auto-unseal/HSM), platform
  identity for AppRole (K8s/cloud IAM — no stored `secret_id`), and put the signer
  in a separate trust domain (or use **Vault Control Groups** for M-of-N approval).
