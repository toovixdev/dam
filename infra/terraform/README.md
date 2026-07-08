# DAM — Database VMs on GCP (Terraform)

Provisions two Linux database VMs inside a **custom VPC** on a **private subnet**
(no public IPs). Outbound internet (for package installs) goes through **Cloud NAT**;
inbound SSH is via **Identity-Aware Proxy (IAP)**.

| VM | OS | Database | Default machine |
|----|----|----------|-----------------|
| `dam-db-mysql`  | Ubuntu 22.04     | MySQL 8              | `e2-medium`     |
| `dam-db-oracle` | Oracle Linux 8   | Oracle DB 21c XE     | `e2-standard-2` |

## Layout

```
versions.tf     provider + version pins
variables.tf    all inputs
network.tf      VPC, private subnet, Cloud Router + NAT
firewall.tf     SSH (IAP), internal, MySQL 3306, Oracle 1521
compute.tf      the two VMs + a least-privilege service account
outputs.tf      IPs and ready-to-use SSH commands
scripts/        first-boot install scripts for each DB
```

## Prerequisites

- A GCP project and `gcloud auth application-default login` (or a service-account key).
- These APIs enabled: `compute.googleapis.com`, `iap.googleapis.com`.
- To SSH via IAP, your user needs the `roles/iap.tunnelResourceAccessor` role.

## Usage

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # set project_id, region, zone
terraform init
terraform plan
terraform apply
```

Then connect (commands are also printed as outputs):

```bash
gcloud compute ssh dam-db-mysql  --zone us-central1-a --tunnel-through-iap
gcloud compute ssh dam-db-oracle --zone us-central1-a --tunnel-through-iap
```

## Network isolation

- **Custom-mode VPC** — no default/auto subnets.
- **Private subnet** `10.10.0.0/24` with Private Google Access.
- VMs have **no external IP**. Egress only via Cloud NAT; no unsolicited inbound.
- DB ports (3306 / 1521) are open only to `db_client_source_ranges`
  (subnet-internal by default) — tighten this to your app tier.

## Notes / next steps

- **Secrets:** the startup scripts generate/placeholder DB passwords. For
  production, store them in **Secret Manager** and have the scripts fetch them
  (scaffolding is commented in each script). The Oracle initial password is
  written to `/root/oracle-initial-pw.txt` on the VM — rotate it.
- **Oracle XE** is the free edition (limits: 2 CPUs, 2 GB RAM used by the DB,
  12 GB user data). Swap the RPM/steps if you have a licensed edition.
- **State:** this uses local state. For team use, add a `backend "gcs"` block.
- **Managed alternative:** if you don't need full VM control, Cloud SQL (MySQL)
  removes the ops burden — Oracle has no native GCP PaaS, so it stays on a VM.
```
