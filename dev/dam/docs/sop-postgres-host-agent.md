# SOP — Install the Host (eBPF) Agent on a PostgreSQL VM

**Purpose:** onboard a self-managed **PostgreSQL on a VM** into TooVix DAM using **host (eBPF) capture** —
uprobes on `libssl` that read plaintext *below* TLS. Includes the pre-checks (go/no-go gates) and the install.

**⭐ Hard requirement:** host mode hooks `libssl`, so **PostgreSQL must use TLS and your app must actually
connect over TLS**. If traffic is plaintext (or unix-socket), libssl is never loaded/called and the agent
captures **nothing** (it logs *"the DB may not be TLS-enabled; retrying"*). If you can't guarantee TLS, use
**network mode** (plaintext wire) or **AgentLite** (statement log) instead — see the trade-offs at the end.

**Legend:** ☐ check · **PASS** = condition required to proceed. Do not install until Part 1 passes.

---

## Part 1 — Pre-checks (run on the Postgres VM)

### A. Host & kernel (eBPF requirements)
```bash
uname -m                       # PASS: x86_64  (arm64/Graviton NOT supported)
uname -r                       # PASS: kernel >= 5.8  (CO-RE uprobes + ringbuf)
ls -l /sys/kernel/btf/vmlinux  # PASS: exists  (BTF needed for CO-RE)
id -u                          # PASS: 0 or sudo available (host mode runs privileged)
```

### B. The Postgres process is discoverable
```bash
pgrep -x postgres              # PASS: returns PIDs
# If empty, your postmaster comm differs (e.g. 'postmaster'); note it for DB_PROC_COMM in Part 2.
```

### C. ⭐ TLS enabled AND libssl mapped (make-or-break)
```bash
sudo -u postgres psql -c "SHOW ssl;"            # PASS: on
sudo grep -l libssl /proc/$(pgrep -x postgres | head -1)/maps \
  && echo "libssl mapped ✓" || echo "NO libssl — host mode will capture nothing"
```

### D. ⭐ The application connects over TLS (not plaintext, not unix socket)
```sql
-- in psql: how many live client connections are actually TLS?
SELECT s.ssl, count(*)
FROM pg_stat_ssl s JOIN pg_stat_activity a ON a.pid = s.pid
WHERE a.backend_type = 'client backend'
GROUP BY s.ssl;
```
**PASS: your app's rows show `ssl = t`.**
- `ssl = f` (plaintext) → host mode won't see them → use **network mode**.
- **Local `psql` over the unix socket is never TLS** → invisible to host mode. Only **TCP + SSL** is captured.

> **This is the go/no-go gate.** If C or D fail and you can't move the app onto TLS, **stop** and use
> network mode or AgentLite. Host mode is only correct when the traffic is TLS. If you *want* to stay on
> host mode and the DB is currently plaintext (`SHOW ssl` = `off`), you can enable TLS first —
> see **Appendix A** — then return here.

### E. Egress to the control plane
```bash
curl -sS -o /dev/null -w "egress=%{http_code}\n" https://dam.yourcompany.com/api/health   # PASS: 200
```

### F. Token + instance (DAM console)
☐ **Agents → Deploy monitoring → Host (eBPF)** → copy the `tvxenr_…` token.
☐ Register the DB instance with its **private IP** (unique per DB).

---

## Part 2 — Install

Set once:
```bash
CONTROL_PLANE="https://dam.yourcompany.com"
ENROLL_TOKEN="tvxenr_xxxxxxxxxxxxxxxxxxxx"
DB_VM_HOST="10.0.0.30"        # this VM's private IP (unique per DB = instance identity)
```

### Option A — native .deb + systemd (recommended on a VM)
The shipped unit already carries the needed caps (`CAP_BPF CAP_PERFMON CAP_SYS_ADMIN CAP_SYS_PTRACE …`).
```bash
curl -fsSL ${CONTROL_PLANE}/api/download/dam-agent_amd64.deb -o dam-agent.deb
sudo dpkg -i dam-agent.deb          # RHEL/Rocky: dam-agent_amd64.rpm + dnf install

sudo mkdir -p /etc/toovix
sudo tee /etc/toovix/agent-host.env >/dev/null <<EOF
MODE=host
DB_ENGINE=postgresql
TARGET_HOST=${DB_VM_HOST}
TARGET_PORT=5432
AGENT_ENROLL_TOKEN=${ENROLL_TOKEN}
CONTROL_PLANE=${CONTROL_PLANE}
# DB_PROC_COMM=postgres          # ONLY if pre-check B showed a different comm (e.g. postmaster)
# LARGE_RESULT_BYTES=1048576     # (optional) flag reads over this size as large-result
EOF

sudo systemctl enable --now dam-agent@host
journalctl -u dam-agent@host -f
```

### Option B — Docker (needs host namespaces to see the DB process + its libssl)
```bash
docker run -d --name toovix-agent-host --restart unless-stopped \
  --privileged --pid host --network host \
  -e MODE=host \
  -e DB_ENGINE=postgresql \
  -e TARGET_HOST=${DB_VM_HOST} \
  -e TARGET_PORT=5432 \
  -e AGENT_ENROLL_TOKEN=${ENROLL_TOKEN} \
  -e CONTROL_PLANE=${CONTROL_PLANE} \
  <your-dam-agent-image>
```

### Healthy start
```
=== TooVix DAM Agent · mode=host engine=postgresql target=10.0.0.30:5432 ===
enrolled: agent=… instance=… tenant=…
host: DB process "postgres" pid=1234 uses /usr/lib/x86_64-linux-gnu/libssl.so.3
host: attached uprobe SSL_write / SSL_read
[capture] SELECT  rows=…  <user>  SELECT …
```
❌ Looping on `has no libssl mapped yet — the DB may not be TLS-enabled; retrying` → pre-checks C/D failed.

---

## Part 3 — Verify (must be TCP + TLS; unix-socket local psql won't show)
```bash
psql "host=${DB_VM_HOST} port=5432 dbname=yourdb user=youruser sslmode=require" \
  -c "SELECT 'dam-host-verify-123', now();"
```
Console → **Databases → your instance → Database Activity** (same workspace as the token) → the statement
appears within seconds. **PASS: event visible.**

---

## Part 4 — (Optional) classification / VA read-only login
Host capture needs no DB login. For column classification / VA scanning, add a read-only `dam_svc`
(see `sop-postgres-dam-svc.md`) and set `CLASSIFY=true DB_USER=dam_svc DB_PASSWORD=… DB_NAME=yourdb`
in the agent env.

---

## Trade-offs — why host mode (and when not to)
- ✅ Row counts / result sizes (large-read detection); works on TLS without a proxy or path change.
- ⚠️ **TLS-only**; **amd64 + kernel ≥ 5.8**; runs **privileged on the DB host**; **doesn't see unix-socket
  local connections**.
- Doesn't fit? → **network mode** (plaintext wire, no TLS) or **AgentLite** (statement log; transport-
  independent; detect-only, no row counts). See `capture-modes.md`.

## Troubleshooting
| Symptom | Cause & fix |
|---|---|
| Loops on "no libssl mapped / may not be TLS-enabled" | Pre-check C/D: PG not TLS, or app is plaintext. Enable `ssl=on` + move the app to `sslmode=require`, or switch to network mode. |
| Enrolled but no events, TLS confirmed | You're testing over the **unix socket** (not TLS). Verify with `host=<ip> sslmode=require` over TCP. |
| `attach uprobe … failed` | Kernel < 5.8, missing BTF, or not privileged. Recheck Part 1 A; ensure the container is `--privileged --pid host`. |
| Process not found | Postmaster comm isn't `postgres` → set `DB_PROC_COMM=<comm from pgrep>`. |
| Wrong workspace | View the console in the **same tenant** the enroll token belongs to. |

---

## Appendix A — Enabling PostgreSQL TLS first (when `SHOW ssl` = `off`)

Only needed if pre-check C/D failed **and** you specifically want host mode. This changes the **DB config**
*and* the **app's connection string** — do it in a maintenance window with the app owner. Commands as
**root** on the VM unless noted.

> ⚠️ Two things that bite: (1) the **app-side change is mandatory** — any client still connecting plaintext
> or via the **unix socket** is invisible to host mode; (2) enabling `hostssl` **rejects plaintext**, so it
> can lock out clients that aren't on TLS yet. Move the app to TLS *before* enforcing `hostssl`.

### A1. Locate config + data dir
```bash
PGDATA=$(sudo -u postgres psql -tAc "SHOW data_directory;")
sudo -u postgres psql -tAc "SHOW config_file;"   # postgresql.conf
sudo -u postgres psql -tAc "SHOW hba_file;"      # pg_hba.conf
```

### A2. Create a server cert + key (self-signed is fine; `sslmode=require` doesn't verify the cert)
```bash
cd "$PGDATA"
openssl req -new -x509 -days 825 -nodes -text -out server.crt -keyout server.key -subj "/CN=$(hostname)"
chown postgres:postgres server.key server.crt
chmod 600 server.key          # PostgreSQL refuses to start if the key perms are loose
```

### A3. Turn SSL on + apply
```bash
sudo -u postgres psql -c "ALTER SYSTEM SET ssl = 'on';"   # writes postgresql.auto.conf
sudo -u postgres psql -c "SELECT pg_reload_conf();"
sudo -u postgres psql -tAc "SHOW ssl;"                     # want: on
# if still off, full restart (unit name varies: postgresql / postgresql-16 / ...):
#   systemctl restart postgresql
```

### A4. Move the APP onto TLS (host mode captures nothing until clients actually use TLS)
Client side — update the DSN and restart the app:
```
postgresql://user:pass@dbhost:5432/yourdb?sslmode=require
# JDBC:  jdbc:postgresql://dbhost:5432/yourdb?ssl=true&sslmode=require
```
Server side (optional hardening, AFTER the app is on TLS) — change the app's `host` rule to `hostssl` in
`pg_hba.conf`, then `SELECT pg_reload_conf();`:
```
hostssl    yourdb    appuser   10.0.0.0/24   scram-sha-256
```

### A5. Re-verify, then return to Part 1 pre-check C/D
```bash
sudo -u postgres psql -tAc "SHOW ssl;"                                   # on
grep -l libssl /proc/$(pgrep -x postgres | head -1)/maps && echo "libssl ✓"
sudo -u postgres psql -d yourdb -c \
 "SELECT s.ssl, count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a ON a.pid=s.pid WHERE a.backend_type='client backend' GROUP BY s.ssl;"
```
PASS: `ssl`=on, libssl mapped (it maps once the first TLS backend connects), app rows `ssl = t`. Then
proceed to **Part 2 — Install**.
