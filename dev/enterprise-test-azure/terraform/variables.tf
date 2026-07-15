variable "subscription_id" {
  description = "Azure subscription ID to deploy into (get: az account show --query id -o tsv)."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
  default     = "centralindia"
}

variable "name_prefix" {
  description = "Prefix for all resource names."
  type        = string
  default     = "toovix-sqltest"
}

variable "admin_source_ip" {
  description = <<-EOT
    Your public IP (CIDR) allowed to reach the jump-box on SSH — e.g. "203.0.113.10/32".
    Get it with: echo "$(curl -s ifconfig.me)/32". Changing locations? Just update this and re-apply.
  EOT
  type        = string
}

variable "admin_ssh_public_key" {
  description = "SSH public key for the Linux jump-box (paste ~/.ssh/azure_sqltest.pub)."
  type        = string
}

variable "admin_username" {
  description = "Admin username for the jump-box and the SQL Server VM."
  type        = string
  default     = "azureadmin"
}

# ── Network ──
variable "vnet_cidr" {
  description = "Address space for the VNet."
  type        = string
  default     = "10.20.0.0/16"
}

variable "subnet_jumpbox_cidr" {
  description = "Jump-box subnet."
  type        = string
  default     = "10.20.1.0/24"
}

variable "subnet_dbvm_cidr" {
  description = "SQL Server VM subnet."
  type        = string
  default     = "10.20.2.0/24"
}

variable "subnet_pe_cidr" {
  description = "Private Endpoint subnet (for Azure SQL private access)."
  type        = string
  default     = "10.20.3.0/24"
}

# ── SQL Server VM (IaaS) ──
variable "sql_vm_size" {
  description = "VM size for the SQL Server VM (SQL needs >= 2 vCPU / 8 GB)."
  type        = string
  default     = "Standard_D2s_v5"
}

variable "sql_vm_image_sku" {
  description = <<-EOT
    SQL Server 2022 marketplace image SKU (offer sql2022-ws2022):
      standard-gen2   = Standard edition, License Included (production billing) — default
      enterprise-gen2 = Enterprise edition, License Included
      web-gen2        = Web edition
      sqldev-gen2     = Developer edition (free; not for production)
    License Included editions incur an hourly SQL Server licence charge on top of the VM.
  EOT
  type        = string
  default     = "sqldev-gen2"
}

variable "sql_vm_sql_login" {
  description = "SQL auth login created on the VM's SQL Server (for the app / DAM reader)."
  type        = string
  default     = "sqladmin"
}

# ── Jump-box ──
variable "jumpbox_size" {
  description = "VM size for the Linux jump-box. (B-series is capacity-restricted in CentralIndia; D2s_v5 deploys regionally.)"
  type        = string
  default     = "Standard_D2s_v5"
}

# ── Azure SQL Database (PaaS) ──
variable "azuresql_admin_login" {
  description = "Administrator login for the Azure SQL logical server."
  type        = string
  default     = "sqladmin"
}

variable "azuresql_db_sku" {
  description = "Azure SQL Database SKU (Basic/S0/GP_S_Gen5_1…). Basic is cheapest for a test."
  type        = string
  default     = "Basic"
}
