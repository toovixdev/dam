# ─────────────────────────────────────────────────────────────────────────────
# Cloud SQL for PostgreSQL (PaaS) — the agentless-path counterpart to the Cloud SQL
# MySQL instance. PRIVATE IP only, in the shared VPC, reusing the existing Private
# Service Access connection (one PSA peering serves every Cloud SQL instance in the VPC).
#
# WHY THIS EXISTS: managed PostgreSQL has no host to install an agent on, so capture has
# to come from the platform's own audit stream. Postgres does that via the **pgAudit**
# extension, which writes audit lines into the Postgres log → Cloud Logging → a sink →
# the Pub/Sub audit topic → the DAM connector.
#
# That is a genuinely different shape from the MySQL PaaS path: Cloud SQL MySQL emits a
# STRUCTURED audit proto (protoPayload.request), whereas pgAudit emits TEXT lines in
# textPayload. Same transport, different parser — see the pgaudit handling in the API.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_sql_database_instance" "paas_pg" {
  name                = var.cloudsql_pg.name
  region              = var.region
  database_version    = var.cloudsql_pg.db_version
  deletion_protection = false

  # Shares the VPC's single PSA peering with the MySQL instance.
  depends_on = [google_service_networking_connection.psa]

  settings {
    tier = var.cloudsql_pg.tier
    # MUST be set explicitly. Newer Postgres versions default to ENTERPRISE_PLUS, which only
    # accepts db-perf-optimized-* tiers (several hundred $/mo) and rejects shared-core ones
    # with "Invalid Tier (db-g1-small) for (ENTERPRISE_PLUS) Edition".
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"

    ip_configuration {
      ipv4_enabled    = false # no public IP
      private_network = google_compute_network.main.id
    }

    # ── pgAudit: the agentless capture source for managed PostgreSQL ──
    # `cloudsql.enable_pgaudit` makes the extension available (RESTARTS the instance when
    # toggled); `pgaudit.log` selects what gets audited. The extension itself still has to be
    # created inside the database — `CREATE EXTENSION pgaudit;` — see the seed step in the
    # runbook, because Terraform has no connection to the private instance to run it.
    dynamic "database_flags" {
      for_each = var.enable_pgaudit ? [1] : []
      content {
        name  = "cloudsql.enable_pgaudit"
        value = "on"
      }
    }

    # read,write,ddl,role — deliberately not "all": ALL includes MISC (every SET/SHOW and
    # internal housekeeping statement), which floods the trail without adding signal.
    dynamic "database_flags" {
      for_each = var.enable_pgaudit ? [1] : []
      content {
        name  = "pgaudit.log"
        value = var.cloudsql_pg.pgaudit_log
      }
    }

    # Log the client address on each line, so the parser can attribute a client_ip.
    dynamic "database_flags" {
      for_each = var.enable_pgaudit ? [1] : []
      content {
        name  = "log_line_prefix"
        value = "%m [%p] %q%u@%d %h "
      }
    }

    backup_configuration {
      enabled = false
    }
  }
}

resource "google_sql_database" "paas_pg" {
  name     = var.cloudsql_pg.db_name
  instance = google_sql_database_instance.paas_pg.name
}

# ── Generated credentials, mirroring the other instances' secret naming. ──
resource "random_password" "paas_pg_root" {
  length  = 20
  special = false
}

resource "random_password" "paas_pg_dam_svc" {
  length  = 20
  special = false
}

# Admin user (kept out of the platform path) + least-privilege service user for TooVix.
resource "google_sql_user" "pg_root" {
  name     = "admin"
  instance = google_sql_database_instance.paas_pg.name
  password = random_password.paas_pg_root.result
}

resource "google_sql_user" "pg_dam_svc" {
  name     = "dam_svc"
  instance = google_sql_database_instance.paas_pg.name
  password = random_password.paas_pg_dam_svc.result
}

locals {
  paas_pg_passwords = {
    "root"    = random_password.paas_pg_root.result
    "dam-svc" = random_password.paas_pg_dam_svc.result
  }
}

resource "google_secret_manager_secret" "paas_pg" {
  for_each  = local.paas_pg_passwords
  secret_id = "toovix-${var.cloudsql_pg.name}-${each.key}"
  labels    = var.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "paas_pg" {
  for_each    = local.paas_pg_passwords
  secret      = google_secret_manager_secret.paas_pg[each.key].id
  secret_data = each.value
}

# ── Cloud Logging sink: pgAudit lines → the audit topic ──
# Separate from the MySQL sink rather than one combined filter: the two instances emit
# different log streams (mysql-audit vs postgres.log), and keeping them apart means a change
# to the Postgres path can't break the MySQL path that already works end-to-end.
resource "google_logging_project_sink" "cloudsql_pg_audit" {
  name        = "toovix-cloudsql-pg-audit-sink"
  destination = "pubsub.googleapis.com/${google_pubsub_topic.audit.id}"
  filter      = <<-EOT
    resource.type="cloudsql_database"
    resource.labels.database_id="${var.project_id}:${google_sql_database_instance.paas_pg.name}"
    logName:"postgres.log"
    textPayload:"AUDIT:"
  EOT

  unique_writer_identity = true
  depends_on             = [google_project_service.logging]
}

resource "google_pubsub_topic_iam_member" "pg_sink_publisher" {
  topic  = google_pubsub_topic.audit.id
  role   = "roles/pubsub.publisher"
  member = google_logging_project_sink.cloudsql_pg_audit.writer_identity
}

output "cloudsql_pg" {
  description = "Cloud SQL for PostgreSQL (PaaS) instance."
  value = {
    name       = google_sql_database_instance.paas_pg.name
    private_ip = google_sql_database_instance.paas_pg.private_ip_address
    db_name    = var.cloudsql_pg.db_name
    vpc        = google_compute_network.main.name
    secrets    = [for s in google_secret_manager_secret.paas_pg : s.secret_id]
    audit      = var.enable_pgaudit ? "pgaudit ON (${var.cloudsql_pg.pgaudit_log}) → ${google_logging_project_sink.cloudsql_pg_audit.name} → ${google_pubsub_topic.audit.name}" : "pgaudit OFF (set enable_pgaudit = true)"
  }
}

output "cloudsql_pg_connect_hint" {
  description = "Reach the private PostgreSQL instance from your Mac via the existing bastion."
  value = join("\n", [
    "gcloud compute ssh ${google_compute_instance.paas_bastion.name} --tunnel-through-iap --zone ${var.zone} -- -N -L 5433:${google_sql_database_instance.paas_pg.private_ip_address}:5432",
    "psql -h 127.0.0.1 -p 5433 -U dam_svc -d ${var.cloudsql_pg.db_name}   # password: gcloud secrets versions access latest --secret=toovix-${var.cloudsql_pg.name}-dam-svc",
  ])
}
