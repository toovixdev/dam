resource "azurerm_resource_group" "rg" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

# Generated DB credentials (never a shared admin for the platform later).
resource "random_password" "vm_root" {
  for_each = var.vm_databases
  length   = 20
  special  = false
}

resource "random_password" "paas_admin" {
  length  = 20
  special = false
}

# Private DNS zone so the jump-box can resolve the Flexible Server's private FQDN.
resource "azurerm_private_dns_zone" "mysql" {
  name                = "toovixmysql.private.mysql.database.azure.com"
  resource_group_name = azurerm_resource_group.rg.name
  tags                = var.tags
}
