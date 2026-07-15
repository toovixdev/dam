# ── Azure SQL Database (PaaS) — private access only ───────────────────────────
# Logical server name must be globally unique → suffix with a random string.
resource "random_string" "sqlserver_suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_mssql_server" "paas" {
  name                         = "${var.name_prefix}-sql-${random_string.sqlserver_suffix.result}"
  resource_group_name          = azurerm_resource_group.rg.name
  location                     = azurerm_resource_group.rg.location
  version                      = "12.0"
  administrator_login          = var.azuresql_admin_login
  administrator_login_password = random_password.azuresql_admin.result
  minimum_tls_version          = "1.2"

  # No public endpoint — reachable only through the Private Endpoint below.
  public_network_access_enabled = false
}

resource "azurerm_mssql_database" "paas" {
  name      = "appdb"
  server_id = azurerm_mssql_server.paas.id
  sku_name  = var.azuresql_db_sku
  collation = "SQL_Latin1_General_CP1_CI_AS"
}

# ── Private Endpoint + Private DNS so the FQDN resolves to a private IP ────────
resource "azurerm_private_dns_zone" "sql" {
  name                = "privatelink.database.windows.net"
  resource_group_name = azurerm_resource_group.rg.name
}

resource "azurerm_private_dns_zone_virtual_network_link" "sql" {
  name                  = "${var.name_prefix}-sql-dnslink"
  resource_group_name   = azurerm_resource_group.rg.name
  private_dns_zone_name = azurerm_private_dns_zone.sql.name
  virtual_network_id    = azurerm_virtual_network.vnet.id
}

resource "azurerm_private_endpoint" "sql" {
  name                = "${var.name_prefix}-sql-pe"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  subnet_id           = azurerm_subnet.pe.id

  private_service_connection {
    name                           = "${var.name_prefix}-sql-psc"
    private_connection_resource_id = azurerm_mssql_server.paas.id
    subresource_names              = ["sqlServer"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "sql-dns"
    private_dns_zone_ids = [azurerm_private_dns_zone.sql.id]
  }
}
