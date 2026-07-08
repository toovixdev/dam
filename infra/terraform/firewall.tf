# SSH — restricted to the IAP range by default (see ssh_source_ranges).
resource "google_compute_firewall" "allow_ssh" {
  name    = "${var.name_prefix}-allow-ssh"
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = var.ssh_source_ranges
  target_tags   = ["${var.name_prefix}-db"]
}

# Internal traffic between resources inside the subnet.
resource "google_compute_firewall" "allow_internal" {
  name    = "${var.name_prefix}-allow-internal"
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = ["0-65535"]
  }
  allow {
    protocol = "udp"
    ports    = ["0-65535"]
  }
  allow {
    protocol = "icmp"
  }

  source_ranges = [var.subnet_cidr]
}

# MySQL (3306) — reachable only from db_client_source_ranges.
resource "google_compute_firewall" "allow_mysql" {
  name    = "${var.name_prefix}-allow-mysql"
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = ["3306"]
  }

  source_ranges = var.db_client_source_ranges
  target_tags   = ["${var.name_prefix}-mysql"]
}

# Oracle listener (1521) — reachable only from db_client_source_ranges.
resource "google_compute_firewall" "allow_oracle" {
  name    = "${var.name_prefix}-allow-oracle"
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
    ports    = ["1521"]
  }

  source_ranges = var.db_client_source_ranges
  target_tags   = ["${var.name_prefix}-oracle"]
}
