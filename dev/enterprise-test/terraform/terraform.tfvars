# ─── PHASE 1: build just the 3 databases (no DAM/agent needed) ───
project_id = "project-6bd9f529-96ec-4f5f-8b6"
region     = "us-central1"
zone       = "us-central1-a"

# 2 MySQL-on-VM databases (each in its own VPC + private subnet). CIDRs must not overlap.
vm_databases = {
  "db-vm-a" = { subnet_cidr = "10.10.0.0/24", db_name = "orders", machine_type = "e2-small" }
  "db-vm-b" = { subnet_cidr = "10.20.0.0/24", db_name = "customers", machine_type = "e2-small" }
}

# 1 Cloud SQL for MySQL (PaaS), private IP, in its own VPC.
cloudsql = {
  name        = "db-paas"
  tier        = "db-n1-standard-1"
  db_name     = "billing"
  subnet_cidr = "10.30.0.0/24"
  psa_cidr    = "10.30.240.0/24"
}

# Agents stay OFF for now — infra applies without any DAM config.
deploy_agents = false

# ─── PHASE 2 (later): flip deploy_agents = true and fill these in ───
# agent_image             = "docker.io/<user>/toovix-agent:latest"   # or Artifact Registry path
# dam_control_plane_url   = "https://dam.suchirasoistories.in"
# dam_clickhouse_url      = "https://ch.suchirasoistories.in:8123"
# dam_clickhouse_password = "CHANGE_ME"
# agent_enroll_token      = "CHANGE_ME"
