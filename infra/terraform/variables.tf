variable "project_id" {
  description = "GCP project ID where resources will be created."
  type        = string
}

variable "region" {
  description = "GCP region for the subnet and VMs."
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "GCP zone for the VM instances."
  type        = string
  default     = "us-central1-a"
}

variable "name_prefix" {
  description = "Prefix applied to all resource names."
  type        = string
  default     = "dam-db"
}

variable "subnet_cidr" {
  description = "Primary CIDR range for the private subnet."
  type        = string
  default     = "10.10.0.0/24"
}

variable "ssh_source_ranges" {
  description = <<-EOT
    Source ranges allowed to reach the VMs on SSH (tcp/22).
    Default is Google's IAP range so you can SSH through Identity-Aware Proxy
    without giving the VMs public IPs. Add your office/VPN CIDRs if needed.
  EOT
  type    = list(string)
  default = ["35.235.240.0/20"] # IAP TCP forwarding range
}

variable "db_client_source_ranges" {
  description = "Source ranges allowed to reach the DB ports (MySQL 3306, Oracle 1521). Keep internal by default."
  type        = list(string)
  default     = ["10.10.0.0/24"]
}

# ---- MySQL VM ----
variable "mysql_machine_type" {
  description = "Machine type for the MySQL VM."
  type        = string
  default     = "e2-medium"
}

variable "mysql_disk_size_gb" {
  description = "Boot disk size (GB) for the MySQL VM."
  type        = number
  default     = 30
}

# ---- Oracle VM ----
variable "oracle_machine_type" {
  description = "Machine type for the Oracle VM. Oracle XE 21c needs >= 2 vCPU / 8 GB RAM."
  type        = string
  default     = "e2-standard-2"
}

variable "oracle_disk_size_gb" {
  description = "Boot disk size (GB) for the Oracle VM. Oracle needs headroom."
  type        = number
  default     = 60
}
