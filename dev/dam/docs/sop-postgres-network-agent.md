# SOP — Install the Network Agent on a PostgreSQL VM

**Purpose:** onboard a self-managed **PostgreSQL on a VM** into SecurEra DAM using **network (passive)
capture** — an AF_PACKET sniffer that decodes the Postgres wire protocol **in the clear**. This is the right
mode for a **plaintext** database (the common case) and gives you full SQL visibility **plus row counts**,
with **no eBPF/kernel requirements** and **no changes to the DB or the app**.

**⭐ Two hard requirements** (the go/no-go gates):
1. **Traffic must be plaintext** — network mode **cannot decode TLS** (it sees only ciphertext). If clients
   connect over TLS, use **host mode** instead.
2. **Traffic must be over TCP** — a passive sniffer sees **no packets** for **unix-socket** connections. If
   the app connects on the local socket, use **AgentLite** (statement log) instead.

**Legend:** ☐ check · **PASS** = condition required to proceed. Don't install until Part 1 passes.

---

## Part 1 — Pre-checks (run on the Postgres VM)

### A. Host & privileges (much lighter than host/eBPF mode)
```bash
uname -m        # PASS: x86_64  (agent binary is amd64)
id -u           # PASS: 0, or sudo available (packet capture needs CAP_NET_RAW / root)
```
> No kernel-version / BTF / libssl requirement — network mode is plain AF_PACKET, not eBPF.

### B. ⭐ Traffic is PLAINTEXT (network mode can't read TLS)
```bash
sudo -u postgres psql -tAc "SHOW ssl;"       # off = good for network mode
# and confirm the APP's live connections aren't negotiating TLS anyway:
sudo -u postgres psql -d yourdb -c \
 "SELECT s.ssl, count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a ON a.pid=s.pid WHERE a.backend_type='client backend' GROUP BY s.ssl;"
```
**PASS: app rows show `ssl = f` (or `SHOW ssl` = off).**
- Any app rows with `ssl = t` → those sessions are opaque to network mode → use **host mode** for them.

### C. ⭐ Traffic is over TCP (not the unix socket)
```bash
sudo -u postgres psql -d yourdb -c \
 "SELECT COALESCE(host(client_addr)::text,'unix-socket') AS conn, count(*) \
  FROM pg_stat_activity WHERE backend_type='client backend' GROUP BY 1;"
```
**PASS: your app's rows show an IP address (TCP).**
- Only `unix-socket` (i.e. `client_addr` is NULL) → no packets to sniff → use **AgentLite**.

### D. ⭐ Identify the capture interface (the #1 cause of "0 events")
Network mode sniffs **one** interface (`CAPTURE_IFACE`, default `eth0`). Traffic location depends on where
clients connect from:
```bash
# who is connected to 5432, and from which peer address?
ss -tnH state established '( sport = :5432 )' | awk '{print $4"  <-  "$5}'
# list this host's interfaces + IPs
ip -o -4 addr show | awk '{print $2, $4}'
```
Decide `CAPTURE_IFACE`:
- **Remote app** (peer is another host's IP) → the **primary NIC** that owns that local IP (e.g. `eth0`, `ens5`).
- **Same-host app** connecting to `127.0.0.1`/`localhost` → traffic is on **`lo`** → set `CAPTURE_IFACE=lo`.
- **Not sure / mixed** → set **`CAPTURE_IFACE=any`** (sniffs all interfaces incl. loopback; slightly more overhead but foolproof).

**PASS: you know which interface carries the app↔DB packets** (or you'll use `any`).

### E. Egress to the control plane
```bash
curl -sS -o /dev/null -w "egress=%{http_code}\n" https://dam.yourcompany.com/api/health   # PASS: 200
```

### F. Token + instance (DAM console)
☐ **Agents → Deploy monitoring → Network** → copy the `tvxenr_…` token.
☐ Register the DB instance with its **private IP** (unique per DB).

---

## Part 2 — Install

Set once:
```bash
CONTROL_PLANE="https://dam.yourcompany.com"
ENROLL_TOKEN="tvxenr_xxxxxxxxxxxxxxxxxxxx"
DB_VM_HOST="10.0.0.30"        # this VM's private IP (unique per DB = instance identity)
CAPTURE_IFACE="any"           # from pre-check D: eth0 / ens5 / lo / any
```

### Option A — native .deb + systemd (recommended on a VM)
The shipped unit runs as root with `CAP_NET_RAW` (among others).
```bash
curl -fsSL ${CONTROL_PLANE}/api/download/dam-agent_amd64.deb -o dam-agent.deb
sudo dpkg -i dam-agent.deb           # RHEL/Rocky: dam-agent_amd64.rpm + dnf install

sudo mkdir -p /etc/toovix
sudo tee /etc/toovix/agent-network.env >/dev/null <<EOF
MODE=network
DB_ENGINE=postgresql
TARGET_HOST=${DB_VM_HOST}
TARGET_PORT=5432
CAPTURE_IFACE=${CAPTURE_IFACE}
AGENT_ENROLL_TOKEN=${ENROLL_TOKEN}
CONTROL_PLANE=${CONTROL_PLANE}
# CAPTURE_DEBUG=true             # (optional) logs "N frames seen on <iface>" to confirm sniffing
# LARGE_RESULT_BYTES=1048576     # (optional) flag reads over this size as large-result
EOF

sudo systemctl enable --now dam-agent@network
journalctl -u dam-agent@network -f
```

### Option B — Docker (needs the host network to see the traffic)
```bash
docker run -d --name toovix-agent-network --restart unless-stopped \
  --network host --cap-add NET_RAW --cap-add NET_ADMIN \
  -e MODE=network \
  -e DB_ENGINE=postgresql \
  -e TARGET_HOST=${DB_VM_HOST} \
  -e TARGET_PORT=5432 \
  -e CAPTURE_IFACE=${CAPTURE_IFACE} \
  -e AGENT_ENROLL_TOKEN=${ENROLL_TOKEN} \
  -e CONTROL_PLANE=${CONTROL_PLANE} \
  <your-dam-agent-image>
# --network host is required so the container sees the host's interfaces/traffic.
```

### Healthy start
```
=== SecurEra DAM Agent · mode=network engine=postgresql target=10.0.0.30:5432 ===
enrolled: agent=… instance=… tenant=…
network agent sniffing any for tcp/5432 engine=postgresql (passive capture, debug=false)
[capture] SELECT  rows=…  <user>  SELECT …
```

---

## Part 3 — Verify

Run a distinctive query **over TCP** on the path the agent is sniffing (match your `CAPTURE_IFACE`: use the
VM's IP for a NIC, `127.0.0.1` for `lo`/`any`):
```bash
psql "host=${DB_VM_HOST} port=5432 dbname=yourdb user=youruser sslmode=disable" \
  -c "SELECT 'dam-net-verify-123', now();"
```
Console → **Databases → your instance → Database Activity** (same workspace as the token) → the statement
appears within seconds. **PASS: event visible.**

> If nothing appears, set `CAPTURE_DEBUG=true` and watch `journalctl -u dam-agent@network -f`:
> `N frames seen on <iface>` climbing = right interface (decoding issue); staying at 0 = **wrong
> `CAPTURE_IFACE`** → switch to `any`, or pick the interface from pre-check D.

---

## Part 4 — (Optional) classification / VA read-only login
Capture needs no DB login. For column classification and/or VA scanning add a read-only `dam_svc`
(see `sop-postgres-dam-svc.md`, which grants `pg_monitor` — all VA needs on PostgreSQL) and set:
```
DB_USER=dam_svc DB_PASSWORD=… DB_NAME=yourdb
CLASSIFY=true          # PII/PCI column classification
VA_SCAN=true           # CIS checks + CVE/patch review + entitlement review
```
Both are independent of network capture — turn on either or both. After restart, VA runs its first
scan ~20 s in (then every `VA_SCAN_INTERVAL_MIN`, default 12 h); confirm with
`journalctl -u dam-agent@<name> | grep -iE 'VA context|VA scan reported|VA entitlements'`.
Findings land under **Vulnerability** in the console.

---

## Trade-offs — why network mode (and when not to)
- ✅ **Plaintext-friendly**, full SQL + **row counts**, **no eBPF/kernel reqs**, **no DB/app changes**, and
  can even run on a host that only sees a **SPAN/mirror** of the traffic.
- ⚠️ **Can't decode TLS** (→ host mode), **can't see unix-socket** connections (→ AgentLite), **detective
  only** (no blocking → inline proxy), and needs the **right `CAPTURE_IFACE`**.

## Troubleshooting
| Symptom | Cause & fix |
|---|---|
| Enrolled, but no events; `CAPTURE_DEBUG` shows **0 frames** | Wrong `CAPTURE_IFACE`. Set `any`, or pick the NIC/`lo` from pre-check D. |
| Frames climbing but still no SQL events | Traffic is **TLS** (ciphertext) → network mode can't decode → use host mode. |
| Some sessions captured, others missing | Missing ones are **unix-socket** or **TLS**. Add AgentLite (socket) or host mode (TLS) for those. |
| `interface eth0 not found` | This VM's NIC isn't `eth0` (e.g. `ens5`). Set `CAPTURE_IFACE` to the real name (`ip -o -4 addr`) or `any`. |
| Local `psql` not captured on a NIC | Loopback traffic isn't on the NIC. Use `CAPTURE_IFACE=lo` or `any`, and connect via `127.0.0.1`. |
| Wrong workspace | View the console in the **same tenant** the enroll token belongs to. |

## Running network + host together (mixed-transport DBs)
A DB with **both** plaintext and TLS clients can run **both** agents (`dam-agent@network` + `dam-agent@host`)
with **no double-counting** — a connection is either encrypted or not, so each session is decoded by exactly
one agent (network=plaintext, host=TLS). Do **not** pair a passive agent with the inline proxy (the proxy
re-emits traffic → duplicates). See `sop-postgres-host-agent.md`.
