resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "ElastiCache Redis: only from ECS workloads"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-redis" }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_app" {
  security_group_id            = aws_security_group.redis.id
  description                  = "Redis from ECS workloads"
  referenced_security_group_id = var.app_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis"
  subnet_ids = var.data_subnet_ids
}

# Node-based (not Serverless) because BullMQ requires maxmemory-policy noeviction,
# which Serverless does not let us set. Same policy as local dev.
resource "aws_elasticache_parameter_group" "this" {
  name   = "${var.name}-redis7"
  family = "redis7"

  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "random_password" "redis_auth" {
  length  = 48
  special = false # AUTH tokens disallow some symbols; alphanumeric is always valid
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${var.name}-redis"
  description          = "${var.name} queues (BullMQ), event streams, call state"

  engine               = "redis"
  engine_version       = var.redis_engine_version
  node_type            = var.redis_node_type
  num_cache_clusters   = 1
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.this.name
  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.redis.id]

  automatic_failover_enabled = false
  multi_az_enabled           = false

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true # clients use rediss://
  auth_token                 = random_password.redis_auth.result

  snapshot_retention_limit   = 1
  snapshot_window            = "19:00-20:00"         # 00:30-01:30 IST
  maintenance_window         = "sun:22:30-sun:23:30" # Mon 04:00-05:00 IST
  auto_minor_version_upgrade = true
  apply_immediately          = var.apply_immediately
}

resource "aws_secretsmanager_secret" "redis" {
  name                    = "${var.name}/redis/auth"
  description             = "ElastiCache AUTH token and connection URL"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = var.secret_recovery_window_days
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    auth_token = random_password.redis_auth.result
    host       = aws_elasticache_replication_group.this.primary_endpoint_address
    port       = 6379
    url        = "rediss://:${random_password.redis_auth.result}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
  })
}
