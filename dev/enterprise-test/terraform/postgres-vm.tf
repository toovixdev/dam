# ─────────────────────────────────────────────────────────────────────────────
# PostgreSQL-on-VM database — added to the shared VPC alongside the MySQL VMs.
# Private IP only (no public IP); egress via the shared Cloud NAT. Isolated by its
# own subnet + a tag-scoped 5432 firewall (postgres-db), same model as the MySQL VMs.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_compute_subnetwork" "pg_vm" {
  name                     = "${var.pg_vm.name}-subnet"
  ip_cidr_range            = var.pg_vm.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.main.id
  private_ip_google_access = true
}

# 5432 only from the app tier to the Postgres VM (both tags scoped to this VPC).
resource "google_compute_firewall" "postgres_internal" {
  name        = "toovix-test-allow-postgres-internal"
  network     = google_compute_network.main.id
  direction   = "INGRESS"
  source_tags = ["app-tier"]
  target_tags = ["postgres-db"]
  allow {
    protocol = "tcp"
    ports    = ["5432"]
  }
}

# ── Generated credentials (Secret Manager), mirroring the MySQL VM secret naming. ──
resource "random_password" "pg_vm_root" {
  length  = 20
  special = false
}

resource "random_password" "pg_vm_dam_svc" {
  length  = 20
  special = false
}

resource "google_secret_manager_secret" "pg_vm" {
  for_each  = toset(["root", "dam-svc"])
  secret_id = "toovix-${var.pg_vm.name}-${each.value}"
  labels    = var.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "pg_vm" {
  for_each    = toset(["root", "dam-svc"])
  secret      = google_secret_manager_secret.pg_vm[each.value].id
  secret_data = each.value == "root" ? random_password.pg_vm_root.result : random_password.pg_vm_dam_svc.result
}

resource "google_compute_instance" "pg_vm" {
  name         = var.pg_vm.name
  machine_type = var.pg_vm.machine_type
  zone         = var.zone
  labels       = var.labels
  tags         = ["postgres-db"] # 5432 firewall targets this tag

  boot_disk {
    initialize_params {
      image = var.vm_image
      size  = 20
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.pg_vm.id
    # No access_config → no public IP.
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/templates/postgres-vm-startup.sh.tftpl", {
    deploy_agents       = var.deploy_agents
    db_name             = var.pg_vm.db_name
    subnet_cidr         = var.pg_vm.subnet_cidr
    seed_b64            = fileexists("${path.module}/seed/${var.pg_vm.db_name}.sql") ? base64encode(file("${path.module}/seed/${var.pg_vm.db_name}.sql")) : ""
    pg_root_password    = random_password.pg_vm_root.result
    dam_svc_password    = random_password.pg_vm_dam_svc.result
    agent_image         = var.agent_image
    control_plane_url   = var.dam_control_plane_url
    clickhouse_url      = var.dam_clickhouse_url
    clickhouse_user     = var.dam_clickhouse_user
    clickhouse_password = var.dam_clickhouse_password
    enroll_token        = var.agent_enroll_token
    capture_iface       = var.capture_iface
  })

  shielded_instance_config {
    enable_secure_boot = true
  }

  # Attach the default compute SA so an on-VM agent can auth to Google APIs (Pub/Sub) via the
  # metadata server / ADC. Changing the SA requires the instance stopped.
  service_account {
    email  = data.google_compute_default_service_account.default.email
    scopes = ["cloud-platform"]
  }
  allow_stopping_for_update = true

  depends_on = [google_compute_router_nat.main]
}

output "pg_vm" {
  description = "PostgreSQL-on-VM instance (private IP)."
  value = {
    name       = google_compute_instance.pg_vm.name
    private_ip = google_compute_instance.pg_vm.network_interface[0].network_ip
    vpc        = google_compute_network.main.name
    subnet     = google_compute_subnetwork.pg_vm.ip_cidr_range
    db_name    = var.pg_vm.db_name
    secrets    = [for s in google_secret_manager_secret.pg_vm : s.secret_id]
  }
}
