# ── Linux jump-box (public entry point; Azure has no SSM/IAP) ─────────────────
resource "azurerm_public_ip" "jumpbox" {
  name                = "${var.name_prefix}-jumpbox-pip"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "jumpbox" {
  name                = "${var.name_prefix}-jumpbox-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "ipconfig"
    subnet_id                     = azurerm_subnet.jumpbox.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.jumpbox.id
  }
}

resource "azurerm_linux_virtual_machine" "jumpbox" {
  name                  = "${var.name_prefix}-jumpbox"
  location              = azurerm_resource_group.rg.location
  resource_group_name   = azurerm_resource_group.rg.name
  size                  = var.jumpbox_size
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.jumpbox.id]

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  # Install sqlcmd tools so you can reach both SQL targets from the jump-box.
  custom_data = base64encode(<<-EOT
    #!/bin/bash
    set -e
    curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | sudo tee /etc/apt/trusted.gpg.d/microsoft.asc >/dev/null
    curl -fsSL https://packages.microsoft.com/config/ubuntu/24.04/prod.list | sudo tee /etc/apt/sources.list.d/mssql-release.list >/dev/null
    sudo apt-get update -y
    sudo ACCEPT_EULA=Y apt-get install -y mssql-tools18 unixodbc-dev
    echo 'export PATH="$PATH:/opt/mssql-tools18/bin"' | sudo tee /etc/profile.d/mssql.sh
  EOT
  )
}

# ── SQL Server on a Windows VM (IaaS) ─────────────────────────────────────────
resource "azurerm_network_interface" "sqlvm" {
  name                = "${var.name_prefix}-sqlvm-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "ipconfig"
    subnet_id                     = azurerm_subnet.dbvm.id
    private_ip_address_allocation = "Dynamic"
    # No public IP — reached only via the jump-box.
  }
}

resource "azurerm_windows_virtual_machine" "sqlvm" {
  name = "${var.name_prefix}-sqlvm"
  # Windows NetBIOS computer name is capped at 15 chars (the VM name is longer).
  computer_name       = "toovix-sqlvm"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  size                = var.sql_vm_size
  admin_username      = var.admin_username
  admin_password      = random_password.sqlvm_admin.result

  network_interface_ids = [azurerm_network_interface.sqlvm.id]

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
  }

  # SQL Server 2022 on Windows Server 2022. Edition set by sql_vm_image_sku
  # (default standard-gen2 = Standard, License Included — production billing).
  source_image_reference {
    publisher = "MicrosoftSQLServer"
    offer     = "sql2022-ws2022"
    sku       = var.sql_vm_image_sku
    version   = "latest"
  }
}

# Registers the VM with the SQL IaaS extension and enables SQL auth + TCP 1433
# on the private network — creates the SQL login used by apps / the DAM reader.
resource "azurerm_mssql_virtual_machine" "sqlvm" {
  virtual_machine_id               = azurerm_windows_virtual_machine.sqlvm.id
  sql_license_type                 = "PAYG"
  sql_connectivity_type            = "PRIVATE"
  sql_connectivity_port            = 1433
  sql_connectivity_update_username = var.sql_vm_sql_login
  sql_connectivity_update_password = random_password.sqlvm_sqlauth.result
}
