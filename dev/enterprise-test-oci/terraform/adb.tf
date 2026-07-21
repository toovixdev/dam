# ─────────────────────────────────────────────────────────────────────────────
# OCI Autonomous Database (PaaS) — the OCI managed-Oracle target for DAM.
#
# Defaults to Always Free (1 OCPU / 20 GB, never expires): a public endpoint gated by an IP
# allow-list. Always Free does NOT support a private endpoint — for that, set is_free_tier =
# false and add subnet_id/nsg_ids (a VCN + private subnet), which is a paid instance.
#
# DAM angle: this validates the one unverified claim in the Oracle capture matrix — that the
# AgentLite Oracle collector reaches MANAGED OCI. With require_mtls = false + a tight
# allowed_ips list, the collector connects over plain TLS (no wallet) and polls
# UNIFIED_AUDIT_TRAIL exactly as it does against Oracle-on-a-VM. The wallet is still exported
# below for the mTLS path if you prefer it.
# ─────────────────────────────────────────────────────────────────────────────

# Admin password. OCI rules: 12–30 chars, ≥1 upper, ≥1 lower, ≥1 digit, no double-quote, and
# it must not contain the admin username. random alphanumeric + a fixed complexity suffix
# guarantees the character-class requirement without special chars OCI rejects.
resource "random_password" "adb_admin" {
  length  = 20
  special = false
}
locals {
  admin_password  = "Tvx1${random_password.adb_admin.result}"                                   # guarantees upper+lower+digit
  wallet_password = var.wallet_password != "" ? var.wallet_password : "Wlt1${random_password.adb_admin.result}"
}

resource "oci_database_autonomous_database" "adb" {
  compartment_id = var.compartment_ocid
  db_name        = var.adb.db_name
  display_name   = var.adb.display_name
  db_workload    = var.adb.workload
  db_version     = var.adb.db_version
  admin_password = local.admin_password

  is_free_tier = var.adb.is_free_tier
  # Free tier forces 1 OCPU / 20 GB; these values are accepted and ignored when is_free_tier.
  cpu_core_count           = var.adb.cpu_cores
  data_storage_size_in_tbs = var.adb.storage_tbs

  # Public endpoint + allow-list (the Always-Free shape). whitelisted_ips = [] blocks all.
  whitelisted_ips              = var.allowed_ips
  is_mtls_connection_required  = var.require_mtls

  # ── Paid private-endpoint alternative (requires is_free_tier = false + a VCN/subnet) ──
  # subnet_id              = oci_core_subnet.adb[0].id
  # nsg_ids                = [oci_core_network_security_group.adb[0].id]
  # private_endpoint_label = "toovix-adb"

  lifecycle {
    ignore_changes = [admin_password] # rotate deliberately, not on every plan
  }
}

# The connection wallet (mTLS bundle). Exported even when require_mtls = false, so you can
# switch to wallet-based connections without re-applying. Written next to the terraform.
resource "oci_database_autonomous_database_wallet" "adb" {
  autonomous_database_id = oci_database_autonomous_database.adb.id
  password               = local.wallet_password
  generate_type          = "SINGLE"
  base64_encode_content  = true
}

resource "local_sensitive_file" "wallet" {
  content_base64 = oci_database_autonomous_database_wallet.adb.content
  filename       = "${path.module}/wallet-${var.adb.db_name}.zip"
  file_permission = "0600"
}
