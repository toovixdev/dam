# Azure Database for MySQL — Flexible Server (PaaS), PRIVATE via VNet injection.
# The server FQDN is global, so the name needs a unique suffix.
resource "random_string" "paas_suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_mysql_flexible_server" "paas" {
  name                   = "${var.mysql_flexible.name}-${random_string.paas_suffix.result}"
  resource_group_name    = azurerm_resource_group.rg.name
  location               = azurerm_resource_group.rg.location
  administrator_login    = "dbadmin"
  administrator_password = random_password.paas_admin.result
  sku_name               = var.mysql_flexible.sku_name
  version                = var.mysql_flexible.version
  zone                   = "1"

  # Private access: injected into the delegated subnet; resolvable via the private DNS zone.
  delegated_subnet_id = azurerm_subnet.paas.id
  private_dns_zone_id = azurerm_private_dns_zone.mysql.id

  storage {
    size_gb = 20
  }

  depends_on = [azurerm_private_dns_zone_virtual_network_link.paas]
}

resource "azurerm_mysql_flexible_database" "paas" {
  name                = var.mysql_flexible.db_name
  resource_group_name = azurerm_resource_group.rg.name
  server_name         = azurerm_mysql_flexible_server.paas.name
  charset             = "utf8mb4"
  collation           = "utf8mb4_general_ci"
}
