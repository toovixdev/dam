# SOP — Onboarding Azure Databases into TooVix DAM (MySQL · PostgreSQL · SQL Server)

**Purpose:** Bring a customer's **Azure-hosted** databases under TooVix DAM monitoring, covering both
**PaaS** (Azure SQL Database / Managed Instance, Azure Database for MySQL & PostgreSQL Flexible Server)
and **self-managed on Azure VMs**.

**Audience:** DAM operator (platform side) + customer Azure/DB admin.
**Companion docs:** [agentlite-mysql-vm-setup.md](agentlite-mysql-vm-setup.md) (per-engine audit enablement +
agent install, all clouds) · [capture-modes.md](capture-modes.md) · [sop-paas-gcp-pubsub-agentless.md](sop-paas-gcp-pubsub-agentless.md)
(the GCP analog of the Event Hub path).

---

## 0. Read this first — what works on Azure today

The right path depends on **how the DB is hosted** (PaaS vs VM) and **the engine**. This matrix is the
source of truth; the rest of the SOP is the how-to for each ✅ cell.

| Engine | **PaaS** (Azure managed service) | **Self-managed on an Azure VM** |
|---|---|---|
| **SQL Server** (Azure SQL DB / Managed Instance) | ✅ **Agentless** — DB Auditing → Event Hub → DAM consumer *(no row counts)* · **or** ✅ **Agent over TDS** — XEvents-to-Blob read by a VNet collector *(row counts)* → **Part B** | ✅ **Full agent** — network / host(eBPF) / inline-proxy / audit-forward → **Part A** |
| **MySQL** (Azure DB for MySQL Flexible) | ⚠️ **Capture not built yet** — audit goes only to Azure Monitor; no Event Hub MySQL normalizer. **Classification (PII discovery) works.** → **Part C** | ✅ **Full agent** — network / host / inline-proxy / audit-forward (general-log tail) → **Part A** |
| **PostgreSQL** (Azure DB for PostgreSQL Flexible) | ⚠️ **Capture not built yet** — pgAudit goes only to Azure Monitor; no Event Hub PG normalizer. **Classification works.** → **Part C** | ✅ **Full agent** — network / host / inline-proxy / audit-forward (pgAudit/statement-log tail) → **Part A** |

**Plain-language summary for the customer call:**
- Anything **running on a VM** — all three engines — is fully supported today, exactly like on-prem.
- **Azure SQL (SQL Server PaaS)** is fully supported today (agentless, or agent-over-TDS for row counts).
- **Azure MySQL / PostgreSQL PaaS** capture is a **known gap** — see **Part C** for the interim (classification-only)
  and the two ways to close it (run those engines on a VM, or we build the MySQL/PG Event Hub normalizers —
  a small, well-scoped task).

> **"Row counts" matters.** Only capture paths that carry per-statement row counts can power
> mass-read / exfiltration detection. On Azure that means: SQL Server via **XEvents** (Part B, option 2),
> or any **VM** DB via **host/network/proxy** capture. Audit-log and Event-Hub paths are detective but
> volume-blind. Decide per database where regulated data lives.

---

## 1. Prerequisites (both paths)

- **DAM enrollment token** for the customer's workspace: DAM console → **Agents → Deploy monitoring** →
  select the instance → copy `tvxenr_…` and the **control-plane URL** (`https://dam.<customer>.com`).
- **A Linux x86-64 host** to run the agent/collector where one is needed:
  - VM path → the agent runs **on the DB VM** (MySQL/PG) or **any VNet host** (SQL Server over TDS).
  - PaaS SQL Server (agent option) → a small **collector VM inside the customer VNet** (Azure SQL public
    access is normally disabled behind a private endpoint).
- **Outbound HTTPS (443)** from that host to the DAM control plane. Default Azure egress
  (`AllowInternetOutBound`) or a **NAT Gateway** suffices; no inbound rules are ever required — the agent
  only dials out. Reach private VMs to install via **Azure Bastion / jump-box**.
- **Azure RBAC** for the customer admin: `Contributor` (or scoped) on the DB + the resource group for
  diagnostic settings / Event Hub; SQL admin on the database for the audit DDL.

---

## PART A — Databases on Azure VMs (MySQL, PostgreSQL, SQL Server)

Self-managed DBs on a VM are onboarded exactly like on-prem — the VM hosts (or reaches) the agent. Follow
[agentlite-mysql-vm-setup.md](agentlite-mysql-vm-setup.md) end-to-end; the Azure-specific notes are below.
Choose the capture mode by what you need:

| Need | Mode | `MODE=` |
|---|---|---|
| Zero-touch / lowest overhead, detective | **Network** (libpcap on the DB VM, or Azure **vTAP** mirror off-host) | `network` |
| Deepest visibility incl. local/loopback, detective | **Host (eBPF)** on the DB VM | `host` |
| **Real-time blocking** of a sensitive DB | **Inline proxy** in the app→DB path | `proxy` |
| Read the DB's native audit, detective, TLS-safe | **Audit-forward** (AgentLite) | `audit-forward` |

**A1. Enable the engine's audit source** (only needed for `audit-forward`; network/host/proxy read the wire):
- **MySQL** → general query log to a file (`general_log=ON`, `log_output=FILE`) — [guide §2 🐬](agentlite-mysql-vm-setup.md).
- **PostgreSQL** → `log_statement='all'` + the exact `log_line_prefix` — [guide §2 🐘](agentlite-mysql-vm-setup.md).
- **SQL Server** → SQL Server Audit (`sql_server_audit`) or Extended Events (`xevents`, adds row counts) — [guide §2 🪟](agentlite-mysql-vm-setup.md).

**A2. Run the agent on the VM** (Docker shown; systemd variant in the guide §5):
```bash
CONTROL_PLANE="https://dam.<customer>.com"
ENROLL_TOKEN="tvxenr_xxxxxxxxxxxx"
DB_VM_HOST="10.20.0.10"          # THIS VM's private IP — the instance identity in DAM (unique per VM)

# MySQL example (audit-forward, general log):
docker run -d --name toovix-agent --restart unless-stopped --user 0 \
  -v /var/log/mysql/general.log:/var/log/mysql/general.log:ro \
  -e MODE=audit-forward -e DB_ENGINE=mysql \
  -e TARGET_HOST=${DB_VM_HOST} -e TARGET_PORT=3306 \
  -e AUDIT_SOURCE=general_log -e AUDIT_LOG=/var/log/mysql/general.log \
  -e AGENT_ENROLL_TOKEN=${ENROLL_TOKEN} -e CONTROL_PLANE=${CONTROL_PLANE} \
  <dam-agent-image>
```
PostgreSQL and SQL Server variants: swap `DB_ENGINE` / `AUDIT_SOURCE` / `TARGET_PORT` (5432 / 1433) per the
guide §5. **SQL Server on a VM can also be read over TDS** (no file mount) if you prefer — same as the PaaS
collector in Part B.

**A3. Azure networking:** NSG default `AllowInternetOutBound` covers egress; if locked down, allow **outbound
443** from the DB subnet to the DAM URL, and add a **NAT Gateway** for private (no-public-IP) VMs. Nothing
inbound.

**A4. (Optional) Classification** — add `CLASSIFY=true`, `DB_USER=dam_svc`, `DB_PASSWORD=…` (read-only login,
[guide §3](agentlite-mysql-vm-setup.md)). Works for MySQL / PostgreSQL / SQL Server / Oracle.

---

## PART B — Azure SQL Database / Managed Instance (PaaS SQL Server)

You can't install anything on Azure SQL, so pick one of two routes. They are **not** equivalent — only the
XEvents route carries **row counts**.

### Option 1 — Agentless: DB Auditing → Event Hub → DAM consumer *(no agent, no row counts)*

The Azure analog of the GCP Pub/Sub path. The database's native audit (`SQLSecurityAuditEvents`) streams to
an Event Hub that DAM's `dam-audit-consumer` reads outbound.

**Customer side (Azure):**
1. **Event Hub** — namespace (Standard) + hub `toovix-dam-audit` + consumer group `toovix-dam` + a **SAS
   send** rule (for the diagnostic setting) and a **SAS listen** rule (for DAM). See
   [enterprise-test-azure/terraform/eventhub.tf](../../enterprise-test-azure/terraform/eventhub.tf) for the
   exact resources.
2. **Turn on DATABASE-level auditing** routed to the hub. ⚠️ **Must be database-level, not server-level** —
   server-level auditing with a DB-scoped diagnostic setting captures **nothing**:
   ```bash
   az sql db audit-policy update -g <RG> -s <SERVER> -n <DB> \
     --state Enabled --event-hub-target-state Enabled \
     --event-hub toovix-dam-audit --event-hub-authorization-rule-id <SEND_RULE_ID> \
     --actions "SELECT ON SCHEMA::dbo BY public" "INSERT ON SCHEMA::dbo BY public" \
               "UPDATE ON SCHEMA::dbo BY public" "DELETE ON SCHEMA::dbo BY public" \
               SCHEMA_OBJECT_CHANGE_GROUP SUCCESSFUL_DATABASE_AUTHENTICATION_GROUP
   ```
   (Terraform equivalent: `azurerm_mssql_database_extended_auditing_policy` with
   `log_monitoring_enabled=true` + a diagnostic setting for category `SQLSecurityAuditEvents`.)
3. Give DAM the **listen connection string** for the hub (the `dam-listen` SAS primary connection string).

**DAM operator side:** point `dam-audit-consumer` at the customer's hub — set on the consumer service:
```
EVENTHUB_CONNECTION_STRING=<dam-listen primary connection string>
EVENTHUB_NAME=toovix-dam-audit
EVENTHUB_CONSUMER_GROUP=toovix-dam
AZURESQL_ENROLL_TOKEN=<the CUSTOMER tenant's tvxenr_… token>   # ties events to the right workspace
```
The consumer subscribes and normalizes `SQLSecurityAuditEvents` → DAM events (`engine=mssql`,
`agent_type=audit_pull`). Verified end-to-end latency ~2 min query→hub→ClickHouse.

> **Multi-tenant note:** one consumer instance reads **one** Event Hub connection string (env-configured),
> so each Azure-SQL customer gets its own consumer config / instance keyed by `AZURESQL_ENROLL_TOKEN`. Plan
> one consumer deployment per Azure-SQL customer until per-tenant hub routing is added.

### Option 2 — Agent over TDS: Extended Events to Blob *(collector in the VNet, gives ROW COUNTS)*

The `xevents` collector runs on a **Linux VM inside the customer VNet** and reads the XEvents `.xel` blob
**over TDS** — the only Azure-SQL route with row counts (so use it where mass-read detection matters).

1. Create the XEvents session **ON DATABASE** with a blob target (needs a storage account + container, a
   master key + scoped credential + SAS `rwl`). ⚠️ On Azure SQL the principal action is `sqlserver.username`,
   **not** `server_principal_name`. Full DDL: [agentlite guide §2 → "Azure SQL Database (PaaS)"](agentlite-mysql-vm-setup.md).
2. Run the collector (note **`MSSQL_XE_SESSION`** set, `AUDIT_LOG` **omitted** — it auto-discovers the live
   blob and follows rollover):
   ```bash
   docker run -d --name toovix-agent --restart unless-stopped \
     -e MODE=audit-forward -e DB_ENGINE=mssql -e AUDIT_SOURCE=xevents \
     -e TARGET_HOST=<server>.database.windows.net -e TARGET_PORT=1433 -e DB_NAME=<db> \
     -e DB_USER=<login> -e DB_PASSWORD=<password> `# needs VIEW DATABASE STATE` \
     -e MSSQL_XE_SESSION=ToovixXE \
     -e AGENT_ENROLL_TOKEN=${ENROLL_TOKEN} -e CONTROL_PLANE=${CONTROL_PLANE} \
     <dam-agent-image>
   ```
3. The collector VM needs a **private-endpoint / VNet** route to `:1433` and outbound **443** to DAM.

**Classification works either way** (read-only login over TDS, independent of the audit path).

---

## PART C — Azure Database for MySQL / PostgreSQL (PaaS Flexible Server)

**Status: activity capture is a known gap today.** Azure MySQL/PG Flexible Server emit their audit
(`audit_log` events / pgAudit) **only to Azure Monitor** diagnostic categories — there's no log file for an
agent to tail, and DAM's Event Hub consumer currently has a **SQL-Server-only** normalizer
([audit-consumer/normalize.js `azureSqlAudit`](../audit-consumer/normalize.js) → `engine:'mssql'`). So neither
the agent path nor the agentless path captures these two PaaS engines yet.

**What works right now:**
- ✅ **Classification (PII/PCI discovery)** — the standalone collector / an agent logs in as a read-only
  reader over the native port and inventories sensitive columns. This populates the **Classification** page
  and tags, independent of activity capture. Set `CLASSIFY=true` + a read-only `DB_USER`/`DB_PASSWORD`
  ([guide §3](agentlite-mysql-vm-setup.md)) on a collector in the VNet.

**Three ways to get full activity capture on these engines (pick per customer):**
1. **Run them on a VM instead of PaaS** → falls under **Part A**, fully supported today. Best if the customer
   is flexible on hosting.
2. **We build the Azure Monitor MySQL/PG Event Hub normalizers** (recommended, small): add
   `azureMysqlAudit` / `azurePostgresAudit` to `dam-audit-consumer` mirroring `azureSqlAudit`, then the
   customer routes the `MySqlAuditLogs` / `PostgreSQLLogs` diagnostic category to an Event Hub exactly like
   Part B option 1. Track this before committing a PaaS-MySQL/PG customer to a capture SLA.
3. **Inline proxy in front of the Flexible Server** (if real-time blocking is required and a proxy hop is
   acceptable) — the proxy sees every query regardless of engine PaaS limitations. Heavier; discuss fit.

> **Set expectations on the customer call:** for Azure **MySQL/PG PaaS**, promise **classification now** +
> **activity capture on a short lead time** (option 2) or **immediately if hosted on a VM** (option 1). Do
> not imply agentless activity capture for these two engines is live today.

---

## PART D — Networking summary (all paths)

| Path | Customer-side network | DAM-side network |
|---|---|---|
| VM agent (Part A) | Outbound **443** from DB subnet (NSG `AllowInternetOutBound` / NAT GW). No inbound. | Ingress WAF/LB for the agent's outbound POST (same as any agent). |
| Azure SQL Event Hub (Part B/1) | DB→Auditing→Event Hub is **Azure-internal**; no customer FW/NAT change for the data path. | Consumer dials **outbound** to the Event Hub (AMQP/443). No inbound. |
| Azure SQL over TDS (Part B/2) | Collector VM reaches DB `:1433` via **private endpoint / VNet**; outbound 443 to DAM. | Ingress for the collector's outbound POST. |
| Classification (Part C) | Collector reaches DB over its native port (3306/5432) in the VNet; outbound 443 to DAM. | Ingress for outbound POST. |

**DAM never connects into the customer network** on any path — every mode is outbound-only, so all of the
above work for private, no-public-IP databases.

---

## PART E — Validation

1. **VM / TDS paths:** run a distinctive query (`SELECT 'dam-verify-123', NOW();`) against the DB. Within a
   few seconds it appears in **Databases → your instance → Database Activity** (correct workspace).
2. **Event Hub path:** run an audited statement; confirm it reaches the hub
   (`az eventhubs eventhub show …` metrics, or a test consumer), then confirm it lands in **Audit Trail →
   Database Activity** with `source_host` = the Azure SQL server. The connector row shows
   `ingest_status = ok` (heartbeat keeps an idle DB "monitored").
3. **Classification:** click **Run Scan** on the Classification page (or wait for the interval) → the DB's
   sensitive columns populate.

---

## PART F — Offboarding

- **VM agent:** stop/remove the container or `systemctl disable --now dam-agent@<name>`; revoke the enroll token.
- **Azure SQL Event Hub:** disable the DB audit policy / diagnostic setting, or remove the consumer's
  `EVENTHUB_CONNECTION_STRING`; optionally delete the hub + SAS rules. Nothing else is affected.
- **TDS collector:** stop the container; drop the XEvents session + storage credential if desired.

---

## Appendix — Agent env quick reference (Azure)

| Variable | MySQL VM | PostgreSQL VM | SQL Server (VM or Azure SQL over TDS) |
|---|---|---|---|
| `MODE` | `audit-forward` (or `network`/`host`/`proxy`) | same | `audit-forward` (or `network`/`host`/`proxy` on a VM) |
| `DB_ENGINE` | `mysql` | `postgresql` | `mssql` |
| `TARGET_HOST` | DB VM private IP | DB VM private IP | `<server>.database.windows.net` / VM IP |
| `TARGET_PORT` | `3306` | `5432` | `1433` |
| `AUDIT_SOURCE` | `general_log` | `pgaudit` | `xevents` (row counts) or `sql_server_audit` |
| `AUDIT_LOG` | `/var/log/mysql/general.log` | `/var/log/postgresql/postgresql-<v>-main.log` | *(omit; set `MSSQL_XE_SESSION` for Azure SQL)* |
| `MSSQL_XE_SESSION` | — | — | `ToovixXE` (Azure SQL: auto-discovers blob + rollover) |
| `DB_USER` / `DB_PASSWORD` | only for `CLASSIFY` | only for `CLASSIFY` | **required** (VIEW DATABASE STATE for XEvents) |
| `AGENT_ENROLL_TOKEN` / `CONTROL_PLANE` | required | required | required |

*Questions or an engine/host combination not covered here → your TooVix DAM operator. For the two ⚠️ PaaS
cells (Azure MySQL/PG activity capture), see Part C for status and the path to close the gap.*
