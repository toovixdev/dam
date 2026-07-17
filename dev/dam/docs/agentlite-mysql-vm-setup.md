# Connect a Self-Managed Database to TooVix DAM — AgentLite Setup Guide

**Audience:** a customer/operator with a **MySQL or PostgreSQL database running on a Linux VM** in **GCP, AWS, or Azure** who wants it monitored by TooVix DAM using the **AgentLite (audit-forward)** approach. **SQL Server** takes a different path — see §2.

**Time:** ~15–20 minutes. **Access needed:** `sudo`/root on the DB VM, and DB admin to enable auditing.

---

## 1. What AgentLite is (and what it isn't)

**AgentLite** is a lightweight forwarder you install **on the database host**. It **tails the database's own audit log** — MySQL's general query log or PostgreSQL's statement log — and ships each statement to TooVix DAM.

- ✅ **No wire tap, no proxy, no path change** — it reads a log file the database already writes.
- ✅ **Transport-independent** — because it reads what the DB logs *after* decryption, it captures **TLS-encrypted** client sessions too.
- ✅ **Works on private, no-public-IP databases** — the agent only makes **outbound** connections to DAM; DAM never connects into your network.
- ⚠️ **Detective only** — it observes and alerts **after the fact**; it **cannot block** a query. (Use Inline Proxy mode if you need prevention.)
- ⚠️ **Records all SQL** — the MySQL general log captures every statement from every session in cleartext on the VM. Treat the log file as sensitive (see §9).

**Flow:**
```
DB audit log  →  AgentLite forwarder (on the DB VM)  →  TooVix DAM  →  Database Activity view
 (MySQL general log / PostgreSQL log)   (HTTPS, or an audit stream)
```

**Requirements:**
- Linux VM, **x86-64 (amd64)**. (arm64 / Graviton is not supported yet.)
- **MySQL 5.7 / 8.x, MariaDB 10.x, or PostgreSQL 12+.**
- **Outbound HTTPS (443)** from the VM to your DAM control-plane URL. See §7 for per-cloud egress.

> **SQL Server?** AgentLite audit-forward doesn't apply — SQL Server Audit is a **binary** `.sqlaudit` trail (read via `sys.fn_get_audit_file`), not a text log a forwarder can tail. For **Azure SQL / managed SQL Server**, use the **Agentless** path (database-level Auditing → Event Hub → DAM). See §2 → SQL Server.

---

## 2. Step 1 — Enable the native audit log (choose your engine)

AgentLite tails a log the database writes. Enable it for your engine at a known path — you'll pass that path as `AUDIT_LOG` in §5.

### 🐬 MySQL / MariaDB — general query log

As MySQL admin, write the general log to a FILE at a fixed path:

```sql
-- runtime (takes effect now):
SET GLOBAL log_output      = 'FILE';
SET GLOBAL general_log_file = '/var/log/mysql/general.log';
SET GLOBAL general_log      = 'ON';
```

Persist it across restarts (the `SET GLOBAL` above is runtime-only):

```bash
# Debian/Ubuntu: /etc/mysql/mysql.conf.d/  ·  RHEL/Rocky: /etc/my.cnf.d/
sudo tee /etc/mysql/mysql.conf.d/zz-toovix-audit.cnf >/dev/null <<'EOF'
[mysqld]
log_output       = FILE
general_log      = 1
general_log_file = /var/log/mysql/general.log
EOF
```

Agent settings → `DB_ENGINE=mysql` · `AUDIT_SOURCE=general_log` · `AUDIT_LOG=/var/log/mysql/general.log` · `TARGET_PORT=3306`

### 🐘 PostgreSQL — statement logging

AgentLite parses PostgreSQL's **standard statement log**. Turn on statement logging and set the exact `log_line_prefix` the parser expects, then reload — **no restart needed**:

```bash
sudo -u postgres psql -c "ALTER SYSTEM SET log_statement = 'all';"
sudo -u postgres psql -c "ALTER SYSTEM SET log_line_prefix = '%m [%p] %u@%d ';"
sudo -u postgres psql -c "SELECT pg_reload_conf();"
```

> **The `log_line_prefix` matters.** AgentLite matches lines shaped `<time> [pid] user@db LOG:  statement: …`. If your prefix differs, statements won't be parsed. This uses PostgreSQL's **built-in** logging; the **pgaudit** extension is **not** required.

The file is the cluster's main log, e.g. `/var/log/postgresql/postgresql-16-main.log` (match your PG major version).
Agent settings → `DB_ENGINE=postgresql` · `AUDIT_SOURCE=pgaudit` · `AUDIT_LOG=/var/log/postgresql/postgresql-<ver>-main.log` · `TARGET_PORT=5432`

### 🪟 SQL Server — use *Agentless*, not AgentLite

AgentLite **doesn't support SQL Server**: SQL Server Audit writes a **binary** `.sqlaudit` trail (read via `sys.fn_get_audit_file`), not a text log a forwarder can tail. Instead:

- **Azure SQL / SQL Managed Instance (PaaS):** use **Agentless** — enable **database-level Auditing → Event Hub**, and the DAM connector consumes it (verified ~2-min end-to-end):
  ```bash
  az sql db audit-policy update -g <RG> -s <SERVER> -n <DB> \
    --state Enabled --event-hub-target-state Enabled \
    --event-hub <HUB> --event-hub-authorization-rule-id <SEND_RULE_ID> \
    --actions BATCH_COMPLETED_GROUP SUCCESSFUL_DATABASE_AUTHENTICATION_GROUP
  ```
  **Must be *database*-level** — server-level auditing with a DB-scoped diagnostic setting captures nothing.
- **SQL Server on a VM (self-managed):** AgentLite audit-forward for SQL Server is **on the roadmap** (needs a `sys.fn_get_audit_file` / Windows Event-Log collector). For now use network / inline-proxy capture.

**Classification works for SQL Server regardless** — it uses a read-only login over TDS, not the audit log.

> **Verify (MySQL/PG):** `sudo tail -f <AUDIT_LOG>` and run a query elsewhere — lines should appear. AgentLite tails the live file and handles rotation/truncation automatically; ensure `logrotate` + disk headroom on busy DBs.

---

## 3. Step 2 — (Optional) Create a read-only user for classification

DAM can classify which columns hold PII/PCI. This is **separate from capture** — it logs into the database as a **least-privilege reader**. Skip this if you only want activity capture.

**MySQL / MariaDB:**
```sql
CREATE USER 'dam_svc'@'%' IDENTIFIED BY '<strong-password>';
GRANT SELECT, PROCESS ON *.* TO 'dam_svc'@'%';
FLUSH PRIVILEGES;
```

**PostgreSQL:**
```sql
CREATE USER dam_svc WITH PASSWORD '<strong-password>';
GRANT pg_monitor TO dam_svc;
GRANT CONNECT ON DATABASE <db> TO dam_svc;
\c <db>
GRANT USAGE ON SCHEMA public TO dam_svc;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dam_svc;
```

`dam_svc` is **read-only** — it inspects schema/metadata but can never modify data. Pass it as `DB_USER`/`DB_PASSWORD` with `CLASSIFY=true` (PostgreSQL also needs `DB_NAME`).

---

## 4. Step 3 — Get your enrollment token

In the **TooVix DAM console**:
1. Go to **Agents → Deploy monitoring** (or **Databases → register your instance**, then Deploy).
2. Select your instance and the **AgentLite (Audit Forwarder)** mode.
3. Copy the **enrollment token** shown (looks like `tvxenr_…`) and the **control-plane URL** (e.g. `https://dam.yourcompany.com`).

The token binds the agent to **your workspace/tenant**, so captured activity is attributed correctly. The console will also generate a ready-to-paste command — this guide explains each part so you can do it by hand.

---

## 5. Step 4 — Install & run the agent

Pick **one** install method. In all cases the agent needs to **read the general log** and **reach DAM over HTTPS**.

Set these once (used below):
```bash
CONTROL_PLANE="https://dam.yourcompany.com"          # from Step 3
ENROLL_TOKEN="tvxenr_xxxxxxxxxxxxxxxxxxxx"            # from Step 3
AUDIT_LOG="/var/log/mysql/general.log"               # from Step 1
DB_VM_HOST="10.0.0.10"                               # THIS VM's private IP / hostname
```

> **`DB_VM_HOST`** is how DAM identifies this database instance — use the VM's **private IP or hostname**, and make it **match the instance as registered in the DAM console**. It must be **unique per DB VM** (don't use `127.0.0.1`, or several VMs would collapse into one instance record). The agent still runs *on* this host and reads the local log; this value is the instance's identity (and where optional classification connects).

### Option A — Docker (simplest)

```bash
docker run -d --name toovix-agent-audit --restart unless-stopped \
  --user 0 \
  -v ${AUDIT_LOG}:${AUDIT_LOG}:ro \
  -e MODE=audit-forward \
  -e DB_ENGINE=mysql \
  -e TARGET_HOST=${DB_VM_HOST} \
  -e TARGET_PORT=3306 \
  -e AUDIT_SOURCE=general_log \
  -e AUDIT_LOG=${AUDIT_LOG} \
  -e AGENT_ENROLL_TOKEN=${ENROLL_TOKEN} \
  -e CONTROL_PLANE=${CONTROL_PLANE} \
  <your-dam-agent-image>            # e.g. registry.yourcompany.com/dam-agent:latest
```

### Option B — Native package (.deb / .rpm) + systemd

```bash
# Download the agent from your control plane
curl -fsSL ${CONTROL_PLANE}/api/download/dam-agent_amd64.deb -o dam-agent.deb   # Debian/Ubuntu
sudo dpkg -i dam-agent.deb
# RHEL/Rocky:  curl -fsSL ${CONTROL_PLANE}/api/download/dam-agent_amd64.rpm -o dam-agent.rpm && sudo dnf install -y ./dam-agent.rpm

# Configure this agent instance (the unit is templated: dam-agent@<name> reads /etc/toovix/agent-<name>.env)
sudo mkdir -p /etc/toovix
sudo tee /etc/toovix/agent-audit.env >/dev/null <<EOF
MODE=audit-forward
DB_ENGINE=mysql
TARGET_HOST=${DB_VM_HOST}
TARGET_PORT=3306
AUDIT_SOURCE=general_log
AUDIT_LOG=${AUDIT_LOG}
AGENT_ENROLL_TOKEN=${ENROLL_TOKEN}
CONTROL_PLANE=${CONTROL_PLANE}
EOF

sudo systemctl enable --now dam-agent@audit
journalctl -u dam-agent@audit -f     # watch it enroll + start tailing
```

> To also run **classification** (Step 2), add to the env / `-e` flags: `CLASSIFY=true`, `DB_USER=dam_svc`, `DB_PASSWORD=<the password you set>`.

**A healthy start looks like:**
```
=== TooVix DAM Agent · mode=audit-forward engine=mysql target=127.0.0.1:3306 ===
enrolled: agent=… instance=… tenant=…
AgentLite audit-forward tailing /var/log/mysql/general.log (source=general_log engine=mysql)
[capture] SELECT  rows=…  <user>  SELECT …
```

---

## 6. Step 5 — Verify

1. Run a distinctive query against MySQL (over **TCP**, so it's logged):
   ```bash
   mysql -h 127.0.0.1 -u <someuser> -p -e "SELECT 'dam-verify-123', NOW();"
   ```
2. In the DAM console, open **Databases → your instance → Database Activity** (make sure you're in the **same workspace** the enrollment token belongs to).
3. Within a few seconds you should see `SELECT 'dam-verify-123'…` attributed to your DB and principal.

If it appears — **you're done.** AgentLite is capturing.

---

## 7. Per-cloud notes (egress + the private-VM case)

The core steps above are **identical on GCP, AWS, and Azure.** The only cloud-specific concern is making sure the VM can reach DAM over **outbound HTTPS (443)** — especially for **private (no public IP)** databases.

| Cloud | Give the private DB VM outbound HTTPS | Notes |
|-------|----------------------------------------|-------|
| **GCP** | **Cloud NAT** on the VPC/subnet (or an external IP) | Egress firewall allows outbound by default. Reach private VMs to install via **IAP** SSH. |
| **AWS** | **NAT Gateway** + a route from the private subnet; Security Group **outbound 443** (default SG allows all egress) | Reach private VMs via **SSM Session Manager**. |
| **Azure** | Default outbound or a **NAT Gateway**; NSG **outbound 443** (default `AllowInternetOutBound`) | Reach private VMs via a **jump-box / Bastion**. |

The agent **only dials out** — DAM never initiates a connection into your network, so no inbound rules are required for monitoring.

---

## 8. (Optional) Publish to an audit stream instead of direct HTTPS

Instead of POSTing events to DAM over HTTPS (§5), the forwarder can **publish to a cloud audit stream** that DAM consumes. This **decouples** the agent from DAM — a durable buffer that survives brief DAM outages and smooths traffic bursts. Optional; direct HTTPS works fine.

### An audit stream is never automatic
On every cloud you **provision the stream yourself** and grant access — a fresh database or VM emits **nothing** to a stream until you configure it. There are always two parts: **(1)** create the stream, and **(2)** grant the publisher (this agent) *and* the DAM consumer access to it. **Coordinate with your DAM operator** — they own the stream name and run the consumer.

| Cloud | Audit stream | Supported by the VM forwarder today? |
|-------|--------------|--------------------------------------|
| **GCP** | Cloud **Pub/Sub** topic | ✅ Yes — the forwarder publishes directly (steps below) |
| **AWS** | **Kinesis** data stream | ❌ Not yet — keep direct HTTPS on AWS VMs |
| **Azure** | **Event Hub** | ❌ Not yet — keep direct HTTPS on Azure VMs |

> **Kinesis and Event Hub** are the streams used by the **Agentless (PaaS)** path — where the *managed database's* native audit is routed into the stream **by the cloud** (e.g. an RDS Database Activity Stream, or an Azure SQL diagnostic setting → Event Hub), not by this on-host forwarder. Letting the forwarder publish to them is planned; **for now, on AWS/Azure VMs keep `CONTROL_PLANE` (HTTPS) and skip this section.**

### GCP — publish to Pub/Sub
For the AgentLite forwarder, the agent publishes **directly** to a Pub/Sub topic — you do **not** need a Cloud Logging sink (that sink is only for the *Agentless/PaaS* path). So the setup is just: create the topic, let the agent publish to it, and point the env vars at it.

1. **Attach a service account to the VM** with the `roles/pubsub.publisher` role on the topic. Because service-account **keys** are often disabled by org policy, the agent authenticates via the **VM's attached service account** (metadata server / ADC) — no key file needed.
   ```bash
   # grant the VM's service account publish on the topic
   gcloud pubsub topics add-iam-policy-binding <TOPIC> \
     --member="serviceAccount:<VM_SERVICE_ACCOUNT_EMAIL>" --role="roles/pubsub.publisher"
   # ensure the VM actually has that SA attached with cloud-platform scope (requires stop/start):
   gcloud compute instances stop  <VM> --zone <ZONE>
   gcloud compute instances set-service-account <VM> --zone <ZONE> \
     --service-account=<VM_SERVICE_ACCOUNT_EMAIL> --scopes=cloud-platform
   gcloud compute instances start <VM> --zone <ZONE>
   ```
2. **Add two env vars** to the agent (Docker `-e` or the `.env` file):
   ```
   AUDIT_TOPIC=<TOPIC>              # e.g. toovix-dam-audit
   GCP_PROJECT=<PROJECT_ID>         # optional — auto-detected from the metadata server
   ```
   When `AUDIT_TOPIC` is set, the agent **publishes to Pub/Sub**; when it's unset, it POSTs to the control plane over HTTPS. Everything else stays the same.

A healthy start then logs: `AgentLite: publishing audit events to Pub/Sub topic "<TOPIC>" (project …)`.

---

## 9. Troubleshooting

| Symptom | Cause & fix |
|---------|-------------|
| `audit-forward: open …/general.log: permission denied` | The MySQL log is owned by `mysql` (e.g. dir `750 mysql:adm`, file `640`). The agent must be able to read it. The shipped `.deb`/`.rpm` unit runs as **root with `CAP_DAC_READ_SEARCH`**, and the Docker command uses `--user 0` — both fine. If you wrote a **custom** systemd unit with a `CapabilityBoundingSet`, **add `CAP_DAC_READ_SEARCH`**, or add the agent's user to the log's group and make the file group-readable. |
| Nothing shows in Database Activity | 1) `SHOW VARIABLES LIKE 'general_log%';` → is it `ON` and `log_output=FILE`? 2) Does `AUDIT_LOG` match `general_log_file`? 3) Agent logs: did it **enroll** (no token error) and can it reach `CONTROL_PLANE` (outbound 443)? |
| Capture stops after a MySQL restart | `general_log` was only set at runtime. Add the **my.cnf drop-in** from §2. |
| Queries run locally aren't captured | Use **TCP** (`mysql -h 127.0.0.1 …`); the general log records them either way, but confirm the log is actually receiving writes. |
| GCP: `AgentLite: Pub/Sub publisher init failed` or `pubsub publish failed: 403` | The VM has **no service account attached**, or the SA lacks `roles/pubsub.publisher` on the topic. See §8. |
| Wrong workspace | You must view the DAM console in the **same tenant/workspace** the enrollment token belongs to; agents are tenant-scoped. |

---

## 10. Security & privacy notes

- **The general query log contains every SQL statement** (including from other applications and users) in cleartext on the VM. Restrict file permissions, enable rotation, and treat it as sensitive data.
- **AgentLite is detective, not preventive** — it alerts after the fact and cannot block. For real-time blocking of a specific database, use **Inline Proxy** mode instead.
- **The agent only makes outbound connections** to DAM (HTTPS, or Pub/Sub on GCP). No inbound ports are opened; DAM never connects into your database network.
- **Least privilege:** the optional `dam_svc` user is read-only (`SELECT, PROCESS`). Rotate its password per your policy.

---

*Questions or a non-MySQL engine (PostgreSQL / SQL Server / Oracle / MongoDB)? Contact your TooVix DAM operator — AgentLite audit-forward currently supports MySQL/MariaDB; other engines use network, host, or inline-proxy capture.*
