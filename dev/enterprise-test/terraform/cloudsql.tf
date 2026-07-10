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

# ── Bastion / jump host in the Cloud SQL VPC so you can reach the PRIVATE-IP Cloud SQL
#    from your Mac (IAP SSH → this box → Cloud SQL private IP). No public IP, no SSH keys
#    (OS Login + IAP). Has the mysql client for quick local tests too. ──
resource "google_compute_instance" "paas_bastion" {
  name         = "${var.cloudsql.name}-bastion"
  machine_type = "e2-micro"
  zone         = var.zone
  labels       = var.labels

  boot_disk {
    initialize_params {
      image = var.vm_image
      size  = 15
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.paas.id
    # No access_config → no public IP.
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/templates/bastion-startup.sh.tftpl", {
    cloudsql_host  = google_sql_database_instance.paas.private_ip_address
    admin_user     = google_sql_user.root.name
    admin_password = random_password.paas_root.result
    seed_b64       = fileexists("${path.module}/seed/${var.cloudsql.db_name}.sql") ? base64encode(file("${path.module}/seed/${var.cloudsql.db_name}.sql")) : ""
  })

  shielded_instance_config {
    enable_secure_boot = true
  }

  depends_on = [google_compute_router_nat.paas, google_sql_database.paas, google_sql_user.root]
}

# ── Option 1: inline-proxy agent VM (capture + block). Apps connect to this VM:3307,
#    which forwards to Cloud SQL's private IP. Enabled by var.enable_paas_proxy. ──
resource "google_compute_instance" "paas_proxy" {
  count        = (var.enable_paas_proxy && var.deploy_agents) ? 1 : 0
  name         = "${var.cloudsql.name}-proxy"
  machine_type = "e2-small"
  zone         = var.zone
  labels       = var.labels
  tags         = ["mysql-proxy"] # 3307 firewall targets this tag

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
