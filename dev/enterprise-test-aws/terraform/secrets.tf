# DB passwords in Secrets Manager. recovery_window_in_days = 0 so destroy is immediate
# (avoids "scheduled for deletion" conflicts on re-apply during testing).
resource "aws_secretsmanager_secret" "vm_root" {
  for_each                = var.vm_databases
  name                    = "toovix-${each.key}-root"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "vm_root" {
  for_each      = var.vm_databases
  secret_id     = aws_secretsmanager_secret.vm_root[each.key].id
  secret_string = random_password.vm_root[each.key].result
}

resource "aws_secretsmanager_secret" "rds_admin" {
  name                    = "toovix-${var.rds.name}-admin"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "rds_admin" {
  secret_id     = aws_secretsmanager_secret.rds_admin.id
  secret_string = random_password.rds_admin.result
}
