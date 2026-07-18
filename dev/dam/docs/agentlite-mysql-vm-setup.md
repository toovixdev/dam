# Connect a Self-Managed Database to TooVix DAM — AgentLite Setup Guide

**Audience:** a customer/operator with a **MySQL, PostgreSQL, or MongoDB database running on a Linux VM** in **GCP, AWS, or Azure** who wants it monitored by TooVix DAM using the **AgentLite (audit-forward)** approach. **SQL Server** and **MongoDB** take a different path — see §2.

**Time:** ~15–20 minutes. **Access needed:** `sudo`/root on the DB VM, and DB admin to enable auditing.

---

## 1. What AgentLite is (and what it isn't)

**AgentLite** is a lightweight forwarder that reads **telemetry the database already produces** and ships each statement to TooVix DAM. For MySQL and PostgreSQL it **tails a log file on the database host**. For **SQL Server and MongoDB** there is no text log to tail, so it **polls the database's own telemetry over the network** — which means those two need a DB login but can run on a **separate host** (see §2).

- ✅ **No wire tap, no proxy, no path change** — it reads telemetry the database already produces.
- ✅ **Transport-independent** — because it reads what the DB logs *after* decryption, it captures **TLS-encrypted** client sessions too.
- ✅ **Works on private, no-public-IP databases** — the agent only makes **outbound** connections to DAM; DAM never connects into your network.
- ⚠️ **Detective only** — it observes and alerts **after the fact**; it **cannot block** a query. (Use Inline Proxy mode if you need prevention.)
- ⚠️ **Records all SQL** — the MySQL general log captures every statement from every session in cleartext on the VM. Treat the log file as sensitive (see §9).

**Flow:**
```
DB telemetry  →  AgentLite forwarder  →  TooVix DAM  →  Database Activity view
 (MySQL general log / PostgreSQL log /    (HTTPS, or an audit stream)
  SQL Server audit / MongoDB profiler)
```

**Requirements:**
- Linux VM, **x86-64 (amd64)**. (arm64 / Graviton is not supported yet.)
- **MySQL 5.7 / 8.x, MariaDB 10.x, PostgreSQL 12+, SQL Server 2017+, or MongoDB 4.4+.**
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

### 🪟 SQL Server — AgentLite runs *remotely* (nothing on Windows)

SQL Server's telemetry is **binary**, not a text log — so instead of tailing a file, AgentLite **polls it over TDS**. That's a bonus: the collector is a **Linux** container that only needs network reach to port **1433**, so **nothing is installed on the Windows DB host**. Pick one of two sources:

| Source | `AUDIT_SOURCE` | Scoping | Row counts |
|---|---|---|---|
| **SQL Server Audit** | `sql_server_audit` | **object-level** — audit only your tables (very clean) | ❌ |
| **Extended Events** | `xevents` | statement-level (agent filters `sys.*` noise) | ✅ **yes** |

**Option 1 — SQL Server Audit** (clean scoping, no row counts). Scope with a *database* audit spec on the schema; a DATABASE-wide spec also captures `sys.*` reads:
```sql
CREATE SERVER AUDIT ToovixAudit TO FILE (FILEPATH='C:\SQLAudit\', MAXSIZE=50 MB, MAX_ROLLOVER_FILES=5) WITH (ON_FAILURE=CONTINUE);
ALTER SERVER AUDIT ToovixAudit WITH (STATE=ON);
-- in your database: audit the dbo schema only (excludes sys / INFORMATION_SCHEMA)
CREATE DATABASE AUDIT SPECIFICATION ToovixDbAudit FOR SERVER AUDIT ToovixAudit
  ADD (SELECT, INSERT, UPDATE, DELETE ON SCHEMA::dbo BY public) WITH (STATE=ON);
```
Agent → `AUDIT_SOURCE=sql_server_audit` · `AUDIT_LOG=C:\SQLAudit\*.sqlaudit`

**Option 2 — Extended Events** (adds **row counts**, which unlock the bulk-read / large-result policies):
```sql
CREATE EVENT SESSION ToovixXE ON SERVER
  ADD EVENT sqlserver.sql_statement_completed (
    ACTION (sqlserver.server_principal_name, sqlserver.client_hostname, sqlserver.database_name)
    WHERE ([sqlserver].[database_name]=N'YourDB'))
  ADD TARGET package0.event_file (SET filename=N'C:\SQLAudit\ToovixXE.xel', max_file_size=50, max_rollover_files=5)
  WITH (MAX_DISPATCH_LATENCY=5 SECONDS, STARTUP_STATE=ON);
ALTER EVENT SESSION ToovixXE ON SERVER STATE = START;   -- START, not ON
```
Agent → `AUDIT_SOURCE=xevents` · `AUDIT_LOG=C:\SQLAudit\ToovixXE*.xel`

> **Both sources need a DB login** (the agent reads telemetry over TDS, not from disk): set `DB_USER`/`DB_PASSWORD` with **CONTROL SERVER** (Audit) or **VIEW SERVER STATE** (XEvents). Run the collector on any Linux host that can reach `<db>:1433`, and set `TARGET_HOST` to the **SQL Server's** address — that's how DAM identifies the instance.

**Azure SQL / Managed Instance (PaaS)** can't host any collector — use **Agentless** instead (database-level Auditing → Event Hub, consumed by the DAM connector; verified ~2-min end-to-end):
```bash
az sql db audit-policy update -g <RG> -s <SERVER> -n <DB> \
  --state Enabled --event-hub-target-state Enabled \
  --event-hub <HUB> --event-hub-authorization-rule-id <SEND_RULE_ID> \
  --actions BATCH_COMPLETED_GROUP SUCCESSFUL_DATABASE_AUTHENTICATION_GROUP
```
**Must be *database*-level** — server-level auditing with a DB-scoped diagnostic setting captures nothing.

**Classification works for SQL Server either way** — it uses a read-only login over TDS, not the audit trail.

### 🍃 MongoDB — database profiler

MongoDB **Community has no audit log at all** (auditing is an Enterprise/Atlas feature), so there is no file to tail. The equivalent source is the built-in **database profiler**: with profiling on, `mongod` writes one document per operation into the capped collection `<db>.system.profile`, and AgentLite **polls that collection over the wire**. Like SQL Server, this means the collector needs a **DB login** but **does not have to run on the DB host** — so the same path covers **Atlas** and any remote `mongod`.

Enable profiling for the database you want monitored:
```javascript
// runtime (takes effect now) — level 2 = every operation, slowms 0 = don't filter by duration
use <db>
db.setProfilingLevel(2, { slowms: 0 })
```

Persist it across restarts (the command above is runtime-only, exactly like MySQL's `SET GLOBAL`):
```yaml
# /etc/mongod.conf
operationProfiling:
  mode: all
  slowOpThresholdMs: 0
```

Create the monitoring login. Enabling the profiler needs the `enableProfiler` action — **don't grant `dbAdmin` for it.** `dbAdmin` bundles `dropCollection` and `dropIndex`, so a monitoring account holding it could **destroy data**. Create a custom role with just the one action instead:

```javascript
// 1. a role that can ONLY toggle profiling
use <db>
db.createRole({
  role: 'toovixProfiler',
  privileges: [ { resource: { db: '<db>', collection: '' }, actions: [ 'enableProfiler' ] } ],
  roles: []
})

// 2. the monitoring user
use admin
db.createUser({
  user: 'dam_svc',
  pwd: '<strong-password>',
  roles: [
    { role: 'clusterMonitor',  db: 'admin' },  // read profiling status
    { role: 'read',            db: '<db>' },   // read system.profile + data
    { role: 'toovixProfiler',  db: '<db>' }    // set the profiling level, nothing else
  ]
})
```

> Verified: this role set can read data, read `system.profile` and call `setProfilingLevel` — and is **denied** create, drop and write. If you'd rather not create a custom role, enable profiling server-side (`operationProfiling.mode: all`), set `MONGO_AUTO_PROFILE=false`, and drop the third role entirely — then `read` + `clusterMonitor` is all the agent needs.

Agent settings → `DB_ENGINE=mongodb` · `AUDIT_SOURCE=profiler` · `TARGET_PORT=27017` · `DB_NAME=<db>` · `DB_USER=dam_svc` · `DB_PASSWORD=…`
**No `AUDIT_LOG`** — the source is the database connection, not a file.

| Extra setting | Default | What it does |
|---|---|---|
| `MONGO_URI` | *(built from host/port/user)* | Full connection string; use for **Atlas** (`mongodb+srv://…`) or custom TLS/replica-set options. Overrides the others. |
| `MONGO_AUTH_SOURCE` | `admin` | Auth database, if your user lives elsewhere. |
| `AUDIT_POLL_SEC` | `10` | How often `system.profile` is polled. |
| `MONGO_AUTO_PROFILE` | `true` | Let the agent enable profiling at startup. Set `false` to manage it server-side only. |
| `MONGO_INCLUDE_GETMORE` | `false` | See the row-count warning below. |

> **⚠️ Three limits specific to the profiler — read before relying on this trail.**
> 1. **`system.profile` is capped** (1 MB default, ≈ a few thousand operations). On a busy instance it wraps faster than the poll interval and operations are **lost** — profiler capture is **best-effort, not a guaranteed audit trail**. Size it up if that matters: `db.setProfilingLevel(0)`, `db.system.profile.drop()`, `db.createCollection('system.profile', { capped: true, size: 100000000 })`, then re-enable.
> 2. **`row_count` under-reports large reads by default.** A `find` reports only its first batch (101 documents), so a 10,000-document read looks like 101 rows. Set `MONGO_INCLUDE_GETMORE=true` to emit every cursor batch and get true read volume — at roughly one extra event per 100 documents. **Turn this on if you use bulk-read/exfiltration policies.**
> 3. **Profiling costs write throughput** on the server, and the agent's own polling consumes space in the capped collection. A longer `AUDIT_POLL_SEC` reduces both.

> **Statements appear in Mongo syntax, not SQL** — `db.users.find({"email":"…"})` — because that's what actually ran. Operations still map onto the normal taxonomy (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/`DDL`/`GRANT`) so existing policies and views work unchanged.

> **Verify (MySQL/PG):** `sudo tail -f <AUDIT_LOG>` and run a query elsewhere — lines should appear. AgentLite tails the live file and handles rotation/truncation automatically; ensure `logrotate` + disk headroom on busy DBs.
> **Verify (MongoDB):** run a query, then `db.system.profile.find().sort({ts:-1}).limit(5)` — documents should appear.

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

> **MongoDB: classification is not supported yet.** `CLASSIFY=true` is ignored for `DB_ENGINE=mongodb` — the scanner reads `information_schema`, which has no MongoDB equivalent (collections are schemaless, so classifying them means sampling documents). Capture still tags statements whose **text** contains sensitive field names (`email`, `aadhaar`, `ssn`, `card`…), but a read of a sensitive collection that doesn't name such a field — e.g. `db.kyc_documents.find({status:"verified"})` — will arrive **untagged**. If you rely on sensitive-collection policies, raise this with your DAM operator.

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

**MongoDB variant.** There's no log file, so drop `AUDIT_LOG` and the `-v` log mount, and supply the connection instead. The collector needs no privileged access to the host and can run **anywhere** that can reach `27017`:
```bash
docker run -d --name toovix-agent-audit --restart unless-stopped \
  -e MODE=audit-forward \
  -e DB_ENGINE=mongodb \
  -e AUDIT_SOURCE=profiler \
  -e TARGET_HOST=${DB_VM_HOST} \
  -e TARGET_PORT=27017 \
  -e DB_NAME=<db> \
  -e DB_USER=dam_svc -e DB_PASSWORD=<password> \
  -e AGENT_ENROLL_TOKEN=${ENROLL_TOKEN} \
  -e CONTROL_PLANE=${CONTROL_PLANE} \
  <your-dam-agent-image>
# Atlas / replica sets: replace TARGET_* and DB_USER/DB_PASSWORD with
#   -e MONGO_URI='mongodb+srv://user:pass@cluster.xxxxx.mongodb.net/'
# but keep TARGET_HOST set — it's how DAM identifies the instance.
```

**A healthy MongoDB start looks like:**
```
=== TooVix DAM Agent · mode=audit-forward engine=mongodb target=10.0.0.10:27017 ===
enrolled: agent=… instance=… tenant=…
AgentLite audit-forward tailing mongodb-10.0.0.10-27017-<db> (source=profiler engine=mongodb)
audit-forward(mongodb): profiler already at level 2 (slowms=0)
audit-forward(mongodb): polling <db>.system.profile every 10s (watermark …)
[capture] SELECT  rows=2  app  db.users.find({"country":"UK"})
```

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
| MongoDB: `could not enable profiling` | The login lacks the **`enableProfiler`** action on the target DB. Grant the `toovixProfiler` role from §2 — **not `dbAdmin`**, which also allows dropping collections. Or enable profiling server-side (`operationProfiling.mode: all`) and set `MONGO_AUTO_PROFILE=false`. Until profiling is on, **capture is empty**. |
| MongoDB: agent starts but captures nothing | 1) `db.getProfilingStatus()` → is `was: 2`? 2) Does `DB_NAME` match the database the queries actually run against? Operations on **other** databases, and on `admin`/`local`/`config`, are deliberately ignored. 3) Is anything running? Check `db.system.profile.countDocuments()` grows. |
| MongoDB: big reads show `row_count` ≈ 101 | Expected — that's the first cursor batch. Set `MONGO_INCLUDE_GETMORE=true` (§2). |
| MongoDB: gaps in the trail under load | `system.profile` is **capped** and wrapped before the agent polled. Lower `AUDIT_POLL_SEC` and/or enlarge the collection (§2). |

---

## 10. Security & privacy notes

- **The general query log contains every SQL statement** (including from other applications and users) in cleartext on the VM. Restrict file permissions, enable rotation, and treat it as sensitive data.
- **AgentLite is detective, not preventive** — it alerts after the fact and cannot block. For real-time blocking of a specific database, use **Inline Proxy** mode instead.
- **The agent only makes outbound connections** to DAM (HTTPS, or Pub/Sub on GCP). No inbound ports are opened; DAM never connects into your database network.
- **Least privilege:** the optional `dam_svc` user is read-only (`SELECT, PROCESS`). Rotate its password per your policy.
- **MongoDB:** `system.profile` contains **query filters and inserted documents**, so it holds real data values on the server — treat the profiler as sensitive, and note that enabling it is a **visible change to the database's behaviour** (write overhead), not a passive read. Keep `dam_svc` on the `toovixProfiler` custom role from §2: **`dbAdmin` would let a monitoring account drop collections**, which is far more privilege than capture requires.

---

*Questions or an engine not covered here (Oracle / others)? Contact your TooVix DAM operator. AgentLite audit-forward supports **MySQL/MariaDB, PostgreSQL, SQL Server, and MongoDB**; other engines use network, host, or inline-proxy capture.*
