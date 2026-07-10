# Jump-box in the hub — the single entry point to reach the private DBs (SSH from your IP,
# then hop to the VM DBs over peering, and seed/reach the Flexible Server by its FQDN).
resource "azurerm_public_ip" "jumpbox" {
  name                = "pip-jumpbox"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_network_interface" "jumpbox" {
  name                = "nic-jumpbox"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = var.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.jumpbox.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.jumpbox.id
  }
}

resource "azurerm_linux_virtual_machine" "jumpbox" {
  name                  = "jumpbox"
  location              = azurerm_resource_group.rg.location
  resource_group_name   = azurerm_resource_group.rg.name
  size                  = var.vm_size
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.jumpbox.id]
  tags                  = var.tags

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = var.vm_image.publisher
    offer     = var.vm_image.offer
    sku       = var.vm_image.sku
    version   = var.vm_image.version
  }

  # Installs the mysql client and seeds the Flexible Server 'billing' DB (retries until reachable).
  custom_data = base64encode(templatefile("${path.module}/templates/jumpbox-init.sh.tftpl", {
    fqdn           = azurerm_mysql_flexible_server.paas.fqdn
    admin_user     = "dbadmin"
    admin_password = random_password.paas_admin.result
    seed_b64       = fileexists("${path.module}/seed/${var.mysql_flexible.db_name}.sql") ? base64encode(file("${path.module}/seed/${var.mysql_flexible.db_name}.sql")) : ""
  }))

  depends_on = [azurerm_mysql_flexible_database.paas]
}
