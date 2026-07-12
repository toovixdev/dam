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

# Latest Windows Server 2022 + SQL Server 2022 Standard (License-Included AMI, SSM agent preinstalled).
data "aws_ami" "windows_sql" {
  most_recent = true
  owners      = ["amazon"]
  filter {
    name   = "name"
    values = ["Windows_Server-2022-English-Full-SQL_2022_Standard-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# SQL Server 'sa' / dam_svc password — meets SQL complexity (upper/lower/digit/special).
resource "random_password" "mssql_admin" {
  length           = 24
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
  min_special      = 2
  override_special = "!#$%*-_=+"
}
