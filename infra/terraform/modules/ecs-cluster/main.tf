# ECS cluster plus the private DNS namespace `internal`, so services reach each other as
# <service>.internal (api.internal matches docs/contracts/internal-api.openapi.yaml).

variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "container_insights" {
  description = "CloudWatch Container Insights (extra cost; off in staging)."
  type        = bool
  default     = false
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name        = "internal"
  description = "Service-to-service names for ${var.name}"
  vpc         = var.vpc_id
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  value = aws_ecs_cluster.this.arn
}

output "namespace_id" {
  value = aws_service_discovery_private_dns_namespace.internal.id
}
