# Integrating a MySQL-on-VM Database with TooVix DAM — AgentLite Setup Guide

**Audience:** a customer/operator with a **MySQL database running on a Linux VM** in **GCP, AWS, or Azure** who wants that database monitored by TooVix DAM using the **AgentLite (audit-forward)** approach.

**Time:** ~15–20 minutes. **Access needed:** `sudo`/root on the DB VM, and MySQL admin (`root`) to enable auditing.

---

## 1. What AgentLite is (and what it isn't)

**AgentLite** is a lightweight forwarder you install **on the database host**. It **tails MySQL's own general query log** and ships each statement to TooVix DAM.

- ✅ **No wire tap, no proxy, no path change** — it reads a log file the database already writes.
- ✅ **Transport-independent** — because it reads what the DB logs *after* decryption, it captures **TLS-encrypted** client sessions too.
- ✅ **Works on private, no-public-IP databases** — the agent only makes **outbound** connections to DAM; DAM never connects into your network.
- ⚠️ **Detective only** — it observes and alerts **after the fact**; it **cannot block** a query. (Use Inline Proxy mode if you need prevention.)
- ⚠️ **Records all SQL** — the MySQL general log captures every statement from every session in cleartext on the VM. Treat the log file as sensitive (see §9).

**Flow:**
```
MySQL (general log)  →  AgentLite forwarder (on the DB VM)  →  TooVix DAM  →  Database Activity view
                         reads /var/log/mysql/general.log      (HTTPS, or GCP Pub/Sub)
```

**Requirements:**
- Linux VM, **x86-64 (amd64)**. (arm64 / Graviton is not supported yet.)
- MySQL 5.7 / 8.x (or MariaDB 10.x).
- **Outbound HTTPS (443)** from the VM to your DAM control-plane URL. See §7 for per-cloud egress.

---

## 2. Step 1 — Enable the MySQL general query log

AgentLite reads MySQL's **general query log written to a file**. Enable it and point it at a known path.

Log in as MySQL admin and run:

```sql
-- write the log to a FILE (not a table), at a fixed path
SET GLOBAL log_output      = 'FILE';
SET GLOBAL general_log_file = '/var/log/mysql/general.log';
SET GLOBAL general_log      = 'ON';
```

**Make it survive a MySQL restart** — the `SET GLOBAL` above is runtime-only. Add a config drop-in:

```bash
# Debian/Ubuntu: /etc/mysql/mysql.conf.d/  ·  RHEL/Rocky: /etc/my.cnf.d/
sudo tee /etc/mysql/mysql.conf.d/zz-toovix-audit.cnf >/dev/null <<'EOF'
[mysqld]
log_output       = FILE
general_log      = 1
general_log_file = /var/log/mysql/general.log
EOF
```

Verify the file is being written:
```bash
sudo tail -f /var/log/mysql/general.log   # run a query in another session; lines should appear
```

> **Note on volume:** the general log grows with every query. For busy databases, ensure log rotation (`logrotate`) and adequate disk. AgentLite tails the live file and handles rotation/truncation automatically.

---

## 3. Step 2 — (Optional) Create a read-only user for classification

DAM can classify which columns hold PII/PCI. This is **separate from capture** — it logs into MySQL as a **least-privilege reader**. Skip this if you only want activity capture.

```sql
CREATE USER 'dam_svc'@'%' IDENTIFIED BY '<choose-a-strong-password>';
GRANT SELECT, PROCESS ON *.* TO 'dam_svc'@'%';
FLUSH PRIVILEGES;
```

`dam_svc` gets **read-only** access (`SELECT` for schema inspection, `PROCESS` for session metadata) — it can never modify data.

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

## 8. (GCP only, optional) Publish to Pub/Sub instead of direct HTTPS

On **GCP**, you can decouple the agent from DAM by publishing audit events to a **Cloud Pub/Sub** topic that DAM consumes (durable buffer; survives brief DAM outages). This is optional — direct HTTPS (§5) works fine.

**Coordinate with your DAM operator** — they provide the **topic name** and run the subscription consumer. Then:

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
