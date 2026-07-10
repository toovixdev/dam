# TooVix DAM — Enterprise Cloud Test (Azure)

The Azure mirror of `dev/enterprise-test` (GCP). Same shape: **3 MySQL databases, each in its
own VNet + private subnet, no public IPs**, seeded with the same PII/PCI data model.

| DB | Deployment | VNet (spoke) | Sensitive data |
|----|------------|--------------|----------------|
| `db-vm-a` | MySQL 8 on a **Linux VM** | `vnet-db-vm-a` (10.10.0.0/16) | orders — low |
| `db-vm-b` | MySQL 8 on a **Linux VM** | `vnet-db-vm-b` (10.20.0.0/16) | customers — **PII** (Aadhaar/PAN) |
| `db-paas` | **Azure DB for MySQL – Flexible Server** (PaaS) | `vnet-db-paas` (10.30.0.0/16), VNet-injected | billing — **PCI** (card_number/cvv) |

### Access model (Azure has no IAP)
A **hub VNet** holds a single **jump-box** (public IP, locked to *your* IP via NSG). The hub is
**peered** to each DB spoke, so the one jump-box reaches all three DBs — while the spokes are
**not** peered to each other (DBs stay isolated). Passwords are in **Key Vault**.

```
      you ──SSH──► jump-box (hub VNet, public IP, NSG=your IP)
                      │  (hub↔spoke peering)
        ┌─────────────┼──────────────┐
   vnet-db-vm-a   vnet-db-vm-b   vnet-db-paas
     MySQL VM       MySQL VM     Flexible Server (private)
   (no public IP) (no public IP)  (VNet-injected)
```

---

## Configure your Mac
```bash
brew install azure-cli
az login
az account set --subscription "<SUBSCRIPTION_ID>"     # az account show --query id -o tsv
ssh-keygen -t ed25519 -f ~/.ssh/azure_mysql            # if you don't have a key
```
Terraform (already installed) auto-downloads the `azurerm` provider on `init`.

## Apply
```bash
cd dev/enterprise-test-azure/terraform
cp terraform.tfvars.example terraform.tfvars
# edit: subscription_id, admin_ssh_public_key (paste ~/.ssh/azure_mysql.pub), admin_source_ip (curl -s ifconfig.me → append /32)
terraform init
terraform plan
terraform apply
```

## Connect
```bash
terraform output how_to_connect            # prints the exact commands + IPs
# password example:
az keyvault secret show --vault-name <kv-name> --name toovix-db-vm-b-root --query value -o tsv
```
- **VM DBs:** `ssh -i ~/.ssh/azure_mysql azureuser@<jumpbox-ip>` → `ssh azureuser@<vm-private-ip>` → `mysql -u root -p`
- **Flexible Server:** on the jump-box → `mysql -h <fqdn> -u dbadmin -p billing`

## Destroy
```bash
terraform destroy
```

## Notes
- **Cost:** 2 VM + 1 jump-box (B1ms), 1 Flexible Server (B1ms), 2 NAT gateways + 3 public IPs,
  Key Vault. Destroy when done.
- **3306 hardening:** the VM NSGs allow 3306 only **intra-subnet** (future app) and explicitly
  **deny** it from everything else (Azure's default rules would otherwise allow peered VNets).
  SSH is allowed only from the hub jump-box subnet.
- **Passwords in cloud-init:** for POC simplicity the DB passwords are templated into VM
  `custom_data` (also stored in Key Vault). Read from Key Vault at boot for production.
- **Phase 2 (agents):** placeholder `deploy_agents` flag; wiring the TooVix agent onto the VMs
  is a follow-up, same as the GCP side.
