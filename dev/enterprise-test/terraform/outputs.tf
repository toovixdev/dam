output "vm_databases" {
  description = "MySQL-on-VM instances (private IPs)."
  value = {
    for k, v in google_compute_instance.vm_db : k => {
      private_ip = v.network_interface[0].network_ip
      vpc        = google_compute_network.vm[k].name
      subnet     = google_compute_subnetwork.vm[k].ip_cidr_range
      zone       = v.zone
    }
  }
}

output "cloudsql" {
  description = "Cloud SQL (PaaS) MySQL instance."
  value = {
    name       = google_sql_database_instance.paas.name
    private_ip = google_sql_database_instance.paas.private_ip_address
    vpc        = google_compute_network.paas.name
    connect    = "apps connect via the proxy VM on :3307 (if enabled), else Cloud SQL private IP:3306"
  }
}

output "paas_proxy_ip" {
  description = "Inline-proxy agent VM private IP (if enabled) — point apps here on :3307."
  value       = var.enable_paas_proxy ? google_compute_instance.paas_proxy[0].network_interface[0].network_ip : null
}

output "nat_egress_note" {
  value = "Restrict your DAM API + ClickHouse ingress to each VPC's Cloud NAT egress IPs (see the Cloud NAT in the console) or use VPC peering."
}

output "ssh_hint" {
  value = "gcloud compute ssh <name> --tunnel-through-iap --zone ${var.zone}"
}

output "secrets" {
  description = "Secret Manager secret IDs holding the generated DB passwords."
  value       = [for s in google_secret_manager_secret.db : s.secret_id]
}
