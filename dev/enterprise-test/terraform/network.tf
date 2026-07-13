# ─────────────────────────────────────────────────────────────────────────────
# Single shared VPC + one Cloud Router + ONE Cloud NAT for ALL databases.
# (Cost-optimized vs one-VPC-per-DB. Each DB keeps its own subnet; isolation is by
#  subnet + tag-scoped firewall rules — the DBs still can't reach each other.)
# ─────────────────────────────────────────────────────────────────────────────
resource "google_compute_network" "main" {
  name                    = "toovix-test-vpc"
  auto_create_subnetworks = false
}

# ── Per-DB subnets (all in the shared VPC; CIDRs unchanged so the Cloud SQL private
#    IP stays in the 10.30.240.0/24 PSA range) ──
resource "google_compute_subnetwork" "vm" {
  for_each                 = var.vm_databases
  name                     = "${each.key}-subnet"
  ip_cidr_range            = each.value.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.main.id
  private_ip_google_access = true
}

resource "google_compute_subnetwork" "paas" {
  name                     = "${var.cloudsql.name}-subnet"
  ip_cidr_range            = var.cloudsql.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.main.id
  private_ip_google_access = true
}

# ── ONE Cloud Router + ONE Cloud NAT for the whole VPC/region (covers every subnet) ──
resource "google_compute_router" "main" {
  name    = "toovix-test-router"
  region  = var.region
  network = google_compute_network.main.id
}

resource "google_compute_router_nat" "main" {
  name                               = "toovix-test-nat"
  router                             = google_compute_router.main.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# ── Firewalls (single VPC; tag-scoped so DBs stay isolated from each other) ──
resource "google_compute_firewall" "iap_ssh" {
  name          = "toovix-test-allow-iap-ssh"
  network       = google_compute_network.main.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"] # Google IAP range
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# 3306 only from the app tier to DB VMs (both tags network-scoped to this VPC).
resource "google_compute_firewall" "mysql_internal" {
  name        = "toovix-test-allow-mysql-internal"
  network     = google_compute_network.main.id
  direction   = "INGRESS"
  source_tags = ["app-tier"]
  target_tags = ["mysql-db"]
  allow {
    protocol = "tcp"
    ports    = ["3306"]
  }
}

# 3307 to the inline-proxy listener (phase 2), app-tier only.
resource "google_compute_firewall" "proxy_internal" {
  name        = "toovix-test-allow-proxy-internal"
  network     = google_compute_network.main.id
  direction   = "INGRESS"
  source_tags = ["app-tier"]
  target_tags = ["mysql-proxy"]
  allow {
    protocol = "tcp"
    ports    = ["3307"]
  }
}

# ── Private Service Access: reserve a range + peer to Google services so Cloud SQL gets
#    a PRIVATE IP inside the shared VPC (no public IP). ──
resource "google_compute_global_address" "psa" {
  name          = "${var.cloudsql.name}-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 24
  address       = cidrhost(var.cloudsql.psa_cidr, 0)
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}
