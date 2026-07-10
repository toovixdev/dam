# TooVix DAM — Enterprise Cloud Test (AWS)

The AWS mirror of `dev/enterprise-test` (GCP) and `dev/enterprise-test-azure`. Same shape:
**3 MySQL databases, each in its own VPC + private subnet, no public IPs**, seeded with the
same PII/PCI data model.

| DB | Deployment | VPC | Sensitive data |
|----|------------|-----|----------------|
| `db-vm-a` | MySQL 8 on **EC2** | `vpc-db-vm-a` (10.10.0.0/16) | orders — low |
| `db-vm-b` | MySQL 8 on **EC2** | `vpc-db-vm-b` (10.20.0.0/16) | customers — **PII** (Aadhaar/PAN) |
| `db-paas` | **Amazon RDS for MySQL** (PaaS) | `vpc-db-paas` (10.30.0.0/16) | billing — **PCI** (card_number/cvv) |

### Access model — SSM Session Manager (the AWS equivalent of GCP's IAP)
**No bastion, no public IPs, no SSH keys.** EC2 instances carry an IAM instance profile
(`AmazonSSMManagedInstanceCore`); you connect with `aws ssm start-session`. RDS has no OS, so
it's reached through a small **SSM-enabled seeder EC2** in its VPC (which also loads the seed).

```
   you ──(aws ssm start-session, IAM)──► private EC2 (any VPC)
   db-vm-a / db-vm-b : MySQL on EC2 (private)
   db-paas          : RDS MySQL (private) ◄── seeder EC2 (SSM) seeds + hops to it
```

---

## Configure your Mac
```bash
brew install awscli
brew install --cask session-manager-plugin   # needed for `aws ssm start-session`
aws configure                                 # Access Key, Secret, region (e.g. ap-south-1)
aws sts get-caller-identity                    # verify
```
Terraform (already installed) auto-downloads the `aws` provider on `init`.

## Apply
```bash
cd dev/enterprise-test-aws/terraform
cp terraform.tfvars.example terraform.tfvars   # region etc. — defaults are fine
terraform init
terraform plan
terraform apply
```

## Connect (via SSM — no keys)
```bash
terraform output how_to_connect      # prints exact commands with real instance IDs / RDS endpoint

# A MySQL EC2:
aws ssm start-session --target <instance-id>
#   then on the box:  mysql -u root -p

# RDS billing (via the seeder EC2):
aws ssm start-session --target <seeder-id>
#   then:  mysql -h <rds-endpoint> -u dbadmin -p billing

# passwords:
aws secretsmanager get-secret-value --secret-id toovix-db-vm-b-root --query SecretString --output text
```
> Tip: for a local `mysql` client against RDS, use SSM port-forwarding through the seeder:
> `aws ssm start-session --target <seeder-id> --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=<rds-endpoint>,portNumber=3306,localPortNumber=3306`

## Destroy
```bash
terraform destroy
```

## Notes
- **Cost:** 3 EC2 (t3.small) + 1 RDS (db.t3.micro) + **3 NAT gateways** + 3 EIPs + Secrets Manager.
  NAT gateways are the main hourly cost — destroy when done.
- **3306 hardening:** EC2 SGs allow 3306 only from **within their own VPC** (future app); RDS
  accepts 3306 only from the **seeder security group**. No SSH inbound anywhere (SSM only).
- **Passwords in user_data:** templated into EC2 `user_data` for POC simplicity (also in Secrets
  Manager). Read from Secrets Manager at boot for production.
- **Phase 2 (agents):** `deploy_agents` placeholder; wiring the TooVix agent is a follow-up.
