# Staging (ADR 0010): mirrors the pilot ECS setup at minimum size.
# Plan only until the end of Phase 2. Compute (ECS, ALB, ECR, Cloud Map) is a later layer.

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = "calling-agent"
      Environment = "staging"
      ManagedBy   = "terraform"
      Repository  = var.github_repository
    }
  }
}

locals {
  name = "calling-agent-staging"
}

module "network" {
  source = "../../modules/network"

  name               = local.name
  cidr_block         = "10.20.0.0/16"
  az_count           = 2
  single_nat_gateway = true
  flow_logs_enabled  = false
}

module "data" {
  source = "../../modules/data"

  name                  = local.name
  vpc_id                = module.network.vpc_id
  data_subnet_ids       = module.network.data_subnet_ids
  app_security_group_id = module.network.app_security_group_id

  db_instance_class          = "db.t4g.micro"
  db_multi_az                = false
  db_deletion_protection     = true
  redis_node_type            = "cache.t4g.micro"
  recordings_expiration_days = 30 # staging holds synthetic data only
}

module "github_oidc" {
  source = "../../modules/github-oidc"

  name                 = local.name
  github_repository    = var.github_repository
  github_environments  = ["staging", "staging-migrations"]
  create_oidc_provider = true # one per account; staging has its own account
  ecs_cluster_name     = local.name
}
