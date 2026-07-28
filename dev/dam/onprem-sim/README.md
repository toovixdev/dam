# Simulate an on-prem database in a Linux VM and connect it to TooVix DAM

This harness turns a Mac into a stand-in for a **self-managed, on-premises database
server**: a real Ubuntu VM running MySQL, monitored by TooVix DAM using **AgentLite
(audit-forward)** — the same native-package path a real customer uses on a VM they own.

```
 ┌────────────────── Ubuntu VM on your Mac (the "on-prem" server) ──────────────────┐
 │   MySQL 8  ──general query log──►  dam-agent (.deb, systemd, audit-forward)        │
 └────────────────────────────────────────────────────────────────┬─────────────────┘
                                                                    │ outbound HTTPS (443)
                                                                    ▼
                                                  TooVix DAM control plane
                                                (https://dam.suchirasoistories.in)
```

The agent only dials **out** — DAM never connects into the VM. Built for an **Intel Mac**
(amd64), so the VM and the prebuilt amd64 agent run natively.

## Prerequisites
1. **Multipass** on the Mac: `brew install --cask multipass` (or https://multipass.run).
2. An **enrollment token** from the DAM console: **Agents → Deploy monitoring →
   AgentLite (Audit Forwarder)** → copy the token (`tvxenr_…`). It's per-tenant, so
   activity lands in your workspace.

---

## Run it

**1. Launch an Ubuntu VM** (on the Mac host):
```bash
multipass launch 22.04 --name onprem --cpus 2 --memory 2G --disk 10G
```

**2. Get this harness into the VM.** Either clone the repo inside the VM:
```bash
multipass exec onprem -- bash -c 'sudo apt-get update -qq && sudo apt-get install -y -qq git &&
  git clone https://github.com/toovixdev/dam.git'
```
…or, if the repo is already on the Mac, copy just this folder in:
```bash
multipass transfer -r /path/to/dam/dev/dam/onprem-sim onprem:onprem-sim
```

**3. Run the setup inside the VM** (installs MySQL, seeds data, installs + starts the agent):
```bash
multipass shell onprem
#   inside the VM:
cd dam/dev/dam/onprem-sim         # or ~/onprem-sim if you used `transfer`
chmod +x setup-onprem.sh gen-traffic.sh
ENROLL_TOKEN=tvxenr_your_token_here ./setup-onprem.sh
```

A healthy agent start (see `sudo journalctl -u dam-agent@onprem -f`) looks like:
```
=== TooVix DAM Agent · mode=audit-forward engine=mysql target=<vm-ip>:3306 ===
enrolled: agent=… instance=… tenant=…
AgentLite audit-forward tailing /var/log/mysql/general.log (source=general_log engine=mysql)
```

**4. Generate activity** (inside the VM):
```bash
./gen-traffic.sh
```

Then open **DAM → Databases → `MYSQL-ONPREM-LAPTOP` → Database Activity**. Within a few
seconds you'll see the queries attributed to `appuser`, and after the first classification
pass the `customers`/`cards` columns flagged **PII/PCI**.

> View the DAM console in the **same workspace** the enrollment token belongs to — agents
> are tenant-scoped.

---

## Teardown
```bash
multipass stop onprem      # pause it
multipass delete onprem && multipass purge   # remove it entirely
```
Then delete/decommission the instance in the DAM console.

---

## Notes & knobs
- **Instance identity** defaults to the VM's primary IP; override with
  `DB_IDENTITY=onprem-db-01 ENROLL_TOKEN=… ./setup-onprem.sh` (keep it reachable — the agent
  connects to it for classification; MySQL is bound to `0.0.0.0` for that).
- **No row counts** on this MySQL path (the general log doesn't carry them). For mass-read /
  exfiltration volume, add a second agent in `network` or `host` (eBPF) mode on the same VM —
  both give row counts. See `dev/dam/docs/agentlite-mysql-vm-setup.md`.
- **Other engines**: install `postgresql`/`mongodb` instead and set the matching
  `DB_ENGINE`/`AUDIT_SOURCE` per that guide — the agent + systemd flow is identical.
- The passwords in `seed.sql` are throwaway demo values. The only real secret — your
  enrollment token — is passed at runtime and never written to the repo.
