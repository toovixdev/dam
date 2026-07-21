# ===================== Oracle on EC2 =====================
# Oracle Database 23ai FREE on a private EC2 box — the Oracle target for DAM.
#
# Why EC2 rather than RDS Oracle:
#   • RDS Oracle is blocked on this account's plan (FreeTierRestrictionError), and SE2
#     license-included runs ~$235/mo vs ~$33/mo here.
#   • 23ai Free needs NO Oracle licence (2 CPU / 2 GB RAM / 12 GB user data limits).
#   • Unified Auditing is a core feature in every edition, so UNIFIED_AUDIT_TRAIL has the
#     same shape it does on Enterprise — the collector exercises the real code path.
#
# Capture path: the DAM agent polls UNIFIED_AUDIT_TRAIL over SQL*Net, exactly as the SQL
# Server collector polls sys.fn_get_audit_file over TDS. Nothing is installed on this host;
# the collector only needs 1521 reachability and a login with AUDIT_VIEWER.

resource "aws_subnet" "oracle_vm_private" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.oracle_vm.private_subnet
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = { Name = "snet-${var.oracle_vm.name}-private" }
}

resource "aws_route_table_association" "oracle_vm_private" {
  subnet_id      = aws_subnet.oracle_vm_private.id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "oracle_vm" {
  name        = "${var.oracle_vm.name}-oracle-sg"
  description = "Oracle EC2 - 1521 (TNS) from own subnet only"
  vpc_id      = aws_vpc.main.id
  ingress {
    description = "Oracle TNS from own subnet only"
    from_port   = 1521
    to_port     = 1521
    protocol    = "tcp"
    cidr_blocks = [var.oracle_vm.private_subnet]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "sg-${var.oracle_vm.name}" }
}

# Oracle rejects some punctuation in passwords and dislikes a leading digit — keep these
# alphanumeric, and the init script quotes them where they are used in SQL.
resource "random_password" "oracle_vm_sys" {
  length  = 20
  special = false
}

resource "random_password" "oracle_vm_app" {
  length  = 20
  special = false
}

# The DAM collector's own least-privilege login: AUDIT_VIEWER + SELECT on the app schema
# (the latter only so classification can read ALL_TAB_COLUMNS for these tables).
resource "random_password" "oracle_vm_dam_svc" {
  length  = 20
  special = false
}

locals {
  oracle_vm_passwords = {
    "sys"     = random_password.oracle_vm_sys.result
    "app"     = random_password.oracle_vm_app.result
    "dam-svc" = random_password.oracle_vm_dam_svc.result
  }
}

resource "aws_secretsmanager_secret" "oracle_vm" {
  for_each                = local.oracle_vm_passwords
  name                    = "toovix-${var.oracle_vm.name}-${each.key}"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "oracle_vm" {
  for_each      = local.oracle_vm_passwords
  secret_id     = aws_secretsmanager_secret.oracle_vm[each.key].id
  secret_string = each.value
}

resource "aws_instance" "oracle_vm" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.oracle_vm.machine_type
  subnet_id                   = aws_subnet.oracle_vm_private.id
  vpc_security_group_ids      = [aws_security_group.oracle_vm.id]
  iam_instance_profile        = aws_iam_instance_profile.ssm.name
  associate_public_ip_address = false

  user_data = templatefile("${path.module}/templates/oracle-vm-init.sh.tftpl", {
    image           = var.oracle_vm.image
    pdb             = var.oracle_vm.pdb
    sys_password    = random_password.oracle_vm_sys.result
    app_user        = var.oracle_vm.app_user
    app_password    = random_password.oracle_vm_app.result
    damsvc_password = random_password.oracle_vm_dam_svc.result
  })

  root_block_device {
    # Oracle's image plus datafiles need considerably more room than the Postgres box.
    volume_size = var.oracle_vm.disk_gb
    encrypted   = true
  }

  # Pin to the deployed AMI; don't replace on a newer Ubuntu release.
  lifecycle {
    ignore_changes = [ami]
  }

  tags = { Name = var.oracle_vm.name }
}

output "oracle_vm" {
  description = "Oracle 23ai Free on EC2 (private)."
  value = {
    name       = var.oracle_vm.name
    private_ip = aws_instance.oracle_vm.private_ip
    port       = 1521
    service    = var.oracle_vm.pdb
    app_user   = var.oracle_vm.app_user
    dam_user   = "DAM_SVC"
    secrets    = [for s in aws_secretsmanager_secret.oracle_vm : s.name]
  }
}
