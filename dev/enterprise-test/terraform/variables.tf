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

# ── TooVix DAM platform endpoints the agents call (reachable from the DB VPCs via NAT) ──
variable "dam_control_plane_url" {
  type        = string
  description = "Base URL of the TooVix control-plane API, e.g. https://dam.example.com or http://<ip>:3000"
}

variable "dam_clickhouse_url" {
  type        = string
  description = "ClickHouse HTTP endpoint the agent writes events to, e.g. https://ch.example.com:8123"
}

variable "dam_clickhouse_user" {
  type        = string
  description = "Write-only ClickHouse user for agents (NOT default/admin)."
  default     = "dam_writer"
}

variable "dam_clickhouse_password" {
  type      = string
  sensitive = true
}

variable "agent_enroll_token" {
  type        = string
  sensitive   = true
  description = "Must match AGENT_ENROLL_TOKEN on the DAM platform."
}

variable "agent_image" {
  type        = string
  description = "TooVix agent image in Artifact Registry, e.g. us-central1-docker.pkg.dev/PROJECT/toovix/agent:latest"
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

# ── The Cloud SQL (PaaS) MySQL database, in its own VPC ──
variable "cloudsql" {
  type = object({
    name         = optional(string, "db-paas")
    tier         = optional(string, "db-n1-standard-1")
    db_version   = optional(string, "MYSQL_8_0")
    db_name      = optional(string, "billing")
    subnet_cidr  = optional(string, "10.30.0.0/24")
    psa_cidr     = optional(string, "10.30.240.0/24") # /24 reserved for Private Service Access
  })
  default = {}
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
