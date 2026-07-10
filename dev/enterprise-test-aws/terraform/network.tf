# ===================== EC2 DATABASE VPCs (one per DB) =====================
resource "aws_vpc" "vm" {
  for_each             = var.vm_databases
  cidr_block           = each.value.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-${each.key}" }
}

resource "aws_internet_gateway" "vm" {
  for_each = var.vm_databases
  vpc_id   = aws_vpc.vm[each.key].id
  tags     = { Name = "igw-${each.key}" }
}

# Small public subnet — only hosts the NAT gateway.
resource "aws_subnet" "vm_public" {
  for_each          = var.vm_databases
  vpc_id            = aws_vpc.vm[each.key].id
  cidr_block        = each.value.public_subnet
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "snet-${each.key}-public" }
}

# Private subnet — the EC2 database (no public IP).
resource "aws_subnet" "vm_private" {
  for_each          = var.vm_databases
  vpc_id            = aws_vpc.vm[each.key].id
  cidr_block        = each.value.private_subnet
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "snet-${each.key}-private" }
}

resource "aws_eip" "vm_nat" {
  for_each = var.vm_databases
  domain   = "vpc"
  tags     = { Name = "eip-nat-${each.key}" }
}

resource "aws_nat_gateway" "vm" {
  for_each      = var.vm_databases
  allocation_id = aws_eip.vm_nat[each.key].id
  subnet_id     = aws_subnet.vm_public[each.key].id
  tags          = { Name = "nat-${each.key}" }
  depends_on    = [aws_internet_gateway.vm]
}

resource "aws_route_table" "vm_public" {
  for_each = var.vm_databases
  vpc_id   = aws_vpc.vm[each.key].id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.vm[each.key].id
  }
  tags = { Name = "rt-${each.key}-public" }
}

resource "aws_route_table" "vm_private" {
  for_each = var.vm_databases
  vpc_id   = aws_vpc.vm[each.key].id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.vm[each.key].id
  }
  tags = { Name = "rt-${each.key}-private" }
}

resource "aws_route_table_association" "vm_public" {
  for_each       = var.vm_databases
  subnet_id      = aws_subnet.vm_public[each.key].id
  route_table_id = aws_route_table.vm_public[each.key].id
}

resource "aws_route_table_association" "vm_private" {
  for_each       = var.vm_databases
  subnet_id      = aws_subnet.vm_private[each.key].id
  route_table_id = aws_route_table.vm_private[each.key].id
}

# SG: no inbound SSH (SSM handles admin). 3306 only from within this VPC (future app).
resource "aws_security_group" "vm" {
  for_each    = var.vm_databases
  name        = "sg-${each.key}"
  description = "MySQL EC2 - intra-VPC 3306 only"
  vpc_id      = aws_vpc.vm[each.key].id

  ingress {
    description = "MySQL from within this VPC only"
    from_port   = 3306
    to_port     = 3306
    protocol    = "tcp"
    cidr_blocks = [each.value.vpc_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "sg-${each.key}" }
}

# ===================== RDS VPC =====================
resource "aws_vpc" "rds" {
  cidr_block           = var.rds.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-${var.rds.name}" }
}

resource "aws_internet_gateway" "rds" {
  vpc_id = aws_vpc.rds.id
  tags   = { Name = "igw-${var.rds.name}" }
}

resource "aws_subnet" "rds_public" {
  vpc_id            = aws_vpc.rds.id
  cidr_block        = var.rds.public_subnet
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "snet-${var.rds.name}-public" }
}

resource "aws_subnet" "rds_private_a" {
  vpc_id            = aws_vpc.rds.id
  cidr_block        = var.rds.private_subnet_a
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "snet-${var.rds.name}-private-a" }
}

resource "aws_subnet" "rds_private_b" {
  vpc_id            = aws_vpc.rds.id
  cidr_block        = var.rds.private_subnet_b
  availability_zone = data.aws_availability_zones.available.names[1]
  tags              = { Name = "snet-${var.rds.name}-private-b" }
}

resource "aws_eip" "rds_nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat-${var.rds.name}" }
}

resource "aws_nat_gateway" "rds" {
  allocation_id = aws_eip.rds_nat.id
  subnet_id     = aws_subnet.rds_public.id
  tags          = { Name = "nat-${var.rds.name}" }
  depends_on    = [aws_internet_gateway.rds]
}

resource "aws_route_table" "rds_public" {
  vpc_id = aws_vpc.rds.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.rds.id
  }
  tags = { Name = "rt-${var.rds.name}-public" }
}

resource "aws_route_table" "rds_private" {
  vpc_id = aws_vpc.rds.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.rds.id
  }
  tags = { Name = "rt-${var.rds.name}-private" }
}

resource "aws_route_table_association" "rds_public" {
  subnet_id      = aws_subnet.rds_public.id
  route_table_id = aws_route_table.rds_public.id
}

resource "aws_route_table_association" "rds_private_a" {
  subnet_id      = aws_subnet.rds_private_a.id
  route_table_id = aws_route_table.rds_private.id
}

resource "aws_route_table_association" "rds_private_b" {
  subnet_id      = aws_subnet.rds_private_b.id
  route_table_id = aws_route_table.rds_private.id
}

resource "aws_db_subnet_group" "rds" {
  name       = "${var.rds.name}-subnets"
  subnet_ids = [aws_subnet.rds_private_a.id, aws_subnet.rds_private_b.id]
  tags       = { Name = "${var.rds.name}-subnets" }
}

# Seeder EC2 (SSM) reaches RDS; RDS only accepts 3306 from the seeder's SG.
resource "aws_security_group" "seeder" {
  name        = "sg-${var.rds.name}-seeder"
  description = "Seeder/jump for RDS"
  vpc_id      = aws_vpc.rds.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "sg-${var.rds.name}-seeder" }
}

resource "aws_security_group" "rds" {
  name        = "sg-${var.rds.name}-rds"
  description = "RDS MySQL - 3306 from seeder only"
  vpc_id      = aws_vpc.rds.id
  ingress {
    description     = "MySQL from the seeder/app SG only"
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.seeder.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "sg-${var.rds.name}-rds" }
}
