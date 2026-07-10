data "aws_availability_zones" "available" {
  state = "available"
}

# Latest Ubuntu 22.04 AMI (Canonical) — ships with the SSM agent preinstalled.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "random_password" "vm_root" {
  for_each = var.vm_databases
  length   = 20
  special  = false
}

resource "random_password" "rds_admin" {
  length  = 20
  special = false
}
