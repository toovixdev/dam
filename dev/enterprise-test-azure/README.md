# TooVix DAM — Enterprise Cloud Test (Azure)

A minimal **SQL Server** test estate on Azure: one SQL Server on an **IaaS VM** and one
**PaaS** Azure SQL Database, both private (no public DB endpoints), reached through a
single Linux **jump-box**. Passwords are generated and stored in **Key Vault**.

| DB | Deployment | Where | Access |
|----|------------|-------|--------|
| `toovix-sqltest-sqlvm` | **SQL Server 2022 Developer** (free; full features incl. Audit) on a **Windows VM** | `snet-dbvm` (10.20.2.0/24), no public IP | via jump-box → `1433` |
| `appdb` | **Azure SQL Database (PaaS)** | Private Endpoint in `snet-pe` (10.20.3.0/24) | via jump-box → private FQDN `:1433` |

### Access model (Azure has no SSM/IAP)
One **jump-box** (public IP, NSG locked to *your* IP) sits in `snet-jumpbox`. From it you
reach the SQL VM (1433/RDP) and the Azure SQL private endpoint (1433). The SQL VM's NSG
allows 1433 **only from the jump-box subnet** and explicitly **denies** it from the rest of
the VNet.

```
  you ──SSH──► jump-box (public IP, NSG=your IP)
                 │
        ┌────────┴─────────┐
   snet-dbvm          snet-pe
  SQL Server VM   Azure SQL (Private Endpoint)
  (no public IP)   (public access disabled)
```

> ⚠️ **DAM capture caveat:** SQL Server uses the **TDS** protocol, which the DAM agent does
> **not** decode yet (it handles MySQL + PostgreSQL). You can register these instances, but
> network-mode **query capture won't work** until a TDS decoder is added. This estate is for
> standing up the DBs / testing connectivity now.

## Configure your Mac
```bash
brew install azure-cli
az login                                        # sign in to the NEW tenant
az account set --subscription "<SUBSCRIPTION_ID>"
ssh-keygen -t ed25519 -f ~/.ssh/azure_sqltest   # if you don't have a key
# register providers once per subscription:
for p in Microsoft.Compute Microsoft.Network Microsoft.KeyVault Microsoft.Sql; do az provider register --namespace $p; done
```

## Apply
```bash
cd dev/enterprise-test-azure/terraform
cp terraform.tfvars.example terraform.tfvars
# edit: subscription_id, admin_source_ip (curl -s ifconfig.me → append /32),
#        admin_ssh_public_key (paste ~/.ssh/azure_sqltest.pub)
terraform init
terraform plan
terraform apply
```

## Connect
```bash
terraform output how_to_connect      # prints exact commands + IPs + Key Vault secret lookups
```
- **SQL VM:** `ssh azureadmin@<jumpbox-ip>` → `sqlcmd -S <sqlvm-private-ip>,1433 -U sqladmin -P '<secret>' -C`
- **Azure SQL:** on the jump-box → `sqlcmd -S <server>.database.windows.net -d appdb -U sqladmin -P '<secret>' -C`
  (the FQDN resolves to the private endpoint from inside the VNet)

## Destroy
```bash
terraform destroy
```

## Notes
- **Cost:** 1 Windows SQL VM (D2s_v5) + 1 Linux jump-box (B2s) + 1 Azure SQL DB (Basic) +
  1 NAT Gateway + public IPs + Key Vault. The VM runs **SQL Server Developer edition (free)** —
  no SQL licence charge (only Windows VM compute + disk). ~$170/mo if left running 24/7
  (~$32 of that is the NAT Gateway, which bills continuously). Deallocate the VMs when idle
  and **destroy when done**.
- **Egress:** the private DB subnet (`snet-dbvm`) routes outbound through a **NAT Gateway**
  (egress-only, dedicated IP → `nat_egress_ip` output) — DBs stay private-IP-only inbound.
  The jump-box egresses via its own public IP.
- **SQL edition:** `sql_vm_image_sku` (default `sqldev-gen2` = Developer, free). Set it to
  `standard-gen2`/`enterprise-gen2` only to validate production licensing/billing. If `apply`
  ever errors on marketplace terms:
  `az vm image terms accept --urn MicrosoftSQLServer:sql2022-ws2022:<sku>:latest`
- **SQL auth on the VM** is enabled by the `azurerm_mssql_virtual_machine` (SQL IaaS
  extension), which creates the `sqladmin` login on TCP 1433 (private only).
- **State:** local. Add a `backend "azurerm"` block for shared/remote state.
- **Key Vault** uses the access-policy model (deployer gets secret access), so no RBAC role
  assignment is needed — switch to RBAC if your org standardizes on it.
