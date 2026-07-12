# ===================== SQL-Server-on-Windows EC2 =====================
# Lives in a private subnet of the shared VPC (network.tf), egresses via the single NAT.
# Admin via SSM (no public IP / key). SQL Server 2022 Standard is preinstalled on the
# License-Included AMI; userdata configures + seeds it and installs Docker (Windows containers).
resource "aws_instance" "mssql" {
  ami                         = data.aws_ami.windows_sql.id
  instance_type               = var.mssql.instance_type
  subnet_id                   = aws_subnet.mssql_private.id
  vpc_security_group_ids      = [aws_security_group.mssql.id]
  iam_instance_profile        = aws_iam_instance_profile.ssm.name
  associate_public_ip_address = false
  get_password_data           = false # no key pair — admin via SSM, SQL creds in Secrets Manager

  user_data = templatefile("${path.module}/templates/mssql-win-init.ps1.tftpl", {
    db_name        = var.mssql.db_name
    admin_password = random_password.mssql_admin.result
    seed_b64       = fileexists("${path.module}/seed/${var.mssql.db_name}.sql") ? base64encode(file("${path.module}/seed/${var.mssql.db_name}.sql")) : ""
  })

  root_block_device {
    volume_size = var.mssql.volume_size
    encrypted   = true
  }

  tags = { Name = var.mssql.name }
}
