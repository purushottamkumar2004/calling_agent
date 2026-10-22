output "vpc_id" {
  value = module.network.vpc_id
}

output "app_subnet_ids" {
  value = module.network.app_subnet_ids
}

output "public_subnet_ids" {
  value = module.network.public_subnet_ids
}

output "app_security_group_id" {
  value = module.network.app_security_group_id
}

output "nat_public_ips" {
  value = module.network.nat_public_ips
}

output "postgres_address" {
  value = module.data.postgres_address
}

output "postgres_owner_secret_arn" {
  value = module.data.postgres_owner_secret_arn
}

output "postgres_app_secret_arn" {
  value = module.data.postgres_app_secret_arn
}

output "redis_primary_endpoint" {
  value = module.data.redis_primary_endpoint
}

output "redis_secret_arn" {
  value = module.data.redis_secret_arn
}

output "recordings_bucket" {
  value = module.data.recordings_bucket
}

output "kms_key_arn" {
  value = module.data.kms_key_arn
}

output "github_deploy_role_arn" {
  value = module.github_oidc.deploy_role_arn
}

output "ecr_repository_urls" {
  value = module.ecr.repository_urls
}

output "ecs_cluster_name" {
  value = module.cluster.cluster_name
}

output "zone_name_servers" {
  description = "Delegate var.zone_name to these at the parent DNS zone before the first apply completes."
  value       = module.edge.zone_name_servers
}

output "hostnames" {
  value = module.edge.fqdns
}

output "migrate_task_definition_family" {
  value = module.api_migrate.task_definition_family
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
