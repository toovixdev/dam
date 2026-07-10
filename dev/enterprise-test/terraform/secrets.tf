# Generated DB credentials — MySQL root/admin (kept out of the platform path) + a
# least-privilege service user the platform uses (per TooVix's security rule). Stored in
# Secret Manager. NOTE: for_each keys are non-sensitive strings; the sensitive passwords are
# only referenced in secret_data (Terraform forbids sensitive values in for_each).

resource "random_password" "vm_root" {
  for_each = var.vm_databases
  length   = 20
  special  = false
}

resource "random_password" "vm_dam_svc" {
  for_each = var.vm_databases
  length   = 20
  special  = false
}

resource "random_password" "paas_root" {
  length  = 20
  special = false
}

resource "random_password" "paas_dam_svc" {
  length  = 20
  special = false
}

locals {
  secret_keys = toset(concat(
    flatten([for k in keys(var.vm_databases) : ["${k}-root", "${k}-dam-svc"]]),
    ["${var.cloudsql.name}-root", "${var.cloudsql.name}-dam-svc"],
  ))
  db_passwords = merge(
    { for k, v in var.vm_databases : "${k}-root" => random_password.vm_root[k].result },
    { for k, v in var.vm_databases : "${k}-dam-svc" => random_password.vm_dam_svc[k].result },
    { "${var.cloudsql.name}-root" = random_password.paas_root.result },
    { "${var.cloudsql.name}-dam-svc" = random_password.paas_dam_svc.result },
  )
}

resource "google_secret_manager_secret" "db" {
  for_each  = local.secret_keys
  secret_id = "toovix-${each.value}"
  labels    = var.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db" {
  for_each    = local.secret_keys
  secret      = google_secret_manager_secret.db[each.key].id
  secret_data = local.db_passwords[each.key]
}
