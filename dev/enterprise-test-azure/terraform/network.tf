resource "azurerm_resource_group" "rg" {
  name     = "${var.name_prefix}-rg"
  location = var.location
}

# Single VNet with three subnets: jump-box (public entry), the SQL VM, and the
# Private Endpoint subnet for Azure SQL. DBs have no public IPs.
resource "azurerm_virtual_network" "vnet" {
  name                = "${var.name_prefix}-vnet"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  address_space       = [var.vnet_cidr]
}

resource "azurerm_subnet" "jumpbox" {
  name                 = "snet-jumpbox"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.subnet_jumpbox_cidr]
}

resource "azurerm_subnet" "dbvm" {
  name                 = "snet-dbvm"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.subnet_dbvm_cidr]
}

resource "azurerm_subnet" "pe" {
  name                 = "snet-pe"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.subnet_pe_cidr]
  # Private Endpoints require network policies disabled on their subnet.
  private_endpoint_network_policies = "Disabled"
}

# ── NSGs ──────────────────────────────────────────────────────────────────────
# Jump-box: SSH only from your IP.
resource "azurerm_network_security_group" "jumpbox" {
  name                = "${var.name_prefix}-nsg-jumpbox"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  security_rule {
    name                       = "allow-ssh-from-admin"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = var.admin_source_ip
    destination_address_prefix = "*"
  }
  # SSH also offered on 443 — many office/corporate firewalls block outbound 22
  # but allow 443. sshd on the jump-box is configured to listen on both.
  security_rule {
    name                       = "allow-ssh-443-from-admin"
    priority                   = 105
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = var.admin_source_ip
    destination_address_prefix = "*"
  }
}

# SQL VM: SQL (1433) and RDP (3389) reachable ONLY from the jump-box subnet; a
# lower-priority deny blocks 1433 from the rest of the VNet (keeps DBs isolated —
# Azure's default rules would otherwise allow all intra-VNet traffic).
resource "azurerm_network_security_group" "dbvm" {
  name                = "${var.name_prefix}-nsg-dbvm"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  security_rule {
    name                       = "allow-sql-from-jumpbox"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "1433"
    source_address_prefix      = var.subnet_jumpbox_cidr
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "allow-rdp-from-jumpbox"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3389"
    source_address_prefix      = var.subnet_jumpbox_cidr
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "deny-sql-from-vnet"
    priority                   = 200
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "1433"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "jumpbox" {
  subnet_id                 = azurerm_subnet.jumpbox.id
  network_security_group_id = azurerm_network_security_group.jumpbox.id
}

resource "azurerm_subnet_network_security_group_association" "dbvm" {
  subnet_id                 = azurerm_subnet.dbvm.id
  network_security_group_id = azurerm_network_security_group.dbvm.id
}
