output "jumpbox_public_ip" {
  description = "Public IP of the Linux jump-box."
  value       = azurerm_public_ip.jumpbox.ip_address
}

output "ssh_jumpbox" {
  description = "SSH into the jump-box."
  value       = "ssh ${var.admin_username}@${azurerm_public_ip.jumpbox.ip_address}"
}

output "sqlvm_private_ip" {
  description = "Private IP of the SQL Server VM (reach it from the jump-box)."
  value       = azurerm_network_interface.sqlvm.private_ip_address
}

output "nat_egress_ip" {
  description = "Dedicated outbound IP the SQL VM egresses through (for far-end allow-listing)."
  value       = azurerm_public_ip.nat.ip_address
}

output "azuresql_fqdn" {
  description = "Azure SQL logical server FQDN (resolves to a private IP inside the VNet)."
  value       = azurerm_mssql_server.paas.fully_qualified_domain_name
}

output "azuresql_database" {
  description = "Azure SQL database name."
  value       = azurerm_mssql_database.paas.name
}

output "key_vault_name" {
  description = "Key Vault holding all generated passwords."
  value       = azurerm_key_vault.kv.name
}

output "how_to_connect" {
  description = "Copy-paste connection steps."
  value       = <<-EOT

    Passwords (from Key Vault):
      az keyvault secret show --vault-name ${azurerm_key_vault.kv.name} --name sqlvm-sql-login  --query value -o tsv   # SQL Server VM login (${var.sql_vm_sql_login})
      az keyvault secret show --vault-name ${azurerm_key_vault.kv.name} --name azuresql-admin   --query value -o tsv   # Azure SQL admin (${var.azuresql_admin_login})
      az keyvault secret show --vault-name ${azurerm_key_vault.kv.name} --name sqlvm-windows-admin --query value -o tsv # Windows RDP admin (${var.admin_username})

    1) SSH to the jump-box:   ssh ${var.admin_username}@${azurerm_public_ip.jumpbox.ip_address}
    2) SQL Server VM (from the jump-box):
         sqlcmd -S ${azurerm_network_interface.sqlvm.private_ip_address},1433 -U ${var.sql_vm_sql_login} -P '<sqlvm-sql-login>' -C
    3) Azure SQL Database (from the jump-box — FQDN resolves privately):
         sqlcmd -S ${azurerm_mssql_server.paas.fully_qualified_domain_name} -d ${azurerm_mssql_database.paas.name} -U ${var.azuresql_admin_login} -P '<azuresql-admin>' -C
  EOT
}
