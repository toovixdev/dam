# NAT Gateway — controlled, EGRESS-ONLY internet for the private DB subnet.
# The SQL VM has no public IP; without this it would rely on Azure's deprecated
# "default outbound access". The NAT Gateway gives it a single dedicated outbound
# IP you own (good for far-end allow-listing) while staying inbound-private — so
# the database keeps its private-IP-only posture. No inbound is ever opened.
resource "azurerm_public_ip" "nat" {
  name                = "${var.name_prefix}-nat-pip"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_nat_gateway" "nat" {
  name                    = "${var.name_prefix}-nat"
  location                = azurerm_resource_group.rg.location
  resource_group_name     = azurerm_resource_group.rg.name
  sku_name                = "Standard"
  idle_timeout_in_minutes = 10
}

resource "azurerm_nat_gateway_public_ip_association" "nat" {
  nat_gateway_id       = azurerm_nat_gateway.nat.id
  public_ip_address_id = azurerm_public_ip.nat.id
}

# Attach to the SQL VM subnet — all its outbound now egresses through the NAT IP.
# (snet-pe has no VMs; snet-jumpbox already egresses via the jump-box's own public
#  IP. Add associations here if you want those subnets to share the NAT IP too.)
resource "azurerm_subnet_nat_gateway_association" "dbvm" {
  subnet_id      = azurerm_subnet.dbvm.id
  nat_gateway_id = azurerm_nat_gateway.nat.id
}
