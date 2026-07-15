# ── Audit backbone (Pub/Sub) for the agentless / AgentLite capture paths ──────────────
# One topic is the single audit bus for the whole tenant:
#   • PaaS (Cloud SQL)  → native audit → Cloud Logging → a log sink → this topic
#   • Self-managed VMs  → the TooVix AgentLite forwarder tails the audit log → publishes here
# The DAM control-plane connector pulls the subscription (streaming) and ingests events.
#
# NOTE: the AgentLite forwarder currently POSTs straight to the control plane; publishing to
# this topic is the next code step. This TF provisions the infra + credentials it will use.

# APIs this needs (idempotent; safe if already enabled).
resource "google_project_service" "pubsub" {
  project            = var.project_id
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}
resource "google_project_service" "logging" {
  project            = var.project_id
  service            = "logging.googleapis.com"
  disable_on_destroy = false
}

# ── The audit bus ──────────────────────────────────────────────────────────────────────
resource "google_pubsub_topic" "audit" {
  name       = "toovix-dam-audit"
  labels     = var.labels
  depends_on = [google_project_service.pubsub]
}

# The control plane pulls this subscription. 7-day retention so a control-plane outage
# doesn't lose events; a short ack deadline for near-real-time streaming pull.
resource "google_pubsub_subscription" "audit" {
  name                       = "toovix-dam-audit-sub"
  topic                      = google_pubsub_topic.audit.id
  ack_deadline_seconds       = 20
  message_retention_duration = "604800s" # 7 days
  retain_acked_messages      = false
  expiration_policy { ttl = "" } # never expire
  labels = var.labels
}

# ── Cloud SQL (PaaS Agentless) → this topic, via a Cloud Logging sink ───────────────────
# Requires Cloud SQL's database audit to be ON (see enable_cloudsql_audit in cloudsql.tf),
# which routes the DB's audit records into Cloud Logging. This sink forwards just this
# instance's audit to the bus.
resource "google_logging_project_sink" "cloudsql_audit" {
  name        = "toovix-cloudsql-audit-sink"
  destination = "pubsub.googleapis.com/${google_pubsub_topic.audit.id}"
  filter      = <<-EOT
    resource.type="cloudsql_database"
    resource.labels.database_id="${var.project_id}:${google_sql_database_instance.paas.name}"
    (logName:"cloudaudit.googleapis.com" OR logName:"mysql-audit" OR logName:"mysql-general")
  EOT

  unique_writer_identity = true
  depends_on             = [google_project_service.logging]
}

# The sink writes to Pub/Sub as its own service identity — grant it publish on the topic.
resource "google_pubsub_topic_iam_member" "sink_publisher" {
  topic  = google_pubsub_topic.audit.id
  role   = "roles/pubsub.publisher"
  member = google_logging_project_sink.cloudsql_audit.writer_identity
}

# ── Identities & IAM ────────────────────────────────────────────────────────────────────
# SA *keys* are disabled by org policy (iam.disableServiceAccountKeyCreation) — the better
# posture anyway. So auth is via ADC (attached SA / metadata), not key files:
#   • the forwarder runs on a GCP VM → uses that VM's SA
#   • the DAM connector runs on a GCP VM (same project) → uses that VM's SA
# Both the estate VMs and the DAM host currently run as the DEFAULT compute SA, so granting it
# publish + subscribe is the zero-change path. (Swap to the dedicated SAs below by attaching
# them to the respective VMs when you want tighter scoping.)
data "google_compute_default_service_account" "default" {}

resource "google_pubsub_topic_iam_member" "default_publisher" {
  topic  = google_pubsub_topic.audit.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}
resource "google_pubsub_subscription_iam_member" "default_subscriber" {
  subscription = google_pubsub_subscription.audit.id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${data.google_compute_default_service_account.default.email}"
}

# Dedicated identities (attach to the forwarder VM / DAM host for least privilege — no keys).
resource "google_service_account" "forwarder" {
  account_id   = "toovix-forwarder"
  display_name = "TooVix AgentLite forwarder (publishes DB audit to Pub/Sub)"
}
resource "google_pubsub_topic_iam_member" "forwarder_publisher" {
  topic  = google_pubsub_topic.audit.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.forwarder.email}"
}
resource "google_service_account" "connector" {
  account_id   = "toovix-connector"
  display_name = "TooVix DAM connector (pulls audit from Pub/Sub)"
}
resource "google_pubsub_subscription_iam_member" "connector_subscriber" {
  subscription = google_pubsub_subscription.audit.id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.connector.email}"
}

# ── Outputs — used to configure the forwarder + the DAM connector ───────────────────────
output "audit_topic" {
  value = google_pubsub_topic.audit.id
}
output "audit_subscription" {
  description = "Configure this in the DAM console → connectors (auth via the DAM host's SA, ADC)."
  value       = google_pubsub_subscription.audit.id
}
