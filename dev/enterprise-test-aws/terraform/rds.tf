# Amazon RDS for MySQL (PaaS), PRIVATE (no public access), multi-AZ subnet group.
resource "aws_db_instance" "paas" {
  identifier             = var.rds.name
  engine                 = "mysql"
  engine_version         = var.rds.engine_version
  instance_class         = var.rds.instance_class
  allocated_storage      = 20
  storage_encrypted      = true
  db_name                = var.rds.db_name
  username               = "dbadmin"
  password               = random_password.rds_admin.result
  db_subnet_group_name   = aws_db_subnet_group.rds.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  skip_final_snapshot    = true
  deletion_protection    = false
  apply_immediately      = true
}

# Seeder / jump EC2 in the RDS VPC — reaches RDS over 3306, loads the billing seed.
# Reachable via SSM Session Manager (no public IP / SSH key).
resource "aws_instance" "seeder" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.rds_private_a.id
  vpc_security_group_ids      = [aws_security_group.seeder.id]
  iam_instance_profile        = aws_iam_instance_profile.ssm.name
  associate_public_ip_address = false

  user_data = templatefile("${path.module}/templates/seeder-init.sh.tftpl", {
    rds_endpoint   = aws_db_instance.paas.address
    admin_user     = "dbadmin"
    admin_password = random_password.rds_admin.result
    db_name        = var.rds.db_name
    seed_b64       = fileexists("${path.module}/seed/${var.rds.db_name}.sql") ? base64encode(file("${path.module}/seed/${var.rds.db_name}.sql")) : ""
  })

  root_block_device {
    volume_size = 15
    encrypted   = true
  }

  # Pin to the deployed AMI; don't replace on a newer Ubuntu release.
  lifecycle {
    ignore_changes = [ami]
  }

  tags = { Name = "${var.rds.name}-seeder" }
}
