output "adb" {
  description = "Autonomous Database connection facts for registering it in DAM."
  value = {
    id           = oci_database_autonomous_database.adb.id
    db_name      = oci_database_autonomous_database.adb.db_name
    workload     = oci_database_autonomous_database.adb.db_workload
    state        = oci_database_autonomous_database.adb.state
    is_free_tier = oci_database_autonomous_database.adb.is_free_tier
    mtls_required = oci_database_autonomous_database.adb.is_mtls_connection_required
    # The connection strings (high/medium/low/tp/tpurgent service levels). Use one of these
    # as the DAM collector's target; register the ADB in DAM as an Oracle instance.
    connection_strings = oci_database_autonomous_database.adb.connection_strings
    wallet_file        = local_sensitive_file.wallet.filename
  }
}

output "admin_password" {
  description = "ADB ADMIN password (also the base for the wallet password)."
  value       = local.admin_password
  sensitive   = true
}

output "wallet_password" {
  description = "Password for the downloaded wallet bundle."
  value       = local.wallet_password
  sensitive   = true
}
