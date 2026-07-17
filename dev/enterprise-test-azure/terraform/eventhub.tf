# ── Agentless SQL Server audit pipeline: Azure SQL Auditing → Event Hub ───────────────
# The managed DB (Azure SQL) can't host an agent, so its native audit (SQLSecurityAuditEvents)
# is streamed to an Event Hub that the DAM connector consumes — the Azure analog of the GCP
# Pub/Sub path. (The DAM-side Event Hub consumer is the remaining build; this provisions the
# Azure side end-to-end so audit events land in the hub.)

# ── The audit bus (Event Hub) ─────────────────────────────────────────────────────────
resource "azurerm_eventhub_namespace" "audit" {
  name                = "${var.name_prefix}-ehns-${random_string.sqlserver_suffix.result}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku                 = "Standard" # Standard = custom consumer groups + up to 7-day retention
  capacity            = 1
}

resource "azurerm_eventhub" "audit" {
  name              = "toovix-dam-audit"
  namespace_id      = azurerm_eventhub_namespace.audit.id
  partition_count   = 2
  message_retention = 7
}

# The consumer group the DAM connector reads from (isolated from other readers).
resource "azurerm_eventhub_consumer_group" "dam" {
  name                = "toovix-dam"
  namespace_name      = azurerm_eventhub_namespace.audit.name
  eventhub_name       = azurerm_eventhub.audit.name
  resource_group_name = azurerm_resource_group.rg.name
}

# SAS rule the diagnostic setting uses to SEND audit into the hub.
resource "azurerm_eventhub_namespace_authorization_rule" "diag_send" {
  name                = "diag-send"
  namespace_name      = azurerm_eventhub_namespace.audit.name
  resource_group_name = azurerm_resource_group.rg.name
  listen              = false
  send                = true
  manage              = false
}

# SAS rule the DAM consumer uses to LISTEN (swap to a Managed-Identity "Data Receiver" role
# for least privilege in production).
resource "azurerm_eventhub_authorization_rule" "dam_listen" {
  name                = "dam-listen"
  namespace_name      = azurerm_eventhub_namespace.audit.name
  eventhub_name       = azurerm_eventhub.audit.name
  resource_group_name = azurerm_resource_group.rg.name
  listen              = true
  send                = false
  manage              = false
}

# ── Turn on Azure SQL auditing and route it to the hub ────────────────────────────────
# log_monitoring_enabled routes audit to the diagnostic-settings destinations below
# (Event Hub) rather than requiring a storage account.
resource "azurerm_mssql_server_extended_auditing_policy" "paas" {
  server_id              = azurerm_mssql_server.paas.id
  log_monitoring_enabled = true
}

# The database's SQLSecurityAuditEvents → Event Hub.
resource "azurerm_monitor_diagnostic_setting" "sql_audit" {
  name                           = "toovix-sql-audit-to-eventhub"
  target_resource_id             = azurerm_mssql_database.paas.id
  eventhub_name                  = azurerm_eventhub.audit.name
  eventhub_authorization_rule_id = azurerm_eventhub_namespace_authorization_rule.diag_send.id

  enabled_log {
    category = "SQLSecurityAuditEvents"
  }

  depends_on = [azurerm_mssql_server_extended_auditing_policy.paas]
}

# ── Outputs to configure the DAM connector (once the Event Hub consumer ships) ─────────
output "eventhub_namespace" {
  value = azurerm_eventhub_namespace.audit.name
}
output "eventhub_name" {
  value = azurerm_eventhub.audit.name
}
output "eventhub_consumer_group" {
  value = azurerm_eventhub_consumer_group.dam.name
}
output "eventhub_listen_connection_string" {
  description = "Connection string the DAM connector uses to pull audit events."
  value       = azurerm_eventhub_authorization_rule.dam_listen.primary_connection_string
  sensitive   = true
}
