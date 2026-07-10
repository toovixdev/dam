# MySQL-on-VM databases. Private IP only (no public IP); egress via Cloud NAT.
# Each VM runs MySQL 8 + the TooVix network agent (see the startup template).

resource "google_compute_instance" "vm_db" {
  for_each     = var.vm_databases
  name         = each.key
  machine_type = each.value.machine_type
  zone         = var.zone
  labels       = var.labels

  boot_disk {
    initialize_params {
      image = var.vm_image
      size  = 20
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.vm[each.key].id
    # No access_config → no public IP.
  }

  # OS Login for keyless, IAM-controlled SSH.
  metadata = {
    enable-oslogin = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/templates/mysql-vm-startup.sh.tftpl", {
    deploy_agents       = var.deploy_agents
    db_name             = each.value.db_name
    target_db           = each.key
    registry_host       = var.agent_image != "" ? split("/", var.agent_image)[0] : ""
    mysql_root_password = random_password.vm_root[each.key].result
    dam_svc_password    = random_password.vm_dam_svc[each.key].result
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

  depends_on = [google_compute_router_nat.vm]
}
