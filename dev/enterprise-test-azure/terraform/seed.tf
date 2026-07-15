# Seeds the SQL Server VM with a database of PII/PCI/sensitive data for testing
# classification & audit. Runs sqlcmd on the VM via a Custom Script Extension, after
# the SQL IaaS extension has enabled SQL auth on 1433. Idempotent (guards in the .sql).
locals {
  seed_b64 = base64encode(file("${path.module}/seed/sqlvm-seed.sql"))
  seed_cmd = "powershell -ExecutionPolicy Unrestricted -Command \"$b='${local.seed_b64}'; [IO.File]::WriteAllText('C:\\seed.sql',[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))); sqlcmd -S localhost -U sqladmin -P '${random_password.sqlvm_sqlauth.result}' -C -b -i C:\\seed.sql -o C:\\seed-out.txt\""
}

resource "azurerm_virtual_machine_extension" "seed" {
  name                       = "seed-sensitive-data"
  virtual_machine_id         = azurerm_windows_virtual_machine.sqlvm.id
  publisher                  = "Microsoft.Compute"
  type                       = "CustomScriptExtension"
  type_handler_version       = "1.10"
  auto_upgrade_minor_version = true

  # SQL auth + TCP 1433 must be configured first.
  depends_on = [azurerm_mssql_virtual_machine.sqlvm]

  protected_settings = jsonencode({
    commandToExecute = local.seed_cmd
  })

  # protected_settings is write-only (can't be read back) → ignore to avoid a
  # perpetual diff. To re-seed after editing the .sql: terraform taint this resource.
  lifecycle {
    ignore_changes = [protected_settings]
  }
}
