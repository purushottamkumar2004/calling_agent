output "kms_key_arn" {
  value = aws_kms_key.data.arn
}

output "postgres_address" {
  value = aws_db_instance.this.address
}

output "postgres_port" {
  value = aws_db_instance.this.port
}

output "postgres_owner_secret_arn" {
  description = "Schema owner secret (keys: url, username, password, ...). Migration task only."
  value       = aws_secretsmanager_secret.db_owner.arn
}

output "postgres_app_secret_arn" {
  description = "Core API runtime login (RLS-bound)."
  value       = aws_secretsmanager_secret.db_app.arn
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "redis_secret_arn" {
  value = aws_secretsmanager_secret.redis.arn
}

output "recordings_bucket" {
  value = aws_s3_bucket.recordings.bucket
}

output "recordings_bucket_arn" {
  value = aws_s3_bucket.recordings.arn
}

output "recordings_expiration_days" {
  value = var.recordings_expiration_days
}
