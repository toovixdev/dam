output "vpc_name" {
  description = "Name of the created VPC."
  value       = google_compute_network.vpc.name
}

output "subnet_name" {
  description = "Name of the private subnet."
  value       = google_compute_subnetwork.private.name
}

output "mysql_internal_ip" {
  description = "Private IP of the MySQL VM."
  value       = google_compute_instance.mysql.network_interface[0].network_ip
}

output "oracle_internal_ip" {
  description = "Private IP of the Oracle VM."
  value       = google_compute_instance.oracle.network_interface[0].network_ip
}

output "ssh_mysql" {
  description = "Command to SSH into the MySQL VM via IAP (no public IP needed)."
  value       = "gcloud compute ssh ${google_compute_instance.mysql.name} --zone ${var.zone} --tunnel-through-iap"
}

output "ssh_oracle" {
  description = "Command to SSH into the Oracle VM via IAP (no public IP needed)."
  value       = "gcloud compute ssh ${google_compute_instance.oracle.name} --zone ${var.zone} --tunnel-through-iap"
}
