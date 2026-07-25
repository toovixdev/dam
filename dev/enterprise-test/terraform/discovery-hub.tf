# ─────────────────────────────────────────────────────────────────────────────
# Discovery HUB VPC + a database-discovery scanner VM.
#
# Models the production pattern: a dedicated hub VPC, VPC-peered to the network(s)
# that hold the databases, running a scanner that sweeps the spoke CIDRs. Here the
# databases all live in the single shared VPC (toovix-test-vpc), so ONE peering
# reaches every DB-VM subnet. The scanner fingerprints engines by protocol
# handshake, so DBs on non-default ports are still found.
#
# Reachability notes:
#   • VPC peering exchanges SUBNET routes, so the hub reaches the DB-VM subnets
#     (10.10 / 10.20 / 10.40 / 10.50) directly.
#   • Cloud SQL's private IP sits behind a SEPARATE servicenetworking peering on
#     the main VPC. Peering is NON-transitive, so the hub can NOT reach it by
#     network scan — managed/PaaS databases are found via cloud-API discovery
#     (the Cloud connectors on the Discovery page), which needs no network path.
# ─────────────────────────────────────────────────────────────────────────────

locals {
  # Sweep every DB-VM subnet CIDR. Kept in sync with the actual subnets so adding
  # a DB VM automatically widens discovery. (Cloud SQL PSA range omitted on purpose
  # — unreachable via peering; use cloud-API discovery for PaaS.)
  discovery_targets = join(",", concat(
    [for k, v in var.vm_databases : v.subnet_cidr],
    [var.pg_vm.subnet_cidr, var.mongo_vm.subnet_cidr],
  ))
}

resource "google_compute_network" "hub" {
  name                    = var.discovery_hub.vpc_name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "hub" {
  name                     = "${var.discovery_hub.name}-subnet"
  ip_cidr_range            = var.discovery_hub.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.hub.id
  private_ip_google_access = true
}

# ── VPC peering: hub ⇄ main. Both directions are required for a live peering. ──
resource "google_compute_network_peering" "hub_to_main" {
  name         = "discovery-hub-to-main"
  network      = google_compute_network.hub.id
  peer_network = google_compute_network.main.id
}

resource "google_compute_network_peering" "main_to_hub" {
  name         = "main-to-discovery-hub"
  network      = google_compute_network.main.id
  peer_network = google_compute_network.hub.id
}

# ── Egress for the private scanner VM (no public IP) → reach the control plane. ──
resource "google_compute_router" "hub" {
  name    = "discovery-hub-router"
  region  = var.region
  network = google_compute_network.hub.id
}

resource "google_compute_router_nat" "hub" {
  name                               = "discovery-hub-nat"
  router                             = google_compute_router.hub.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# ── SSH to the scanner via IAP. ──
resource "google_compute_firewall" "hub_iap_ssh" {
  name          = "discovery-hub-allow-iap-ssh"
  network       = google_compute_network.hub.id
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"] # Google IAP range
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# ── Let the scanner reach DB ports on the main VPC. Cross-VPC (peered) traffic
#    can NOT be matched by network tags — tags are per-VPC — so this is scoped by
#    the hub subnet's SOURCE RANGE instead. DB ports only (not all ports). ──
resource "google_compute_firewall" "main_allow_discovery" {
  name          = "toovix-test-allow-discovery-scan"
  network       = google_compute_network.main.id
  direction     = "INGRESS"
  source_ranges = [var.discovery_hub.subnet_cidr]
  allow {
    protocol = "tcp"
    ports    = ["1433", "1521", "3306", "3307", "5432", "5433", "6432", "27017", "27018", "27019"]
  }
}

resource "google_compute_instance" "discovery" {
  name         = var.discovery_hub.name
  machine_type = var.discovery_hub.machine_type
  zone         = var.zone
  labels       = var.labels
  tags         = ["discovery-hub"]

  boot_disk {
    initialize_params {
      image = var.vm_image
      size  = 20
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.hub.id
    # No access_config → no public IP; egress via the hub Cloud NAT.
  }

  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/templates/discovery-vm-startup.sh.tftpl", {
    control_plane_url = var.dam_control_plane_url
    enroll_token      = var.agent_enroll_token
    targets           = local.discovery_targets
    preset            = var.discovery_hub.preset
    interval          = var.discovery_hub.interval_ms
    max_hosts         = var.discovery_hub.max_hosts
    portsets_b64      = base64encode(file("${path.module}/../../dam/discovery/portsets.js"))
    targets_b64       = base64encode(file("${path.module}/../../dam/discovery/targets.js"))
    scanner_b64       = base64encode(file("${path.module}/../../dam/discovery/scanner.js"))
    agent_b64         = base64encode(file("${path.module}/../../dam/discovery/agent.js"))
  })

  shielded_instance_config {
    enable_secure_boot = true
  }

  # Default compute SA (keyless ADC) — harmless for discovery, and lets a future
  # cloud-API enumerator on this VM auth to Google APIs. Changing SA needs the VM stopped.
  service_account {
    email  = data.google_compute_default_service_account.default.email
    scopes = ["cloud-platform"]
  }
  allow_stopping_for_update = true

  # metadata_startup_script forces replacement in the google provider, so editing the
  # template would DESTROY this VM on the next apply. The script only runs at first boot,
  # so drift on it is meaningless to a running instance — ignore it here.
  lifecycle {
    ignore_changes = [metadata_startup_script]
  }

  depends_on = [google_compute_router_nat.hub, google_compute_network_peering.hub_to_main]
}

output "discovery_hub" {
  description = "Discovery hub VPC + scanner VM."
  value = {
    vpc        = google_compute_network.hub.name
    subnet     = google_compute_subnetwork.hub.ip_cidr_range
    vm         = google_compute_instance.discovery.name
    private_ip = google_compute_instance.discovery.network_interface[0].network_ip
    scans      = local.discovery_targets
    reports_to = var.dam_control_plane_url != "" ? var.dam_control_plane_url : "(dam_control_plane_url unset — scanner runs but can't report candidates)"
  }
}
