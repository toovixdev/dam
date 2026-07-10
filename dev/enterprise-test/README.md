# TooVix DAM — Enterprise Cloud Test (GCP)

Provisions a realistic multi-VPC MySQL estate on GCP and points it at your TooVix DAM
platform:

| DB | Deployment | VPC / subnet | Capture mode |
|----|------------|--------------|--------------|
| `db-vm-a` | MySQL 8 on a Compute Engine **VM** | own VPC, private subnet | **Network agent** (TooVix Go agent on the VM) |
| `db-vm-b` | MySQL 8 on a Compute Engine **VM** | own VPC, private subnet | **Network agent** |
| `db-paas` | **Cloud SQL for MySQL** (PaaS) | own VPC, private IP (PSA) | **Inline proxy** agent VM *or* audit-log Cloud Push |

Each database lives in its **own VPC** with a **private subnet** (no public IPs). Egress to the
DAM platform + package/registry mirrors is via **Cloud NAT**.

---

## Architecture / connectivity model (what to decide first)

The agents must reach two TooVix endpoints:

1. **Control-plane API** — enroll / heartbeat / quarantine-list / masking-policy
   (`/api/agents/*`). Default port `3000` (or behind your reverse proxy on `443`).
2. **ClickHouse ingest** — the agent writes events straight to ClickHouse over HTTP
   (default `8123`) using a **write-only** user.

Because every DB is in a **private** subnet, the VMs reach these via **Cloud NAT** to your
DAM platform's **public** endpoints. Two supported topologies:

- **POC (default here):** expose the DAM API + ClickHouse publicly, **secured** (TLS + the
  enrollment token + a restricted ClickHouse user), and lock ingress to your NAT egress IPs.
- **Production:** peer each DB VPC to a shared **DAM services VPC** (VPC Peering / PSC) and
  keep the endpoints private. The Terraform variables point at whatever host you give — set
  them to peered private IPs instead of public ones and the rest is unchanged.

> This Terraform provisions the **customer/database side**. Your DAM platform (control plane +
> ClickHouse) is assumed already running (your existing GCP VM works) — you just make its
> agent endpoints reachable and pass their URLs in as variables.

---

## Part 1 — Prerequisites (before `terraform apply`)

### A. On the TooVix DAM platform (one-time)
1. **Expose the agent endpoints** the VMs will call:
   - Control-plane API: `POST /api/agents/enroll`, `POST /api/agents/:id/heartbeat`,
     `GET /api/agents/quarantine-list`, `GET /api/agents/masking-policy`,
     `POST /api/quarantine`, `POST /api/agents/alert`.
   - ClickHouse HTTP (`8123`) for `INSERT INTO dam_analytics.events`.
   Put both behind TLS. Restrict ingress to the NAT egress IPs (Terraform outputs them).
2. **Create a write-only ClickHouse user** for agents (never `default`/admin) with `INSERT`
   on `dam_analytics.events` only. Pass it as `dam_clickhouse_user/password`.
3. **Set an enrollment token** (`AGENT_ENROLL_TOKEN`) on the platform and pass the same value
   as `agent_enroll_token`. This is how agents authenticate to enroll + fetch quarantine list.
4. **Publish the agent image.** The TooVix Go agent (`dev/dam/agent`) isn't on a public
   registry, so build + push it to **Artifact Registry** once:
   ```bash
   REGION=us-central1; PROJECT=<your-project>
   gcloud artifacts repositories create toovix --repository-format=docker --location=$REGION
   gcloud auth configure-docker $REGION-docker.pkg.dev
   docker build -t $REGION-docker.pkg.dev/$PROJECT/toovix/agent:latest dev/dam/agent
   docker push  $REGION-docker.pkg.dev/$PROJECT/toovix/agent:latest
   ```
   Set `agent_image` to that path.

### B. Network / firewall (handled by this Terraform)
- Each VPC gets a **Cloud Router + Cloud NAT** so private VMs can pull images and reach the
  DAM endpoints.
- Firewall: **IAP SSH** (`35.235.240.0/20`) for admin, intra-VPC MySQL (`3306`), and (for the
  Cloud SQL VPC) **Private Service Access** peering.
- No DB gets a public IP.

### C. MySQL prerequisites (per DB)
- **Network-agent capture requires observable traffic.** If the app↔MySQL connection uses
  **TLS**, a network sniffer can't decode it → use the **inline-proxy** agent or DB audit
  logs instead. For the VM DBs here we keep app↔MySQL non-TLS on the private subnet so the
  network agent can decode (fine for a private-subnet test; use proxy/audit for TLS).
- **Least-privilege DB account** (per TooVix's security rule — never root for the platform):
  the startup script creates a dedicated `dam_svc` user with only the privileges needed for
  optional enrichment / quarantine execution. The network agent itself needs **no** DB creds.
- **NTP / time sync** — GCP VMs sync automatically; Cloud SQL is managed.

### D. Cloud SQL (PaaS) prerequisites
- You **cannot install an agent on the host.** Two supported options (pick in tfvars):
  1. **Inline proxy VM** (`enable_paas_proxy = true`, default): a small VM in the Cloud SQL
     VPC runs the TooVix agent in **proxy** mode; apps connect to the proxy, which forwards to
     Cloud SQL's private IP — enables capture **and** blocking.
  2. **Audit-log Cloud Push** (agentless): enable Cloud SQL **audit logging**
     (`cloudsql_mysql_audit` flags) → Cloud Logging → Pub/Sub → a collector that pushes to
     DAM. (Passive, no blocking; not provisioned here — enable the flags and wire the sink.)
- Cloud SQL is created with **Private IP** via **Private Services Access** (VPC peering to
  the Google-managed services network), no public IP.

### E. Identity / secrets
- Enable APIs: `compute`, `sqladmin`, `servicenetworking`, `secretmanager`,
  `artifactregistry` (Terraform does not enable them — run once, see README bottom).
- DB passwords + the enroll token are stored in **Secret Manager** (created here).
- Admin access to VMs uses **IAP tunneling + OS Login** (no public SSH).

---

## Part 2 — Using the Terraform

```bash
cd dev/enterprise-test/terraform
cp terraform.tfvars.example terraform.tfvars   # then edit values
terraform init
terraform plan
terraform apply
```

Enable the required APIs once (or add to your bootstrap):
```bash
gcloud services enable compute.googleapis.com sqladmin.googleapis.com \
  servicenetworking.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com
```

SSH to a DB VM (private, via IAP):
```bash
gcloud compute ssh db-vm-a --tunnel-through-iap --zone <zone>
docker logs toovix-agent           # watch enroll + [capture] lines
```

Generate some MySQL traffic so the agent has activity to capture (from a VM in the same VPC,
or a small client), then check **Agents & Coverage** / **Databases** in TooVix — the three
instances should enroll and show monitored.

`terraform destroy` tears the whole estate down.

**If destroy hangs on the Cloud SQL PSA peering** (`Failed to delete connection; Producer
services … are still using this connection`), delete the VPC peering directly, then re-run:
```bash
gcloud compute networks peerings delete servicenetworking-googleapis-com --network=db-paas-vpc --quiet
terraform destroy -auto-approve
```

---

## Caveats / notes
- **VM service account** needs `roles/artifactregistry.reader` to pull the agent image
  (grant it on the project/repo). The startup script auto-configures Docker auth to Artifact
  Registry via the VM's SA.
- **Passwords in metadata:** for POC simplicity the startup scripts receive DB passwords via
  instance metadata (also saved to Secret Manager). For production, read them from Secret
  Manager at boot instead of templating them in.
- **Network agent + TLS:** the network agent decodes cleartext MySQL. If you enforce TLS
  app↔MySQL, switch that DB's `capture_mode` to a proxy/audit approach.
- **Cost:** 2× `e2-small` VMs (+1 proxy VM) + 1× `db-n1-standard-1` Cloud SQL + NAT gateways.
  Run `terraform destroy` when done.
- This provisions the **database side only**. Point it at your existing DAM platform via the
  `dam_*` variables; make sure its agent endpoints are reachable + secured first (Part 1.A).
