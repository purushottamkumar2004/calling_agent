resource "aws_security_group" "postgres" {
  name        = "${var.name}-postgres"
  description = "RDS Postgres: only from ECS workloads"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-postgres" }
}

resource "aws_vpc_security_group_ingress_rule" "postgres_from_app" {
  security_group_id            = aws_security_group.postgres.id
  description                  = "Postgres from ECS workloads"
  referenced_security_group_id = var.app_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-postgres"
  subnet_ids = var.data_subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-postgres16"
  family = "postgres16"

  # TLS required for every connection: DATABASE_URL needs sslmode=require (or verify-full).
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  # Slow queries show up in logs; tool endpoints target p95 < 300 ms (contracts README).
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name}-postgres"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  db_name  = var.db_name
  username = var.db_owner_username
  # Password generated and rotated by RDS in Secrets Manager; never in Terraform state.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.data.arn

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data.arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.postgres.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false
  multi_az               = var.db_multi_az
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period = var.db_backup_retention_days
  backup_window           = "20:00-21:00"         # 01:30-02:30 IST
  maintenance_window      = "sun:21:30-sun:22:30" # Mon 03:00-04:00 IST
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade      = true
  enabled_cloudwatch_logs_exports = ["postgresql"]

  deletion_protection       = var.db_deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-postgres-final"
  apply_immediately         = var.apply_immediately
}

# Credentials for the running Core API's login role (member of api_app, subject to RLS).
# Terraform only generates and stores them; the role itself is created inside Postgres by a
# one-off task (RDS is private and unreachable from Terraform runners).
resource "random_password" "db_app" {
  length  = 40
  special = false # safe inside connection URLs without escaping
}

resource "aws_secretsmanager_secret" "db_app" {
  name                    = "${var.name}/postgres/app-login"
  description             = "Core API runtime login role (RLS-bound, not the owner)"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "db_app" {
  secret_id = aws_secretsmanager_secret.db_app.id
  secret_string = jsonencode({
    username = var.db_app_username
    password = random_password.db_app.result
    host     = aws_db_instance.this.address
    port     = aws_db_instance.this.port
    dbname   = var.db_name
    url      = "postgresql://${var.db_app_username}:${random_password.db_app.result}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${var.db_name}?sslmode=require"
  })
}
