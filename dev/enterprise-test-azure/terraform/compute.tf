# MySQL-on-VM databases. Private IP only (no public IP); egress via NAT gateway.
resource "azurerm_network_interface" "vm" {
  for_each            = var.vm_databases
  name                = "nic-${each.key}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = var.tags

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.vm[each.key].id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "vm" {
  for_each              = var.vm_databases
  name                  = each.key
  location              = azurerm_resource_group.rg.location
  resource_group_name   = azurerm_resource_group.rg.name
  size                  = var.vm_size
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.vm[each.key].id]
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

  custom_data = base64encode(templatefile("${path.module}/templates/mysql-vm-init.sh.tftpl", {
    db_name       = each.value.db_name
    root_password = random_password.vm_root[each.key].result
    seed_b64      = fileexists("${path.module}/seed/${each.value.db_name}.sql") ? base64encode(file("${path.module}/seed/${each.value.db_name}.sql")) : ""
  }))
}
