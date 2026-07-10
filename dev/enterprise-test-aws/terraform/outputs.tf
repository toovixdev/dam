output "vm_databases" {
  value = {
    for k, v in aws_instance.vm : k => {
      instance_id = v.id
      private_ip  = v.private_ip
      vpc         = aws_vpc.vm[k].id
      db_name     = var.vm_databases[k].db_name
    }
  }
}

output "rds" {
  value = {
    identifier = aws_db_instance.paas.identifier
    endpoint   = aws_db_instance.paas.address
    db_name    = var.rds.db_name
    admin      = "dbadmin"
    seeder_id  = aws_instance.seeder.id
  }
}

output "how_to_connect" {
  value = <<-EOT
    # No SSH keys / no public IPs — connect via SSM Session Manager.
    # (One-time: brew install --cask session-manager-plugin)

    # --- A MySQL EC2 (e.g. db-vm-a / orders) ---
    aws ssm start-session --target ${aws_instance.vm["db-vm-a"].id}
    #   then on the box:  mysql -u root -p    (password below)

    # --- RDS 'billing' (via the seeder EC2) ---
    aws ssm start-session --target ${aws_instance.seeder.id}
    #   then:  mysql -h ${aws_db_instance.paas.address} -u dbadmin -p ${var.rds.db_name}

    # Passwords:
    aws secretsmanager get-secret-value --secret-id toovix-db-vm-a-root  --query SecretString --output text
    aws secretsmanager get-secret-value --secret-id toovix-${var.rds.name}-admin --query SecretString --output text
  EOT
}
