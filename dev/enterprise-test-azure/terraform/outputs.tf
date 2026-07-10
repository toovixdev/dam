output "jumpbox_public_ip" {
  description = "SSH here first (locked to your admin_source_ip)."
  value       = azurerm_public_ip.jumpbox.ip_address
}

output "vm_databases" {
  value = {
    for k, v in azurerm_linux_virtual_machine.vm : k => {
      private_ip = azurerm_network_interface.vm[k].private_ip_address
      vnet       = azurerm_virtual_network.vm[k].name
      subnet     = var.vm_databases[k].subnet_cidr
      db_name    = var.vm_databases[k].db_name
    }
  }
}

output "mysql_flexible" {
  value = {
    name    = azurerm_mysql_flexible_server.paas.name
    fqdn    = azurerm_mysql_flexible_server.paas.fqdn
    db_name = var.mysql_flexible.db_name
    admin   = "dbadmin"
  }
}

output "key_vault" {
  description = "Passwords live here."
  value       = azurerm_key_vault.kv.name
}

output "how_to_connect" {
  value = <<-EOT
    # SSH to the jump-box (from your Mac):
    ssh -i ~/.ssh/azure_mysql ${var.admin_username}@${azurerm_public_ip.jumpbox.ip_address}

    # From the jump-box, reach a VM DB (over peering) or the Flexible Server (by FQDN):
    #   VM:   ssh ${var.admin_username}@<vm-private-ip>   then: mysql -u root -p
    #   PaaS: mysql -h ${azurerm_mysql_flexible_server.paas.fqdn} -u dbadmin -p ${var.mysql_flexible.db_name}
    # Passwords:  az keyvault secret show --vault-name ${azurerm_key_vault.kv.name} --name toovix-db-vm-a-root --query value -o tsv
  EOT
}
