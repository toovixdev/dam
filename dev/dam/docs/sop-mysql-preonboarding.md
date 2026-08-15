# SOP — Pre-Onboarding Checklist: MySQL Database → TooVix DAM

**Purpose:** a go/no-go readiness gate to run **before** onboarding a client's MySQL database. Work top to
bottom; every check has a **command** and a **PASS criterion**. Do not deploy the agent until Phases 0–5
all pass. Phases 6–8 are the deploy + verify + handover.

**Scope:** self-managed MySQL / MariaDB on a Linux VM, monitored via **AgentLite (audit-forward)** — the
default for a live app. Notes flag where the network / host (eBPF) / inline-proxy modes differ.

**Legend:** ☐ = check to perform · **PASS** = the condition that must be true to proceed.

---

## Phase 0 — Instance profile (gather before you touch anything)

Fill this in first — the answers drive every later decision. Ask the client's DBA / app owner.

| # | Field | Value | How to get it |
|---|---|---|---|
| 0.1 | DB engine + version | ______ | `mysql -e "SELECT VERSION();"` |
| 0.2 | Deployment type | VM / RDS / Cloud SQL / Azure SQL | ask; PaaS ⇒ different SOP (agentless/collector) |
| 0.3 | DB host private IP / hostname | ______ | this becomes `TARGET_HOST` (must be unique per DB) |
| 0.4 | DB port | 3306 (default) | ask |
| 0.5 | OS + kernel of DB host | ______ | `uname -srm` |
| 0.6 | App→DB uses TLS? | yes / no / unknown | Phase 1.3 determines it definitively |
| 0.7 | Do they need **blocking** (prevent), or **detect-only**? | ______ | blocking ⇒ inline-proxy, not AgentLite |
| 0.8 | Do they need **row counts** (mass-read detection)? | ______ | general log has none ⇒ network/host mode |
| 0.9 | Regulated data present (PII/PCI/Aadhaar)? | ______ | drives classification (Phase 2.4) + policy scope |
| 0.10 | Who owns MySQL admin + `sudo` on the host? | ______ | you need both for AgentLite (general log + file read) |

> **PASS Phase 0:** all fields filled. If 0.2 is a managed PaaS (RDS/Cloud SQL/Azure SQL), **stop** — use
> the agentless/remote-collector SOP instead of this one.

---

## Phase 1 — Capture-mode decision

### 1.1 — Pick the mode from the requirements

| If the client needs… | Use | Runs on DB host? | SSL sensitivity |
|---|---|---|---|
| Simple detect-only, works regardless of TLS | **AgentLite (audit-forward)** ✅ default | yes (tails the log) | **SSL-agnostic** |
| Row counts / mass-read volume, plaintext app | **network** (passive wire) | yes | needs **cleartext** (can't read TLS) |
| Row counts, TLS app | **host (eBPF)** | yes | needs **TLS** (hooks libssl) |
| Real-time **blocking** | **inline proxy** | in-path | terminates TLS |

☐ **1.2 — Record the chosen mode.** This SOP continues for **AgentLite**. For the wire modes, the Phase 2
audit-log steps are replaced by the capture prerequisites in the capture-modes guide.

☐ **1.3 — Determine the app's real TLS behavior** (informational for AgentLite; **decisive** for network/host mode).
Run on the DB, while the app is live:
```sql
SELECT t.processlist_user AS usr, t.processlist_host AS src,
       COALESCE(NULLIF(s.variable_value,''),'(plaintext)') AS tls
FROM performance_schema.status_by_thread s
JOIN performance_schema.threads t ON t.thread_id = s.thread_id
WHERE s.variable_name = 'Ssl_cipher'
ORDER BY usr;
```
**PASS:** you know, per connection, whether it's TLS or plaintext.
- Rows with a cipher = **TLS** → if you'd wanted network mode, it won't decode; use AgentLite or host mode.
- `(plaintext)` = **non-TLS** → host/eBPF mode would capture **nothing**; use AgentLite or network mode.
- **AgentLite captures either way** — this check just confirms you didn't pick a mode that can't see the traffic.

> **PASS Phase 1:** mode chosen, and it can actually see this app's traffic given 1.3.

---

## Phase 2 — MySQL server readiness (AgentLite)

### 2.1 — Version supported
```sql
SELECT VERSION();
```
**PASS:** MySQL 5.7 / 8.x or MariaDB 10.x.

### 2.2 — Enable the general query log to a FILE
```sql
SET GLOBAL log_output       = 'FILE';
SET GLOBAL general_log_file  = '/var/log/mysql/general.log';
SET GLOBAL general_log       = 'ON';
```
Persist across restarts (runtime `SET GLOBAL` is lost on restart):
```bash
# Debian/Ubuntu: /etc/mysql/mysql.conf.d/  ·  RHEL/Rocky: /etc/my.cnf.d/
sudo tee /etc/mysql/mysql.conf.d/zz-toovix-audit.cnf >/dev/null <<'EOF'
[mysqld]
log_output       = FILE
general_log      = 1
general_log_file = /var/log/mysql/general.log
EOF
```

### 2.3 — Verify the log is ON and actually receiving writes
```sql
SHOW VARIABLES LIKE 'general_log%';     -- general_log = ON, path set
SHOW VARIABLES LIKE 'log_output';       -- must be FILE (not TABLE)
```
Then, in one shell tail the log; in another run a query over **TCP**:
```bash
sudo tail -f /var/log/mysql/general.log     # shell A
mysql -h 127.0.0.1 -u <user> -p -e "SELECT 'dam-preflight', NOW();"   # shell B
```
**PASS:** `general_log=ON`, `log_output=FILE`, and the `dam-preflight` line appears in the tail.

> **⚠️ Performance note — clear with the client first.** The general log records **every** statement and
> grows fast on a busy DB. Confirm `logrotate` is configured and there's disk headroom (Phase 3.4). On very
> high-throughput DBs, prefer network/host mode over the general log.

### 2.4 — (Optional) Create the read-only monitoring user (classification + VA)
Only if the client wants PII/PCI classification or VA scans. Skip for capture-only.
```sql
CREATE USER 'dam_svc'@'%' IDENTIFIED BY '<strong-password>';
GRANT SELECT, PROCESS ON *.* TO 'dam_svc'@'%';
FLUSH PRIVILEGES;
```
Verify the grant and that it can log in:
```sql
SHOW GRANTS FOR 'dam_svc'@'%';          -- expect: GRANT SELECT, PROCESS ON *.* ...
```
```bash
mysql -h <DB_HOST> -u dam_svc -p -e "SELECT COUNT(*) FROM information_schema.columns;"
```
**PASS:** `dam_svc` exists, is **read-only** (`SELECT, PROCESS` only — no write/DDL/SUPER), and can connect.

> **If the DB enforces `require_secure_transport=ON`,** the `dam_svc` login must connect over TLS —
> add `--ssl-mode=REQUIRED` to the test and set the agent accordingly. Check with:
> `SHOW VARIABLES LIKE 'require_secure_transport';`

---

## Phase 3 — Agent host readiness

The AgentLite agent for MySQL runs **on the DB host** (it tails a local file).

☐ **3.1 — Architecture is amd64** (arm64/Graviton not supported):
```bash
uname -m          # PASS: x86_64
```

☐ **3.2 — Container runtime OR systemd available** (pick your install method):
```bash
docker --version   # Option A
# or
systemctl --version && ls /etc/toovix 2>/dev/null   # Option B (native .deb/.rpm)
```
**PASS:** one of the two is available.

☐ **3.3 — Agent can read the log file.** The general log is `640 mysql:adm` / dir `750`. The shipped
`.deb`/`.rpm` runs as **root + `CAP_DAC_READ_SEARCH`**; the Docker command uses `--user 0`. Confirm the path
is readable by root:
```bash
sudo test -r /var/log/mysql/general.log && echo "readable" || echo "FIX perms"
```
**PASS:** prints `readable`. (Custom systemd units must add `CAP_DAC_READ_SEARCH`.)

☐ **3.4 — Disk headroom + rotation for the growing log:**
```bash
df -h /var/log
ls -l /etc/logrotate.d/ | grep -i mysql
```
**PASS:** enough free space for the expected log growth, and a logrotate rule exists.

> **Host (eBPF) mode only — extra checks (skip for AgentLite):**
> `uname -r` ⇒ kernel **≥ 5.8**; DB has **TLS enabled** (libssl mapped — eBPF hooks it, so no TLS = no
> capture); root / `CAP_BPF`+`CAP_PERFMON`. A plaintext-only DB is **not** a candidate for host mode.

---

## Phase 4 — Network & connectivity

☐ **4.1 — Agent host → DB reachable** (for classification + instance identity):
```bash
nc -zv <DB_HOST> 3306         # or: mysqladmin -h <DB_HOST> -u dam_svc -p ping
```
**PASS:** port 3306 open / `mysqld is alive`.

☐ **4.2 — Agent host → DAM control plane over HTTPS (443) — the critical egress check:**
```bash
curl -sS -o /dev/null -w "http=%{http_code}\n" https://dam.yourcompany.com/api/health
```
**PASS:** returns `http=200`. If it hangs or fails, fix egress **now** — the agent only dials outbound; no
inbound rules are needed. (GCP: Cloud NAT / external IP. AWS: NAT GW + SG egress 443. Azure: NAT / NSG
`AllowInternetOutBound`.)

☐ **4.3 — DNS + TLS to the control plane resolve cleanly** (catches split-horizon / proxy issues):
```bash
curl -sS -I https://dam.yourcompany.com/api/health | head -1
```
**PASS:** a `200`/`401` status line (not a cert error or timeout).

> **PASS Phase 4:** DB reachable **and** outbound 443 to DAM works. This is the #1 cause of "agent enrolled
> but nothing shows."

---

## Phase 5 — DAM control-plane readiness

☐ **5.1 — The client tenant/workspace exists** in DAM, and you know its **slug**.

☐ **5.2 — Use a per-tenant enrollment token — never the global/dev default.**
In the console: **Agents → Deploy monitoring** (or **Databases → register instance → Deploy**), select
**AgentLite (Audit Forwarder)**, copy the `tvxenr_…` token + the control-plane URL.
**PASS:** token starts with `tvxenr_` and belongs to **this client's** workspace (not a shared/dev token).

☐ **5.3 — Register the database instance** in the console so `TARGET_HOST` matches the instance identity
(use the DB's **private IP/hostname**, unique per DB — never `127.0.0.1`, or multiple DBs collapse into one).

> **PASS Phase 5:** tenant confirmed, per-tenant token in hand, instance registered with a unique host id.

---

## Phase 6 — Deploy the agent

Set once:
```bash
CONTROL_PLANE="https://dam.yourcompany.com"     # Phase 5
ENROLL_TOKEN="tvxenr_xxxxxxxxxxxxxxxxxxxx"       # Phase 5
AUDIT_LOG="/var/log/mysql/general.log"           # Phase 2
DB_VM_HOST="10.0.0.10"                            # DB private IP (Phase 0.3 / 5.3)
```

**Option A — Docker:**
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
  <your-dam-agent-image>
# add classification: -e CLASSIFY=true -e DB_USER=dam_svc -e DB_PASSWORD=<pw>
```

**Option B — Native .deb/.rpm + systemd:**
```bash
curl -fsSL ${CONTROL_PLANE}/api/download/dam-agent_amd64.deb -o dam-agent.deb
sudo dpkg -i dam-agent.deb
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
```

☐ **6.1 — Confirm a healthy start:**
```bash
docker logs -f toovix-agent-audit          # Option A
journalctl -u dam-agent@audit -f           # Option B
```
**PASS:** logs show `enrolled: agent=… instance=… tenant=…` and
`AgentLite audit-forward tailing /var/log/mysql/general.log (source=general_log engine=mysql)` —
**no** token error, **no** permission-denied.

---

## Phase 7 — Verification (smoke test)

☐ **7.1 — Generate a distinctive query over TCP:**
```bash
mysql -h 127.0.0.1 -u <user> -p -e "SELECT 'dam-verify-123', NOW();"
```

☐ **7.2 — Confirm it lands in DAM.** Console → **Databases → your instance → Database Activity** (in the
**same workspace** as the token). Within seconds you should see `SELECT 'dam-verify-123'…` attributed to the
DB + principal.
**PASS:** the event appears, correct instance, correct tenant.

☐ **7.3 — Heartbeat/health.** The instance shows a recent agent check-in / "connected" state in the console.

☐ **7.4 — (If classification enabled)** columns get PII/PCI tags within a scan cycle.

> **PASS Phase 7:** live query visible in the client's workspace = capture confirmed.

---

## Phase 8 — Post-onboarding hardening & handover

☐ **8.1 — Baseline policies enabled** for this instance (mass-read where applicable, sensitive-object access,
after-hours, DDL change log).
☐ **8.2 — Rotate/secure `dam_svc`** password per policy; store in the client's password manager.
☐ **8.3 — Protect the general log** — it holds every statement in cleartext (PII/PCI). Restrict file perms;
confirm it's covered by the client's data-handling policy.
☐ **8.4 — Confirm log rotation is not truncating capture** (AgentLite follows rotation, but verify after the
first rotate).
☐ **8.5 — Document the instance** in the runbook: host, mode, token owner, audit path, monitoring user.
☐ **8.6 — Set expectations in writing:** AgentLite is **detective-only** (no blocking) and the general log
carries **no row counts** — if the client needs either, plan network/host/inline-proxy mode.

---

## Rollback (clean removal)

```bash
# stop + remove the agent
docker rm -f toovix-agent-audit                     # Option A
sudo systemctl disable --now dam-agent@audit        # Option B

# (optional) turn the general log back off on the DB
mysql -e "SET GLOBAL general_log='OFF';"
sudo rm -f /etc/mysql/mysql.conf.d/zz-toovix-audit.cnf

# (optional) remove the monitoring user
mysql -e "DROP USER 'dam_svc'@'%';"
```

---

## One-page quick gate

| Gate | Command | PASS |
|---|---|---|
| Version | `SELECT VERSION();` | 5.7/8.x or MariaDB 10.x |
| Log on | `SHOW VARIABLES LIKE 'general_log%';` | `ON` + path |
| Log to file | `SHOW VARIABLES LIKE 'log_output';` | `FILE` |
| Log writing | tail + test query | line appears |
| Reader user | `SHOW GRANTS FOR 'dam_svc'@'%';` | `SELECT, PROCESS` only |
| DB reachable | `nc -zv <DB_HOST> 3306` | open |
| **Egress to DAM** | `curl -w '%{http_code}' .../api/health` | **200** |
| Token | (console) | `tvxenr_…`, right tenant |
| Enrolled | agent logs | `enrolled: … tenant=…` |
| Live capture | run query → console | event visible |

*Engine other than MySQL, or a managed/PaaS DB? See `agentlite-mysql-vm-setup.md` (all engines) and
`sop-azure-onboarding.md`. For blocking or row counts on MySQL, see `capture-modes.md`.*
