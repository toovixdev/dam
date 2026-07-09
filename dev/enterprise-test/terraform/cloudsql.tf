# ── Cloud SQL for MySQL (PaaS), PRIVATE IP only, inside its own VPC ──
resource "google_sql_database_instance" "paas" {
  name                = var.cloudsql.name
  region              = var.region
  database_version    = var.cloudsql.db_version
  deletion_protection = false

  depends_on = [google_service_networking_connection.psa]

  settings {
    tier              = var.cloudsql.tier
    availability_type = "ZONAL"

    ip_configuration {
      ipv4_enabled    = false # no public IP
      private_network = google_compute_network.paas.id
    }

    # Audit-log option (agentless Cloud Push). Uncomment + wire a Log sink → Pub/Sub → collector.
    # database_flags { name = "cloudsql_mysql_audit" value = "on" }

    backup_configuration {
      enabled = false
    }
  }
}

resource "google_sql_database" "paas" {
  name     = var.cloudsql.db_name
  instance = google_sql_database_instance.paas.name
}

# Admin user (kept out of the platform path) + least-privilege service user for TooVix.
resource "google_sql_user" "root" {
  name     = "admin"
  instance = google_sql_database_instance.paas.name
  host     = "%"
  password = random_password.paas_root.result
}

resource "google_sql_user" "dam_svc" {
  name     = "dam_svc"
  instance = google_sql_database_instance.paas.name
  host     = "%"
  password = random_password.paas_dam_svc.result
}

# ── Option 1: inline-proxy agent VM (capture + block). Apps connect to this VM:3307,
#    which forwards to Cloud SQL's private IP. Enabled by var.enable_paas_proxy. ──
resource "google_compute_instance" "paas_proxy" {
  count        = var.enable_paas_proxy ? 1 : 0
  name         = "${var.cloudsql.name}-proxy"
  machine_type = "e2-small"
  zone         = var.zone
  labels       = var.labels

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 20
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.paas.id
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/templates/proxy-agent-startup.sh.tftpl", {
    upstream_host       = google_sql_database_instance.paas.private_ip_address
    target_db           = var.cloudsql.name
    registry_host       = split("/", var.agent_image)[0]
    agent_image         = var.agent_image
    control_plane_url   = var.dam_control_plane_url
    clickhouse_url      = var.dam_clickhouse_url
    clickhouse_user     = var.dam_clickhouse_user
    clickhouse_password = var.dam_clickhouse_password
    enroll_token        = var.agent_enroll_token
  })

  shielded_instance_config {
    enable_secure_boot = true
  }

  depends_on = [google_compute_router_nat.paas]
}
