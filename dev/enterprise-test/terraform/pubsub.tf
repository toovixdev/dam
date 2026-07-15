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

# ── AgentLite forwarder identity (self-managed VMs) — publishes audit to the bus ─────────
resource "google_service_account" "forwarder" {
  account_id   = "toovix-forwarder"
  display_name = "TooVix AgentLite forwarder (publishes DB audit to Pub/Sub)"
}
resource "google_pubsub_topic_iam_member" "forwarder_publisher" {
  topic  = google_pubsub_topic.audit.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.forwarder.email}"
}
# Key the forwarder uses to authenticate (drop into the agent as GOOGLE_APPLICATION_CREDENTIALS).
resource "google_service_account_key" "forwarder" {
  service_account_id = google_service_account.forwarder.name
}

# ── Control-plane connector identity — pulls the subscription ───────────────────────────
resource "google_service_account" "connector" {
  account_id   = "toovix-connector"
  display_name = "TooVix DAM connector (pulls audit from Pub/Sub)"
}
resource "google_pubsub_subscription_iam_member" "connector_subscriber" {
  subscription = google_pubsub_subscription.audit.id
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.connector.email}"
}
resource "google_service_account_key" "connector" {
  service_account_id = google_service_account.connector.name
}

# ── Outputs — used to configure the forwarder + the DAM connector ───────────────────────
output "audit_topic" {
  value = google_pubsub_topic.audit.id
}
output "audit_subscription" {
  description = "Configure this in the DAM console → connectors (with the connector key below)."
  value       = google_pubsub_subscription.audit.id
}
output "forwarder_sa_key" {
  description = "base64 SA key for the AgentLite forwarder (publish). Decode → GOOGLE_APPLICATION_CREDENTIALS."
  value       = google_service_account_key.forwarder.private_key
  sensitive   = true
}
output "connector_sa_key" {
  description = "base64 SA key for the DAM control-plane connector (subscribe)."
  value       = google_service_account_key.connector.private_key
  sensitive   = true
}
