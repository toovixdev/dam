data "azurerm_client_config" "current" {}

# ── Generated passwords (complex enough for Windows + SQL Server) ──────────────
resource "random_password" "sqlvm_admin" {
  length           = 24
  special          = true
  override_special = "!@#%*-_"
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
  min_special      = 1
}

resource "random_password" "sqlvm_sqlauth" {
  length           = 24
  special          = true
  override_special = "!@#%*-_"
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
  min_special      = 1
}

resource "random_password" "azuresql_admin" {
  length           = 24
  special          = true
  override_special = "!@#%*-_"
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
  min_special      = 1
}

# ── Key Vault — stores every credential (access-policy model; no RBAC role
#    assignment needed, so the deployer only needs Key Vault Contributor) ───────
resource "azurerm_key_vault" "kv" {
  name                       = "${var.name_prefix}-kv-${random_string.sqlserver_suffix.result}"
  location                   = azurerm_resource_group.rg.location
  resource_group_name        = azurerm_resource_group.rg.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  soft_delete_retention_days = 7
  purge_protection_enabled   = false

  access_policy {
    tenant_id          = data.azurerm_client_config.current.tenant_id
    object_id          = data.azurerm_client_config.current.object_id
    secret_permissions = ["Get", "List", "Set", "Delete", "Purge", "Recover"]
  }
}

resource "azurerm_key_vault_secret" "sqlvm_admin" {
  name         = "sqlvm-windows-admin"
  value        = random_password.sqlvm_admin.result
  key_vault_id = azurerm_key_vault.kv.id
}

resource "azurerm_key_vault_secret" "sqlvm_sqlauth" {
  name         = "sqlvm-sql-login"
  value        = random_password.sqlvm_sqlauth.result
  key_vault_id = azurerm_key_vault.kv.id
}

resource "azurerm_key_vault_secret" "azuresql_admin" {
  name         = "azuresql-admin"
  value        = random_password.azuresql_admin.result
  key_vault_id = azurerm_key_vault.kv.id
}
