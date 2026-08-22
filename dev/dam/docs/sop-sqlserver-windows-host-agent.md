# SOP — Install the DAM Host Agent on a Windows SQL Server (Extended Events)

**Purpose:** run the SecurEra DAM agent **as a Windows service on the SQL Server box itself**, capturing
activity through **Extended Events (XEvents)**. Because SQL Server hands XEvents the statement *after*
it has decrypted the session, this **captures TLS-encrypted client connections** and carries **row
counts** — the same benefits people expect from a "below-TLS host agent" — **without injecting anything
into `sqlservr.exe`**.

> **Why not the Linux eBPF "host" mode?** eBPF is Linux-only, and on Windows SQL Server does TLS through
> **Schannel**, not OpenSSL — there is no `libssl` to probe. So the Windows host agent uses the XEvents
> source instead. If you want *wire-level* below-TLS interception on Windows you'd have to hook Schannel
> inside `sqlservr.exe` (process injection / a signed kernel driver) — high risk, and not what this SOP does.

**Audience:** a Windows admin on the SQL Server host. **Time:** ~15 min. **Access:** local admin
(PowerShell elevated) + a SQL sysadmin to run the DDL in Steps 1–2.

---

## Requirements
- **Windows Server 2016+**, **SQL Server 2017+**, **x64** (the agent is amd64; ARM Windows is not supported).
- **Outbound HTTPS (443)** from this host to your DAM control-plane URL. The agent only dials out.
- `dam-agent.exe` (from your DAM operator / control-plane download).

---

## Step 1 — Create the Extended Events session (as a SQL sysadmin)

This writes `sql_statement_completed` (statement text **+ row counts**) to a rollover file target. Create
the target folder first and make sure the SQL Server service account can write to it.

```sql
-- folder: C:\SQLAudit\  (create it; grant the SQL Server service account modify rights)
CREATE EVENT SESSION ToovixXE ON SERVER
  ADD EVENT sqlserver.sql_statement_completed (
    ACTION (sqlserver.server_principal_name, sqlserver.client_hostname, sqlserver.database_name)
    WHERE ([sqlserver].[database_name] = N'YourDB'))          -- scope to the DB you monitor
  ADD TARGET package0.event_file (
    SET filename = N'C:\SQLAudit\ToovixXE.xel', max_file_size = 50, max_rollover_files = 5)
  WITH (MAX_DISPATCH_LATENCY = 5 SECONDS, STARTUP_STATE = ON);
ALTER EVENT SESSION ToovixXE ON SERVER STATE = START;          -- START, not ON
```

## Step 2 — Create the monitoring login

The agent reads the XEvents file **over TDS** (via `sys.fn_xe_file_target_read_file`), so it needs a login
with server-state read:

```sql
CREATE LOGIN dam_svc WITH PASSWORD = 'CHANGE_ME_strong', CHECK_POLICY = ON;
GRANT VIEW SERVER STATE TO dam_svc;      -- read the XEvents session + its file target
-- Optional add-ons (see the end of this doc):
--   VA scanning:      GRANT VIEW ANY DEFINITION TO dam_svc;   -- + sys.configurations via VIEW SERVER STATE
--   Classification:   a read-only user in YourDB (reads INFORMATION_SCHEMA.COLUMNS)
```

## Step 3 — Get the enrollment token
In the DAM console: **Agents → Deploy monitoring**, register this SQL Server instance, copy the
**enrollment token** (`tvxenr_…`) and the **control-plane URL**.

## Step 4 — Write the agent config file
The service inherits no user environment, so it reads a config file at
**`C:\ProgramData\SecurEra\dam-agent.env`** (override with the `DAM_AGENT_ENV` env var for a console run).

```ini
CONTROL_PLANE=https://dam.yourcompany.com
AGENT_ENROLL_TOKEN=tvxenr_xxxxxxxxxxxxxxxx
MODE=audit-forward
DB_ENGINE=mssql
AUDIT_SOURCE=xevents
MSSQL_XE_SESSION=ToovixXE      ; agent discovers the live .xel + follows rollover (omit AUDIT_LOG)
TARGET_HOST=SQLSERVER01        ; this instance's identity in DAM (and how the agent connects locally)
TARGET_PORT=1433
DB_NAME=YourDB                 ; used by classification; for XEvents the agent connects to master (server-level reads)
DB_USER=dam_svc
DB_PASSWORD=CHANGE_ME_strong
```
> **`TARGET_HOST`** is both the DB connection target and the instance's identity in DAM. Use the server's
> own hostname (it resolves locally) so multiple instances don't collapse into one record. With
> `MSSQL_XE_SESSION` set, the agent finds the current `.xel` from the live session and follows rollover —
> don't pin `AUDIT_LOG` to a single generated filename.

## Step 5 — Install & start the service (elevated PowerShell)

```powershell
# Put the exe somewhere stable, then register + start the service:
New-Item -ItemType Directory -Force 'C:\Program Files\SecurEra' | Out-Null
Copy-Item .\dam-agent.exe 'C:\Program Files\SecurEra\dam-agent.exe'
& 'C:\Program Files\SecurEra\dam-agent.exe' install     # creates service "TooVixDAMAgent" (auto-start)
& 'C:\Program Files\SecurEra\dam-agent.exe' start        # or: Start-Service TooVixDAMAgent
Get-Service TooVixDAMAgent
```

## Step 6 — Verify

```powershell
Get-Content 'C:\ProgramData\SecurEra\dam-agent.log' -Tail 20 -Wait
```
A healthy start logs enrollment, then something like:
```
=== SecurEra DAM Agent v0.1.0 · mode=audit-forward engine=mssql target=SQLSERVER01:1433 ===
enrolled: agent=… tenant=…
AgentLite audit-forward (mssql xevents): reading session ToovixXE …
```
Run a query against `YourDB`, then in the DAM console open **Databases → your instance → Database
Activity** — it should appear within a few seconds with a row count.

---

## Manage / uninstall
```powershell
& 'C:\Program Files\SecurEra\dam-agent.exe' stop
& 'C:\Program Files\SecurEra\dam-agent.exe' uninstall     # removes the service
```

## Notes
- **Unsigned binary.** Until the exe is code-signed, SmartScreen/EDR may warn on first run — sign it for
  production or add a controlled AV exception. (This agent is a plain service; it does **not** inject into
  SQL Server.)
- **Also run VA scanning:** add `VA_SCAN=true` to the config and `GRANT VIEW ANY DEFINITION TO dam_svc;`
  (server-state read from Step 2 already covers `sys.configurations`). See the VA subsection of the
  AgentLite guide.
- **Also run classification:** add `CLASSIFY=true` plus a read-only user in `YourDB`.
- **Row counts / encryption:** XEvents sees the statement post-decryption, so encrypted client sessions are
  captured, and `sql_statement_completed` carries the row count that powers mass-read/exfiltration policies.
- **Alternative:** you can instead run the agent as a **remote Linux collector** over TDS (nothing on
  Windows) — see `agentlite-mysql-vm-setup.md`. Use this on-box Windows service when you prefer a single
  agent living on the DB host.
