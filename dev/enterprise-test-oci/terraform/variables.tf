# ── OCI auth (from the API-key config preview in the Console) ──────────────────
# Console → your profile → User settings → API keys → Add API key → download the private
# key; OCI then shows a config snippet with the tenancy/user OCIDs, fingerprint and region.
variable "tenancy_ocid" { type = string }
variable "user_ocid" { type = string }
variable "fingerprint" { type = string }
variable "private_key_path" {
  type    = string
  default = "~/.oci/oci_api_key.pem"
}
variable "region" {
  type    = string
  default = "ap-mumbai-1"
}

# Where the ADB is created. Use the tenancy OCID for the root compartment, or a child
# compartment's OCID to keep the test estate isolated.
variable "compartment_ocid" { type = string }

# ── The Autonomous Database (PaaS) ─────────────────────────────────────────────
variable "adb" {
  type = object({
    db_name     = optional(string, "TOOVIXADB") # ≤14 chars, alphanumeric, no leading digit
    display_name = optional(string, "toovix-adb")
    workload    = optional(string, "OLTP")      # OLTP = ATP · DW = ADW
    db_version  = optional(string, "23ai")      # 19c | 23ai
    is_free_tier = optional(bool, true)          # Always Free: 1 OCPU / 20 GB, never expires
    cpu_cores   = optional(number, 1)           # forced to 1 when is_free_tier = true
    storage_tbs = optional(number, 1)           # forced to 20 GB when is_free_tier = true
  })
  default = {}
}

# Network access. Always-Free ADB has a PUBLIC endpoint (no private endpoint on free tier),
# gated by an IP allow-list. List the addresses that may connect — e.g. your workstation's
# egress and the DAM collector host's egress. Leaving it empty means OCI blocks everything.
variable "allowed_ips" {
  type    = list(string)
  default = []
}

# mTLS. When true (default OCI behaviour), clients must present the downloaded wallet.
# Set FALSE to let a client connect with plain TLS and no wallet — which is how the DAM
# Oracle AgentLite collector (go-ora) reaches ADB without wallet support. Only safe behind a
# tight allowed_ips list; keep it true + use the wallet for anything production-facing.
variable "require_mtls" {
  type    = bool
  default = false
}

# Password for the wallet bundle (separate from the DB admin password).
variable "wallet_password" {
  type      = string
  default   = "" # empty → a random one is generated (see adb.tf)
  sensitive = true
}
