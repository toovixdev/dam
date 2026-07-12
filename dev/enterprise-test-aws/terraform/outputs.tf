output "vm_databases" {
  value = {
    for k, v in aws_instance.vm : k => {
      instance_id = v.id
      private_ip  = v.private_ip
      vpc         = aws_vpc.main.id
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

output "pg_vm" {
  value = {
    instance_id = aws_instance.pg_vm.id
    private_ip  = aws_instance.pg_vm.private_ip
    db_name     = var.pg_vm.db_name
    engine      = "PostgreSQL on EC2"
  }
}

output "rds_pg" {
  value = {
    identifier = aws_db_instance.pg.identifier
    endpoint   = aws_db_instance.pg.address
    db_name    = var.rds_pg.db_name
    admin      = "dbadmin"
    engine     = "PostgreSQL on RDS"
  }
}

output "how_to_connect" {
  value = <<-EOT
    # No SSH keys / no public IPs — connect via SSM Session Manager.
    # (One-time: brew install --cask session-manager-plugin)

    # --- A MySQL EC2 (e.g. db-vm-a / orders) ---
    aws ssm start-session --target ${aws_instance.vm["db-vm-a"].id}
    #   then on the box:  mysql -u root -p    (password below)

    # --- Postgres EC2 (db-vm-pg / inventory) — also fronts the Postgres RDS ---
    aws ssm start-session --target ${aws_instance.pg_vm.id}
    #   local:            sudo -u postgres psql -d ${var.pg_vm.db_name}
    #   RDS 'analytics':  psql -h ${aws_db_instance.pg.address} -U dbadmin -d ${var.rds_pg.db_name}

    # --- RDS MySQL 'billing' (via the seeder EC2) ---
    aws ssm start-session --target ${aws_instance.seeder.id}
    #   MySQL:  mysql -h ${aws_db_instance.paas.address} -u dbadmin -p ${var.rds.db_name}

    # Passwords:
    aws secretsmanager get-secret-value --secret-id toovix-db-vm-a-root  --query SecretString --output text
    aws secretsmanager get-secret-value --secret-id toovix-${var.pg_vm.name}-root --query SecretString --output text
    aws secretsmanager get-secret-value --secret-id toovix-${var.rds.name}-admin --query SecretString --output text
    aws secretsmanager get-secret-value --secret-id toovix-${var.rds_pg.name}-admin --query SecretString --output text
  EOT
}
