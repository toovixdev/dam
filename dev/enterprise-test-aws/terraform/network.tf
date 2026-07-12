# ===================== Single shared VPC (one NAT gateway for ALL DBs) =====================
# Cost-optimized vs one-VPC-per-DB: every DB lives in its own PRIVATE SUBNET of this VPC
# and egresses through a single NAT gateway. Isolation is enforced by subnet + security group.
resource "aws_vpc" "main" {
  cidr_block           = var.network.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-toovix-test" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "igw-toovix-test" }
}

# Public subnet — hosts the single NAT gateway only.
resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.network.public_subnet
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "snet-public" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat-toovix-test" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public.id
  tags          = { Name = "nat-toovix-test" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "rt-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ONE private route table shared by every private subnet — all egress via the single NAT.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
  tags = { Name = "rt-private" }
}

# ---------- MySQL-on-EC2 private subnets (one per DB) ----------
resource "aws_subnet" "vm_private" {
  for_each          = var.vm_databases
  vpc_id            = aws_vpc.main.id
  cidr_block        = each.value.private_subnet
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "snet-${each.key}-private" }
}

resource "aws_route_table_association" "vm_private" {
  for_each       = var.vm_databases
  subnet_id      = aws_subnet.vm_private[each.key].id
  route_table_id = aws_route_table.private.id
}

# ---------- RDS private subnets (multi-AZ subnet group) ----------
resource "aws_subnet" "rds_private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.rds.private_subnet_a
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "snet-${var.rds.name}-private-a" }
}

resource "aws_subnet" "rds_private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.rds.private_subnet_b
  availability_zone = data.aws_availability_zones.available.names[1]
  tags              = { Name = "snet-${var.rds.name}-private-b" }
}

resource "aws_route_table_association" "rds_private_a" {
  subnet_id      = aws_subnet.rds_private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "rds_private_b" {
  subnet_id      = aws_subnet.rds_private_b.id
  route_table_id = aws_route_table.private.id
}

resource "aws_db_subnet_group" "rds" {
  name       = "${var.rds.name}-subnets"
  subnet_ids = [aws_subnet.rds_private_a.id, aws_subnet.rds_private_b.id]
  tags       = { Name = "${var.rds.name}-subnets" }
}

# ---------- SQL-Server-on-Windows private subnet ----------
resource "aws_subnet" "mssql_private" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.mssql.private_subnet
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "snet-${var.mssql.name}-private" }
}

resource "aws_route_table_association" "mssql_private" {
  subnet_id      = aws_subnet.mssql_private.id
  route_table_id = aws_route_table.private.id
}

# ===================== Security groups (per-DB isolation within the shared VPC) =====================
# Each DB only accepts its port from its OWN subnet, so sharing a VPC doesn't let the DBs reach each other.
resource "aws_security_group" "vm" {
  for_each    = var.vm_databases
  name        = "${each.key}-mysql-sg"
  description = "MySQL EC2 - 3306 from its own subnet only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "MySQL from own subnet only"
    from_port   = 3306
    to_port     = 3306
    protocol    = "tcp"
    cidr_blocks = [each.value.private_subnet]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "sg-${each.key}" }
}

# Seeder EC2 reaches RDS; RDS only accepts 3306 from the seeder's SG.
resource "aws_security_group" "seeder" {
  name        = "${var.rds.name}-seeder-sg"
  description = "Seeder/jump for RDS"
  vpc_id      = aws_vpc.main.id
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "sg-${var.rds.name}-seeder" }
}

resource "aws_security_group" "rds" {
  name        = "${var.rds.name}-rds-sg"
  description = "RDS MySQL - 3306 from seeder only"
  vpc_id      = aws_vpc.main.id
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

resource "aws_security_group" "mssql" {
  name        = "${var.mssql.name}-mssql-sg"
  description = "SQL Server EC2 - 1433 from its own subnet only"
  vpc_id      = aws_vpc.main.id
  ingress {
    description = "SQL Server from own subnet only"
    from_port   = 1433
    to_port     = 1433
    protocol    = "tcp"
    cidr_blocks = [var.mssql.private_subnet]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "sg-${var.mssql.name}" }
}
