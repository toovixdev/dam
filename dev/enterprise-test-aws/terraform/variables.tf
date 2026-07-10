variable "region" {
  type    = string
  default = "ap-south-1" # Mumbai
}

variable "instance_type" {
  type    = string
  default = "t3.small"
}

# MySQL-on-EC2 databases — each in its OWN VPC. Connect via SSM (no public IP, no SSH key).
variable "vm_databases" {
  description = "MySQL-on-EC2 databases. Key = name; CIDRs must not overlap."
  type = map(object({
    vpc_cidr       = string
    public_subnet  = string # tiny public subnet just for the NAT gateway
    private_subnet = string # the EC2 lives here (no public IP)
    db_name        = string
  }))
  default = {
    "db-vm-a" = { vpc_cidr = "10.10.0.0/16", public_subnet = "10.10.0.0/24", private_subnet = "10.10.1.0/24", db_name = "orders" }
    "db-vm-b" = { vpc_cidr = "10.20.0.0/16", public_subnet = "10.20.0.0/24", private_subnet = "10.20.1.0/24", db_name = "customers" }
  }
}

# The RDS (PaaS) MySQL database, in its own VPC (private, multi-AZ subnet group).
variable "rds" {
  type = object({
    name             = optional(string, "db-paas")
    engine_version   = optional(string, "8.0")
    instance_class   = optional(string, "db.t3.micro")
    db_name          = optional(string, "billing")
    vpc_cidr         = optional(string, "10.30.0.0/16")
    public_subnet    = optional(string, "10.30.0.0/24") # NAT gateway
    private_subnet_a = optional(string, "10.30.1.0/24") # DB subnet group + seeder (AZ a)
    private_subnet_b = optional(string, "10.30.2.0/24") # DB subnet group (AZ b)
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
