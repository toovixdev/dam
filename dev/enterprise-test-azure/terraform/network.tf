locals {
  jumpbox_cidr = cidrsubnet(var.hub_cidr, 8, 1) # 10.0.1.0/24 from 10.0.0.0/16
}

# ===================== HUB (jump-box) =====================
resource "azurerm_virtual_network" "hub" {
  name                = "vnet-hub"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  address_space       = [var.hub_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "jumpbox" {
  name                 = "snet-jumpbox"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.hub.name
  address_prefixes     = [local.jumpbox_cidr]
}

resource "azurerm_network_security_group" "jumpbox" {
  name                = "nsg-jumpbox"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = var.tags

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
}

resource "azurerm_subnet_network_security_group_association" "jumpbox" {
  subnet_id                 = azurerm_subnet.jumpbox.id
  network_security_group_id = azurerm_network_security_group.jumpbox.id
}

# ===================== VM DATABASE SPOKES =====================
resource "azurerm_virtual_network" "vm" {
  for_each            = var.vm_databases
  name                = "vnet-${each.key}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  address_space       = [each.value.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "vm" {
  for_each             = var.vm_databases
  name                 = "snet-db"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vm[each.key].name
  address_prefixes     = [each.value.subnet_cidr]
}

# NSG: SSH only from the hub (jump-box); 3306 only within this subnet (future app);
# 3306 denied from everything else (incl. peered VNets, which Azure would otherwise allow).
resource "azurerm_network_security_group" "vm" {
  for_each            = var.vm_databases
  name                = "nsg-${each.key}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tags                = var.tags

  security_rule {
    name                       = "allow-ssh-from-hub"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = local.jumpbox_cidr
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "allow-mysql-intra-subnet"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3306"
    source_address_prefix      = each.value.subnet_cidr
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "deny-mysql-other"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3306"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "vm" {
  for_each                  = var.vm_databases
  subnet_id                 = azurerm_subnet.vm[each.key].id
  network_security_group_id = azurerm_network_security_group.vm[each.key].id
}

# NAT gateway per VM VNet — outbound egress for private (no public IP) VMs.
resource "azurerm_public_ip" "nat" {
  for_each            = var.vm_databases
  name                = "pip-nat-${each.key}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway" "vm" {
  for_each            = var.vm_databases
  name                = "nat-${each.key}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  sku_name            = "Standard"
  tags                = var.tags
}

resource "azurerm_nat_gateway_public_ip_association" "vm" {
  for_each             = var.vm_databases
  nat_gateway_id       = azurerm_nat_gateway.vm[each.key].id
  public_ip_address_id = azurerm_public_ip.nat[each.key].id
}

resource "azurerm_subnet_nat_gateway_association" "vm" {
  for_each       = var.vm_databases
  subnet_id      = azurerm_subnet.vm[each.key].id
  nat_gateway_id = azurerm_nat_gateway.vm[each.key].id
}

# ===================== FLEXIBLE SERVER SPOKE =====================
resource "azurerm_virtual_network" "paas" {
  name                = "vnet-${var.mysql_flexible.name}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  address_space       = [var.mysql_flexible.vnet_cidr]
  tags                = var.tags
}

# Subnet delegated to the MySQL Flexible Server (VNet injection = private access).
resource "azurerm_subnet" "paas" {
  name                 = "snet-mysql"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.paas.name
  address_prefixes     = [var.mysql_flexible.subnet_cidr]

  delegation {
    name = "fs"
    service_delegation {
      name    = "Microsoft.DBforMySQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# Link the private DNS zone to both the Flexible Server VNet and the hub (so the jump-box resolves it).
resource "azurerm_private_dns_zone_virtual_network_link" "paas" {
  name                  = "link-paas"
  resource_group_name   = azurerm_resource_group.rg.name
  private_dns_zone_name = azurerm_private_dns_zone.mysql.name
  virtual_network_id    = azurerm_virtual_network.paas.id
}

resource "azurerm_private_dns_zone_virtual_network_link" "hub" {
  name                  = "link-hub"
  resource_group_name   = azurerm_resource_group.rg.name
  private_dns_zone_name = azurerm_private_dns_zone.mysql.name
  virtual_network_id    = azurerm_virtual_network.hub.id
}

# ===================== HUB <-> SPOKE PEERINGS =====================
locals {
  spokes = merge(
    { for k, v in var.vm_databases : k => { id = azurerm_virtual_network.vm[k].id, name = azurerm_virtual_network.vm[k].name } },
    { (var.mysql_flexible.name) = { id = azurerm_virtual_network.paas.id, name = azurerm_virtual_network.paas.name } },
  )
}

resource "azurerm_virtual_network_peering" "hub_to_spoke" {
  for_each                     = local.spokes
  name                         = "hub-to-${each.key}"
  resource_group_name          = azurerm_resource_group.rg.name
  virtual_network_name         = azurerm_virtual_network.hub.name
  remote_virtual_network_id    = each.value.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = false
}

resource "azurerm_virtual_network_peering" "spoke_to_hub" {
  for_each                     = local.spokes
  name                         = "${each.key}-to-hub"
  resource_group_name          = azurerm_resource_group.rg.name
  virtual_network_name         = each.value.name
  remote_virtual_network_id    = azurerm_virtual_network.hub.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = false
}
