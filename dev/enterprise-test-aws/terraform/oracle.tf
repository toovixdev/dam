# ─────────────────────────────────────────────────────────────────────────────
# Amazon RDS for Oracle SE2 (PaaS), PRIVATE — the Oracle test target for DAM.
#
# Licensing: SE2 with license-included, so no Oracle contract is needed (AWS bills the
# licence). SE2 is materially pricier than the MySQL/PG instances in this estate — roughly
# an order of magnitude — so treat this as a destroy-between-sessions resource, not a
# permanently-on one.
#
# Capture path: Oracle Unified Auditing writes to UNIFIED_AUDIT_TRAIL inside the database.
# RDS can export the `audit` log to CloudWatch Logs (confirmed in ExportableLogTypes for
# SE2), which is the agentless route: CloudWatch → subscription filter → Kinesis → DAM.
# Database Activity Streams is the nicer transport but is edition-gated on RDS Oracle;
# the CloudWatch path works on SE2 and is what this provisions.
#
# NOTE: db.t3.medium is NOT orderable for oracle-se2 license-included — db.t3.large is the
# smallest burstable class available (verified against describe-orderable-db-instance-options).
# ─────────────────────────────────────────────────────────────────────────────

resource "random_password" "oracle_admin" {
  length  = 24
  special = false # Oracle rejects several punctuation chars in passwords; keep it alphanumeric
}

resource "aws_secretsmanager_secret" "oracle_admin" {
  name                    = "toovix-${var.oracle.name}-admin"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "oracle_admin" {
  secret_id     = aws_secretsmanager_secret.oracle_admin.id
  secret_string = random_password.oracle_admin.result
}

# 1521 (TNS) from the seeder/app tier only — same posture as the MySQL SG.
resource "aws_security_group" "oracle" {
  name        = "${var.oracle.name}-oracle-sg"
  description = "RDS Oracle - 1521 from seeder only"
  vpc_id      = aws_vpc.main.id
  ingress {
    description     = "Oracle TNS from the seeder/app SG only"
    from_port       = 1521
    to_port         = 1521
    protocol        = "tcp"
    security_groups = [aws_security_group.seeder.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "sg-${var.oracle.name}-oracle" }
}

# Unified Auditing is enabled via a parameter group. On RDS the switch is the static
# `audit_trail` parameter; AUDIT_TRAIL=DB routes records to the in-database audit trail,
# which the `audit` CloudWatch export then ships out.
resource "aws_db_parameter_group" "oracle" {
  name        = "${var.oracle.name}-params"
  family      = var.oracle.parameter_group_family
  description = "TooVix DAM - Oracle unified auditing on"

  parameter {
    name         = "audit_trail"
    value        = "DB,EXTENDED" # EXTENDED also records the SQL text, which DAM needs
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "oracle" {
  identifier     = var.oracle.name
  engine         = "oracle-se2"
  engine_version = var.oracle.engine_version
  license_model  = "license-included"
  instance_class = var.oracle.instance_class

  allocated_storage = var.oracle.allocated_storage
  storage_encrypted = true

  # Oracle uses a single SID/service rather than a createable database name; the app schema
  # is created by the seeder after the instance is up.
  db_name  = var.oracle.sid
  username = "dbadmin"
  password = random_password.oracle_admin.result

  db_subnet_group_name   = aws_db_subnet_group.rds.name
  vpc_security_group_ids = [aws_security_group.oracle.id]
  parameter_group_name   = aws_db_parameter_group.oracle.name
  publicly_accessible    = false

  # Ship the audit trail to CloudWatch Logs — this is the tap the agentless path reads.
  enabled_cloudwatch_logs_exports = ["audit", "alert", "listener"]

  skip_final_snapshot = true
  deletion_protection = false
  apply_immediately   = true

  tags = { Name = var.oracle.name }
}

output "oracle" {
  description = "RDS Oracle SE2 instance (private endpoint)."
  value = {
    identifier   = aws_db_instance.oracle.identifier
    endpoint     = aws_db_instance.oracle.address
    port         = aws_db_instance.oracle.port
    sid          = var.oracle.sid
    username     = "dbadmin"
    secret       = aws_secretsmanager_secret.oracle_admin.name
    cw_log_group = "/aws/rds/instance/${var.oracle.name}/audit"
  }
}
