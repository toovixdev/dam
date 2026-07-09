# ─────────────────────────────────────────────────────────────────────────────
# One isolated VPC + private subnet + Cloud NAT + firewall PER database.
# ─────────────────────────────────────────────────────────────────────────────

# ===== VM databases (one VPC each) =====
resource "google_compute_network" "vm" {
  for_each                = var.vm_databases
  name                    = "${each.key}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "vm" {
  for_each                 = var.vm_databases
  name                     = "${each.key}-subnet"
  ip_cidr_range            = each.value.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.vm[each.key].id
  private_ip_google_access = true
}

resource "google_compute_router" "vm" {
  for_each = var.vm_databases
  name     = "${each.key}-router"
  region   = var.region
  network  = google_compute_network.vm[each.key].id
}

resource "google_compute_router_nat" "vm" {
  for_each                           = var.vm_databases
  name                               = "${each.key}-nat"
  router                             = google_compute_router.vm[each.key].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# IAP SSH (admin), intra-VPC MySQL, and agent egress is allowed by default (egress open).
resource "google_compute_firewall" "vm_iap_ssh" {
  for_each      = var.vm_databases
  name          = "${each.key}-allow-iap-ssh"
  network       = google_compute_network.vm[each.key].id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"] # Google IAP range
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_firewall" "vm_mysql_internal" {
  for_each      = var.vm_databases
  name          = "${each.key}-allow-mysql-internal"
  network       = google_compute_network.vm[each.key].id
  direction     = "INGRESS"
  source_ranges = [each.value.subnet_cidr]
  allow {
    protocol = "tcp"
    ports    = ["3306"]
  }
}

# ===== Cloud SQL (PaaS) VPC =====
resource "google_compute_network" "paas" {
  name                    = "${var.cloudsql.name}-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "paas" {
  name                     = "${var.cloudsql.name}-subnet"
  ip_cidr_range            = var.cloudsql.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.paas.id
  private_ip_google_access = true
}

resource "google_compute_router" "paas" {
  name    = "${var.cloudsql.name}-router"
  region  = var.region
  network = google_compute_network.paas.id
}

resource "google_compute_router_nat" "paas" {
  name                               = "${var.cloudsql.name}-nat"
  router                             = google_compute_router.paas.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

resource "google_compute_firewall" "paas_iap_ssh" {
  name          = "${var.cloudsql.name}-allow-iap-ssh"
  network       = google_compute_network.paas.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Allow the app/proxy → Cloud SQL and → the inline-proxy listener, inside the VPC.
resource "google_compute_firewall" "paas_mysql_internal" {
  name          = "${var.cloudsql.name}-allow-mysql-internal"
  network       = google_compute_network.paas.id
  direction     = "INGRESS"
  source_ranges = [var.cloudsql.subnet_cidr]
  allow {
    protocol = "tcp"
    ports    = ["3306", "3307"] # 3306 Cloud SQL, 3307 inline-proxy listener
  }
}

# ── Private Service Access: reserve a range + peer to the Google services network so
#    Cloud SQL gets a PRIVATE IP inside the PaaS VPC (no public IP). ──
resource "google_compute_global_address" "psa" {
  name          = "${var.cloudsql.name}-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 24
  address       = cidrhost(var.cloudsql.psa_cidr, 0)
  network       = google_compute_network.paas.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.paas.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}
