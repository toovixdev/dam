# MySQL-on-EC2 databases. Private subnet, no public IP. Admin access via SSM Session Manager.
resource "aws_instance" "vm" {
  for_each                    = var.vm_databases
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.vm_private[each.key].id
  vpc_security_group_ids      = [aws_security_group.vm[each.key].id]
  iam_instance_profile        = aws_iam_instance_profile.ssm.name
  associate_public_ip_address = false

  user_data = templatefile("${path.module}/templates/mysql-ec2-init.sh.tftpl", {
    db_name       = each.value.db_name
    root_password = random_password.vm_root[each.key].result
    seed_b64      = fileexists("${path.module}/seed/${each.value.db_name}.sql") ? base64encode(file("${path.module}/seed/${each.value.db_name}.sql")) : ""
  })

  root_block_device {
    volume_size = 20
    encrypted   = true
  }

  tags = { Name = each.key }
}
