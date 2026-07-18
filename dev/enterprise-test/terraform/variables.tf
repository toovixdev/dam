variable "project_id" {
  type        = string
  description = "GCP project ID to deploy the test estate into."
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

# ── Agents / DAM (PHASE 2) — leave off for now; infra applies without any of these. ──
variable "deploy_agents" {
  type        = bool
  default     = false
  description = "PHASE 2: when true, VMs install the TooVix agent + a proxy VM fronts Cloud SQL. Leave false to build just the databases."
}

variable "vm_image" {
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2204-lts" # MySQL 8 available natively
  description = "Boot image for the MySQL VMs."
}

variable "dam_control_plane_url" {
  type    = string
  default = ""
}

variable "dam_clickhouse_url" {
  type    = string
  default = ""
}

variable "dam_clickhouse_user" {
  type    = string
  default = "dam_writer"
}

variable "dam_clickhouse_password" {
  type      = string
  sensitive = true
  default   = ""
}

variable "agent_enroll_token" {
  type      = string
  sensitive = true
  default   = ""
}

variable "agent_image" {
  type    = string
  default = ""
}

# ── The two MySQL-on-VM databases (each gets its own VPC + private subnet) ──
variable "vm_databases" {
  description = "MySQL-on-VM databases. Key = instance name. CIDRs must not overlap."
  type = map(object({
    machine_type = optional(string, "e2-small")
    subnet_cidr  = string
    db_name      = string
    capture_mode = optional(string, "network") # network | proxy
  }))
  default = {
    "db-vm-a" = { subnet_cidr = "10.10.0.0/24", db_name = "orders" }
    "db-vm-b" = { subnet_cidr = "10.20.0.0/24", db_name = "customers" }
  }
}

# ── The PostgreSQL-on-VM database (added to the shared VPC) ──
variable "pg_vm" {
  type = object({
    name         = optional(string, "db-vm-pg")
    machine_type = optional(string, "e2-small")
    subnet_cidr  = optional(string, "10.40.0.0/24") # must not overlap the MySQL/Cloud SQL subnets
    db_name      = optional(string, "inventory")
  })
  default = {}
}

# ── The MongoDB-on-VM database (added to the shared VPC) ──
variable "mongo_vm" {
  type = object({
    name          = optional(string, "db-vm-mongo")
    machine_type  = optional(string, "e2-small")
    subnet_cidr   = optional(string, "10.50.0.0/24") # must not overlap the MySQL/PG/Cloud SQL subnets
    db_name       = optional(string, "profiles")
    mongo_version = optional(string, "7.0")
  })
  default = {}
}

# ── The Cloud SQL (PaaS) MySQL database, in its own VPC ──
variable "cloudsql" {
  type = object({
    name        = optional(string, "db-paas")
    tier        = optional(string, "db-n1-standard-1")
    db_version  = optional(string, "MYSQL_8_0")
    db_name     = optional(string, "billing")
    subnet_cidr = optional(string, "10.30.0.0/24")
    psa_cidr    = optional(string, "10.30.240.0/24") # /24 reserved for Private Service Access
  })
  default = {}
}

variable "enable_cloudsql_audit" {
  type        = bool
  default     = false
  description = "Turn on Cloud SQL's DB audit → Cloud Logging (feeds the Pub/Sub sink for the agentless path). Restarts the instance when toggled."
}

variable "enable_paas_proxy" {
  type        = bool
  default     = true
  description = "Deploy a small inline-proxy agent VM in the Cloud SQL VPC (capture + block). If false, use audit-log Cloud Push instead."
}

variable "capture_iface" {
  type        = string
  default     = "ens4" # GCP Debian/Ubuntu primary NIC
  description = "NIC the network agent sniffs on the VM."
}

variable "labels" {
  type    = map(string)
  default = { env = "toovix-enterprise-test", managed_by = "terraform" }
}
