variable "subscription_id" {
  type        = string
  description = "Azure subscription ID (az account show --query id -o tsv)."
}

variable "location" {
  type    = string
  default = "centralindia"
}

variable "resource_group_name" {
  type    = string
  default = "rg-toovix-enterprise-test"
}

variable "admin_username" {
  type    = string
  default = "azureuser"
}

variable "admin_ssh_public_key" {
  type        = string
  description = "Contents of your SSH public key (e.g. file(\"~/.ssh/azure_mysql.pub\"))."
}

variable "admin_source_ip" {
  type        = string
  description = "Your public IP (CIDR) allowed to SSH the jump-box, e.g. 203.0.113.4/32. Get it: curl -s ifconfig.me"
}

variable "vm_size" {
  type    = string
  default = "Standard_B1ms"
}

variable "vm_image" {
  type = object({
    publisher = optional(string, "Canonical")
    offer     = optional(string, "ubuntu-24_04-lts")
    sku       = optional(string, "server")
    version   = optional(string, "latest")
  })
  default = {}
}

# Hub (jump-box) network + the two MySQL-on-VM spokes + the Flexible Server spoke.
variable "hub_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "vm_databases" {
  description = "MySQL-on-VM databases. Key = name. Each gets its own VNet (spoke) + subnet."
  type = map(object({
    vnet_cidr   = string
    subnet_cidr = string
    db_name     = string
  }))
  default = {
    "db-vm-a" = { vnet_cidr = "10.10.0.0/16", subnet_cidr = "10.10.0.0/24", db_name = "orders" }
    "db-vm-b" = { vnet_cidr = "10.20.0.0/16", subnet_cidr = "10.20.0.0/24", db_name = "customers" }
  }
}

variable "mysql_flexible" {
  type = object({
    name        = optional(string, "db-paas")
    sku_name    = optional(string, "B_Standard_B1ms")
    version     = optional(string, "8.0.21")
    db_name     = optional(string, "billing")
    vnet_cidr   = optional(string, "10.30.0.0/16")
    subnet_cidr = optional(string, "10.30.1.0/24") # delegated to the Flexible Server
  })
  default = {}
}

variable "deploy_agents" {
  type        = bool
  default     = false
  description = "PHASE 2 placeholder — infra applies without any DAM/agent config."
}

variable "tags" {
  type    = map(string)
  default = { env = "toovix-enterprise-test", managed_by = "terraform" }
}
