# Dedicated service account for the DB VMs (least privilege — only logging/monitoring).
resource "google_service_account" "db_vm" {
  account_id   = "${var.name_prefix}-vm-sa"
  display_name = "Service account for ${var.name_prefix} database VMs"
}

# ---------------------------------------------------------------------------
# MySQL VM (Ubuntu 22.04 LTS)
# ---------------------------------------------------------------------------
resource "google_compute_instance" "mysql" {
  name         = "${var.name_prefix}-mysql"
  machine_type = var.mysql_machine_type
  zone         = var.zone
  tags         = ["${var.name_prefix}-db", "${var.name_prefix}-mysql"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = var.mysql_disk_size_gb
      type  = "pd-balanced"
    }
  }

  # No external IP — private subnet only. Egress goes through Cloud NAT.
  network_interface {
    subnetwork = google_compute_subnetwork.private.id
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = file("${path.module}/scripts/mysql-startup.sh")

  service_account {
    email  = google_service_account.db_vm.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
}

# ---------------------------------------------------------------------------
# Oracle VM (Oracle Linux 8 — Oracle Database 21c Express Edition)
# ---------------------------------------------------------------------------
resource "google_compute_instance" "oracle" {
  name         = "${var.name_prefix}-oracle"
  machine_type = var.oracle_machine_type
  zone         = var.zone
  tags         = ["${var.name_prefix}-db", "${var.name_prefix}-oracle"]

  boot_disk {
    initialize_params {
      image = "oracle-linux-cloud/oracle-linux-8"
      size  = var.oracle_disk_size_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.private.id
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = file("${path.module}/scripts/oracle-startup.sh")

  service_account {
    email  = google_service_account.db_vm.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
}
