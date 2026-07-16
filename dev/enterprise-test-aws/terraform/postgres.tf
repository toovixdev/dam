# ===================== Postgres on EC2 =====================
# Private subnet of the shared VPC, SSM admin, self-seeds + installs Docker via userdata.
resource "aws_subnet" "pg_vm_private" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.pg_vm.private_subnet
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "snet-${var.pg_vm.name}-private" }
}

resource "aws_route_table_association" "pg_vm_private" {
  subnet_id      = aws_subnet.pg_vm_private.id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "pg_vm" {
  name        = "${var.pg_vm.name}-pg-sg"
  description = "Postgres EC2 - 5432 from own subnet only"
  vpc_id      = aws_vpc.main.id
  ingress {
    description = "Postgres from own subnet only"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.pg_vm.private_subnet]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "sg-${var.pg_vm.name}" }
}

resource "random_password" "pg_vm_root" {
  length  = 20
  special = false
}

resource "aws_secretsmanager_secret" "pg_vm_root" {
  name                    = "toovix-${var.pg_vm.name}-root"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "pg_vm_root" {
  secret_id     = aws_secretsmanager_secret.pg_vm_root.id
  secret_string = random_password.pg_vm_root.result
}

resource "aws_instance" "pg_vm" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.pg_vm.machine_type
  subnet_id                   = aws_subnet.pg_vm_private.id
  vpc_security_group_ids      = [aws_security_group.pg_vm.id]
  iam_instance_profile        = aws_iam_instance_profile.ssm.name
  associate_public_ip_address = false

  user_data = templatefile("${path.module}/templates/postgres-vm-init.sh.tftpl", {
    db_name       = var.pg_vm.db_name
    root_password = random_password.pg_vm_root.result
    seed_b64      = fileexists("${path.module}/seed/${var.pg_vm.db_name}.sql") ? base64encode(file("${path.module}/seed/${var.pg_vm.db_name}.sql")) : ""
    # This box also seeds the Postgres RDS (analytics) — same VPC, has psql.
    pg_rds_endpoint = aws_db_instance.pg.address
    pg_rds_user     = "dbadmin"
    pg_rds_password = random_password.pg_rds_admin.result
    pg_rds_db       = var.rds_pg.db_name
    pg_rds_seed_b64 = fileexists("${path.module}/seed/${var.rds_pg.db_name}.sql") ? base64encode(file("${path.module}/seed/${var.rds_pg.db_name}.sql")) : ""
  })

  root_block_device {
    volume_size = 20
    encrypted   = true
  }

  # Pin to the deployed AMI; don't replace on a newer Ubuntu release.
  lifecycle {
    ignore_changes = [ami]
  }

  tags = { Name = var.pg_vm.name }
}

# ===================== Postgres on RDS =====================
# Private, reuses the shared RDS multi-AZ subnet group; seeded by the seeder EC2.
resource "aws_security_group" "pg_rds" {
  name        = "${var.rds_pg.name}-rds-sg"
  description = "RDS Postgres - 5432 from Postgres-EC2 only"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "Postgres from the Postgres-EC2 SG only (it seeds + fronts the RDS)"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.pg_vm.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "sg-${var.rds_pg.name}-rds" }
}

resource "random_password" "pg_rds_admin" {
  length  = 20
  special = false
}

resource "aws_secretsmanager_secret" "pg_rds_admin" {
  name                    = "toovix-${var.rds_pg.name}-admin"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "pg_rds_admin" {
  secret_id     = aws_secretsmanager_secret.pg_rds_admin.id
  secret_string = random_password.pg_rds_admin.result
}

resource "aws_db_instance" "pg" {
  identifier             = var.rds_pg.name
  engine                 = "postgres"
  engine_version         = var.rds_pg.engine_version
  instance_class         = var.rds_pg.instance_class
  allocated_storage      = 20
  storage_encrypted      = true
  db_name                = var.rds_pg.db_name
  username               = "dbadmin"
  password               = random_password.pg_rds_admin.result
  db_subnet_group_name   = aws_db_subnet_group.rds.name
  vpc_security_group_ids = [aws_security_group.pg_rds.id]
  publicly_accessible    = false
  skip_final_snapshot    = true
  deletion_protection    = false
  apply_immediately      = true
}
