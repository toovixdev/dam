terraform {
  required_version = ">= 1.5.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

# Auth reads ~/.oci/config [DEFAULT] by default. The explicit fields below let you drive it
# from terraform.tfvars / TF_VAR_* instead (better for CI). For interactive use you can swap to
# a short-lived browser session token: run `oci session authenticate`, then set
#   auth = "SecurityToken"  and  config_file_profile = "<profile>"
# and drop the key fields.
provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}
