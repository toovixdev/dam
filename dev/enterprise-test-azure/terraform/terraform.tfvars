subscription_id = "89ac890e-c899-4077-98a6-14d719ea6846"
location        = "centralindia"

admin_ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB0Adb0Fz5w7V0k1CZ7n7vOQOdVKqPytsVyqvASqRbV7 azure-mysql-test"
admin_source_ip      = "202.8.126.140/32"

vm_databases = {
  "db-vm-a" = { vnet_cidr = "10.10.0.0/16", subnet_cidr = "10.10.0.0/24", db_name = "orders" }
  "db-vm-b" = { vnet_cidr = "10.20.0.0/16", subnet_cidr = "10.20.0.0/24", db_name = "customers" }
}

mysql_flexible = {
  name        = "db-paas"
  sku_name    = "B_Standard_B1ms"
  db_name     = "billing"
  vnet_cidr   = "10.30.0.0/16"
  subnet_cidr = "10.30.1.0/24"
}

deploy_agents = false
