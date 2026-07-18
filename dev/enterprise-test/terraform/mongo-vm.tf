# ─────────────────────────────────────────────────────────────────────────────
# MongoDB-on-VM database — added to the shared VPC alongside the MySQL/Postgres VMs.
# Private IP only (no public IP); egress via the shared Cloud NAT. Isolated by its
# own subnet + a tag-scoped 27017 firewall (mongo-db), same model as the other DB VMs.
# ─────────────────────────────────────────────────────────────────────────────

resource "google_compute_subnetwork" "mongo_vm" {
  name                     = "${var.mongo_vm.name}-subnet"
  ip_cidr_range            = var.mongo_vm.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.main.id
  private_ip_google_access = true
}

# 27017 only from the app tier to the Mongo VM (both tags scoped to this VPC).
resource "google_compute_firewall" "mongo_internal" {
  name        = "toovix-test-allow-mongo-internal"
  network     = google_compute_network.main.id
  direction   = "INGRESS"
  source_tags = ["app-tier"]
  target_tags = ["mongo-db"]
  allow {
    protocol = "tcp"
    ports    = ["27017"]
  }
}

# ── Generated credentials (Secret Manager), mirroring the other DB VM secret naming. ──
resource "random_password" "mongo_vm_root" {
  length  = 20
  special = false
}

resource "random_password" "mongo_vm_app" {
  length  = 20
  special = false
}

resource "random_password" "mongo_vm_dam_svc" {
  length  = 20
  special = false
}

# One secret per account. `app` gets its own password — it must never share root's.
locals {
  mongo_vm_passwords = {
    "root"    = random_password.mongo_vm_root.result
    "app"     = random_password.mongo_vm_app.result
    "dam-svc" = random_password.mongo_vm_dam_svc.result
  }
}

resource "google_secret_manager_secret" "mongo_vm" {
  for_each  = local.mongo_vm_passwords
  secret_id = "toovix-${var.mongo_vm.name}-${each.key}"
  labels    = var.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "mongo_vm" {
  for_each    = local.mongo_vm_passwords
  secret      = google_secret_manager_secret.mongo_vm[each.key].id
  secret_data = each.value
}

resource "google_compute_instance" "mongo_vm" {
  name         = var.mongo_vm.name
  machine_type = var.mongo_vm.machine_type
  zone         = var.zone
  labels       = var.labels
  tags         = ["mongo-db"] # 27017 firewall targets this tag

  boot_disk {
    initialize_params {
      image = var.vm_image
      size  = 20
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.mongo_vm.id
    # No access_config → no public IP.
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/templates/mongo-vm-startup.sh.tftpl", {
    deploy_agents       = var.deploy_agents
    db_name             = var.mongo_vm.db_name
    mongo_host          = cidrhost(var.mongo_vm.subnet_cidr, 2) # .2 — the address GCP assigns this VM
    mongo_version       = var.mongo_vm.mongo_version
    seed_b64            = fileexists("${path.module}/seed/${var.mongo_vm.db_name}.js") ? base64encode(file("${path.module}/seed/${var.mongo_vm.db_name}.js")) : ""
    mongo_root_password = random_password.mongo_vm_root.result
    app_password        = random_password.mongo_vm_app.result
    dam_svc_password    = random_password.mongo_vm_dam_svc.result
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

  # Attach the default compute SA so an on-VM agent can auth to Google APIs (Pub/Sub) via the
  # metadata server / ADC. Changing the SA requires the instance stopped.
  service_account {
    email  = data.google_compute_default_service_account.default.email
    scopes = ["cloud-platform"]
  }
  allow_stopping_for_update = true

  # metadata_startup_script forces replacement in the google provider, so editing the template
  # would DESTROY this VM — and the database on it — on the next apply. The script only ever
  # runs at first boot, so drift on it is meaningless to a running instance. Changes here reach
  # an existing VM only by recreating it deliberately or re-running the steps by hand.
  lifecycle {
    ignore_changes = [metadata_startup_script]
  }

  depends_on = [google_compute_router_nat.main]
}

output "mongo_vm" {
  description = "MongoDB-on-VM instance (private IP)."
  value = {
    name       = google_compute_instance.mongo_vm.name
    private_ip = google_compute_instance.mongo_vm.network_interface[0].network_ip
    vpc        = google_compute_network.main.name
    subnet     = google_compute_subnetwork.mongo_vm.ip_cidr_range
    db_name    = var.mongo_vm.db_name
    secrets    = [for s in google_secret_manager_secret.mongo_vm : s.secret_id]
  }
}
