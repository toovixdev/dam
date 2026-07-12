variable "region" {
  type    = string
  default = "ap-south-1" # Mumbai
}

variable "instance_type" {
  type    = string
  default = "t3.small"
}

# Single shared VPC — ONE NAT gateway for all DBs (cost-optimized vs one-VPC-per-DB).
variable "network" {
  type = object({
    vpc_cidr      = optional(string, "10.0.0.0/16")
    public_subnet = optional(string, "10.0.0.0/24") # hosts the single NAT gateway
  })
  default = {}
}

# MySQL-on-EC2 databases — each in its OWN private subnet of the shared VPC. SSM admin.
variable "vm_databases" {
  description = "MySQL-on-EC2 databases. Key = name; private_subnet CIDRs must be unique within the VPC."
  type = map(object({
    private_subnet = string
    db_name        = string
  }))
  default = {
    "db-vm-a" = { private_subnet = "10.0.1.0/24", db_name = "orders" }
    "db-vm-b" = { private_subnet = "10.0.2.0/24", db_name = "customers" }
  }
}

# The RDS (PaaS) MySQL database — private, multi-AZ subnet group in the shared VPC.
variable "rds" {
  type = object({
    name             = optional(string, "db-paas")
    engine_version   = optional(string, "8.0")
    instance_class   = optional(string, "db.t3.micro")
    db_name          = optional(string, "billing")
    private_subnet_a = optional(string, "10.0.11.0/24") # DB subnet group + seeder (AZ a)
    private_subnet_b = optional(string, "10.0.12.0/24") # DB subnet group (AZ b)
  })
  default = {}
}

# Postgres-on-EC2 database — its own private subnet of the shared VPC. SSM admin.
variable "pg_vm" {
  type = object({
    name           = optional(string, "db-vm-pg")
    machine_type   = optional(string, "t3.small")
    db_name        = optional(string, "inventory")
    private_subnet = optional(string, "10.0.3.0/24")
  })
  default = {}
}

# The RDS (PaaS) Postgres database — private, reuses the shared RDS multi-AZ subnet group.
variable "rds_pg" {
  type = object({
    name           = optional(string, "db-paas-pg")
    engine_version = optional(string, "16")
    instance_class = optional(string, "db.t3.micro")
    db_name        = optional(string, "analytics")
  })
  default = {}
}

variable "deploy_agents" {
  type        = bool
  default     = false
  description = "PHASE 2 placeholder — infra applies without any DAM/agent config."
}

variable "tags" {
  type    = map(string)
  default = { env = "toovix-enterprise-test", managed_by = "terraform" }
}
