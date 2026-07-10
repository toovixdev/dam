data "azurerm_client_config" "current" {}

resource "random_string" "kv_suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_key_vault" "kv" {
  name                       = "kv-toovix-${random_string.kv_suffix.result}"
  location                   = azurerm_resource_group.rg.location
  resource_group_name        = azurerm_resource_group.rg.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  purge_protection_enabled   = false
  soft_delete_retention_days = 7
  tags                       = var.tags

  access_policy {
    tenant_id          = data.azurerm_client_config.current.tenant_id
    object_id          = data.azurerm_client_config.current.object_id
    secret_permissions = ["Get", "List", "Set", "Delete", "Purge", "Recover"]
  }
}

resource "azurerm_key_vault_secret" "vm_root" {
  for_each     = var.vm_databases
  name         = "toovix-${each.key}-root"
  value        = random_password.vm_root[each.key].result
  key_vault_id = azurerm_key_vault.kv.id
}

resource "azurerm_key_vault_secret" "paas_admin" {
  name         = "toovix-${var.mysql_flexible.name}-admin"
  value        = random_password.paas_admin.result
  key_vault_id = azurerm_key_vault.kv.id
}
