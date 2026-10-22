# Staging compute (ECS Fargate, arm64) per staging-plan.md. Plan only until end of Phase 2.
#
# Env vars are unprefixed inside each app; only URLs of another service are prefixed
# (CORE_API_URL), per ADR 0011. Ports and health paths marked ASSUMED are confirmed by
# the owning chat before apply.

locals {
  short = "ca-stg"
  apps  = ["api", "web", "voice-gateway", "voice-worker", "postcall-worker", "scheduler"]

  core_api_url = "http://api.internal:4000"

  common_env = {
    OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel.internal:4318"
    OTEL_RESOURCE_ATTRIBUTES    = "deployment.environment=staging"
  }

  schedule = var.scale_to_zero ? {
    timezone   = "Asia/Kolkata"
    down_cron  = "cron(0 21 * * ? *)"      # 21:00 IST daily
    up_cron    = "cron(0 9 ? * MON-SAT *)" # 09:00 IST Mon-Sat
    up_desired = 1
  } : null

  app_sg  = module.network.app_security_group_id
  subnets = module.network.app_subnet_ids
  kms     = module.data.kms_key_arn

  recordings_arn = "arn:aws:s3:::${module.data.recordings_bucket}"
  kms_data_statement = {
    sid       = "UseDataKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [module.data.kms_key_arn]
  }

  image = { for a in local.apps : a => "${module.ecr.repository_urls[a]}:${var.image_tag}" }
}

module "ecr" {
  source = "../../modules/ecr"
  apps   = toset(local.apps)
}

module "cluster" {
  source = "../../modules/ecs-cluster"
  name   = local.name
  vpc_id = module.network.vpc_id
}

module "edge" {
  source            = "../../modules/edge"
  name              = local.name
  zone_name         = var.zone_name
  hostnames         = toset(["app", "api", "voice"])
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
}

# Service-to-service traffic inside the workload security group.
resource "aws_vpc_security_group_ingress_rule" "internal" {
  for_each = {
    api    = { port = 4000, to = 4000, why = "Core API internal tools (api.internal)" }
    worker = { port = 8080, to = 8080, why = "Voice Gateway to Voice Worker media (ASSUMED port)" }
    otel   = { port = 4317, to = 4318, why = "OTLP to the collector (otel.internal)" }
  }
  security_group_id            = local.app_sg
  description                  = each.value.why
  referenced_security_group_id = local.app_sg
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.to
}

# ---- Core API ----
module "api" {
  source       = "../../modules/ecs-service"
  name_prefix  = local.name
  short_prefix = local.short
  service      = "api"
  cluster_name = module.cluster.cluster_name
  cluster_arn  = module.cluster.cluster_arn
  image        = local.image["api"]
  cpu          = 512
  memory       = 1024
  ports        = [4000]
  kms_key_arn  = local.kms

  environment = merge(local.common_env, {
    NODE_ENV                    = "production"
    PORT                        = "4000"
    OTEL_SERVICE_NAME           = "api"
    S3_BUCKET                   = module.data.recordings_bucket
    SERVICE_JWT_ALLOWED_ISSUERS = join(",", local.jwt_issuers)
    SERVICE_JWT_PUBLIC_KEYS     = local.service_jwt_public_keys # PROVISIONAL name (ADR 0011 ES256)
  })
  secrets = merge(local.manual_env["api"], {
    DATABASE_URL            = "${module.data.postgres_app_secret_arn}:url::"
    REDIS_URL               = "${module.data.redis_secret_arn}:url::"
    USER_JWT_SECRET         = "${aws_secretsmanager_secret.api_generated.arn}:USER_JWT_SECRET::"
    FIELD_ENCRYPTION_KEY_ID = "${aws_secretsmanager_secret.api_generated.arn}:FIELD_ENCRYPTION_KEY_ID::"
    FIELD_ENCRYPTION_KEY    = "${aws_secretsmanager_secret.api_generated.arn}:FIELD_ENCRYPTION_KEY::"
    PHONE_HASH_KEY          = "${aws_secretsmanager_secret.api_generated.arn}:PHONE_HASH_KEY::"
  })
  secret_arns = [
    module.data.postgres_app_secret_arn, module.data.redis_secret_arn,
    aws_secretsmanager_secret.api_generated.arn, aws_secretsmanager_secret.manual["api"].arn,
  ]
  task_role_statements = [
    { sid = "SignRecordingUrls", actions = ["s3:GetObject"], resources = ["${local.recordings_arn}/*"] },
    local.kms_data_statement,
  ]

  subnet_ids         = local.subnets
  security_group_ids = [local.app_sg]
  load_balancer = {
    listener_arn          = module.edge.https_listener_arn
    alb_security_group_id = module.edge.alb_security_group_id
    vpc_id                = module.network.vpc_id
    host                  = module.edge.fqdns["api"]
    priority              = 110
    health_check_path     = "/health"
    deny_path_patterns    = ["/internal/*"] # internal tool API is reachable only as api.internal
  }
  service_discovery = { namespace_id = module.cluster.namespace_id, name = "api" }
  schedule          = local.schedule
}

# One-off migration task (no service). Run by the approval-gated CI job.
module "api_migrate" {
  source         = "../../modules/ecs-service"
  name_prefix    = local.name
  short_prefix   = local.short
  service        = "api-migrate"
  create_service = false
  cluster_name   = module.cluster.cluster_name
  cluster_arn    = module.cluster.cluster_arn
  image          = local.image["api"]
  command        = ["node", "dist/scripts/migrate.js"]
  cpu            = 256
  memory         = 512
  kms_key_arn    = local.kms
  secrets        = { MIGRATION_DATABASE_URL = "${module.data.postgres_owner_secret_arn}:url::" }
  secret_arns    = [module.data.postgres_owner_secret_arn]
}

# ---- Dashboard ----
module "web" {
  source       = "../../modules/ecs-service"
  name_prefix  = local.name
  short_prefix = local.short
  service      = "web"
  cluster_name = module.cluster.cluster_name
  cluster_arn  = module.cluster.cluster_arn
  image        = local.image["web"]
  cpu          = 256
  memory       = 512
  ports        = [3000]
  kms_key_arn  = local.kms

  readonly_root_filesystem = false # Next.js writes its cache
  environment = merge(local.common_env, {
    NODE_ENV          = "production"
    PORT              = "3000"
    OTEL_SERVICE_NAME = "web"
    CORE_API_URL      = local.core_api_url
  })
  secrets     = local.manual_env["web"]
  secret_arns = [aws_secretsmanager_secret.manual["web"].arn]

  subnet_ids         = local.subnets
  security_group_ids = [local.app_sg]
  load_balancer = {
    listener_arn          = module.edge.https_listener_arn
    alb_security_group_id = module.edge.alb_security_group_id
    vpc_id                = module.network.vpc_id
    host                  = module.edge.fqdns["app"]
    priority              = 100
    health_check_path     = "/" # ASSUMED
  }
  schedule = local.schedule
}

# ---- Voice Gateway (Exotel webhooks + media WebSocket) ----
module "voice_gateway" {
  source       = "../../modules/ecs-service"
  name_prefix  = local.name
  short_prefix = local.short
  service      = "voice-gateway"
  cluster_name = module.cluster.cluster_name
  cluster_arn  = module.cluster.cluster_arn
  image        = local.image["voice-gateway"]
  cpu          = 512
  memory       = 1024
  ports        = [8000]
  kms_key_arn  = local.kms

  stop_timeout_sec = 120
  environment = merge(local.common_env, {
    PORT              = "8000"
    OTEL_SERVICE_NAME = "voice-gateway"
    CORE_API_URL      = local.core_api_url
  })
  secrets = merge(local.manual_env["voice-gateway"], {
    REDIS_URL               = "${module.data.redis_secret_arn}:url::"
    SERVICE_JWT_PRIVATE_KEY = "${aws_secretsmanager_secret.service_jwt["voice-gateway"].arn}:SERVICE_JWT_PRIVATE_KEY::"
  })
  secret_arns = [
    module.data.redis_secret_arn, aws_secretsmanager_secret.service_jwt["voice-gateway"].arn,
    aws_secretsmanager_secret.manual["voice-gateway"].arn,
  ]

  subnet_ids         = local.subnets
  security_group_ids = [local.app_sg]
  load_balancer = {
    listener_arn          = module.edge.https_listener_arn
    alb_security_group_id = module.edge.alb_security_group_id
    vpc_id                = module.network.vpc_id
    host                  = module.edge.fqdns["voice"]
    priority              = 120
    health_check_path     = "/health"
    deregistration_delay  = 300 # let open media streams finish on deploy
  }
  schedule = local.schedule
}

# ---- Voice Worker (Pipecat). Private; the gateway reaches it by task IP. ----
module "voice_worker" {
  source       = "../../modules/ecs-service"
  name_prefix  = local.name
  short_prefix = local.short
  service      = "voice-worker"
  cluster_name = module.cluster.cluster_name
  cluster_arn  = module.cluster.cluster_arn
  image        = local.image["voice-worker"]
  cpu          = 1024
  memory       = 2048
  ports        = [8080] # ASSUMED
  kms_key_arn  = local.kms

  stop_timeout_sec       = 120
  enable_task_protection = true # protects tasks with live calls from deploys and scale-in
  environment = merge(local.common_env, {
    PORT              = "8080"
    OTEL_SERVICE_NAME = "voice-worker"
    CORE_API_URL      = local.core_api_url
    S3_BUCKET         = module.data.recordings_bucket
  })
  secrets = merge(local.manual_env["voice-worker"], {
    REDIS_URL               = "${module.data.redis_secret_arn}:url::"
    SERVICE_JWT_PRIVATE_KEY = "${aws_secretsmanager_secret.service_jwt["voice-worker"].arn}:SERVICE_JWT_PRIVATE_KEY::"
  })
  secret_arns = [
    module.data.redis_secret_arn, aws_secretsmanager_secret.service_jwt["voice-worker"].arn,
    aws_secretsmanager_secret.manual["voice-worker"].arn,
  ]
  task_role_statements = [
    { sid = "WriteRecordings", actions = ["s3:PutObject"], resources = ["${local.recordings_arn}/*"] },
    local.kms_data_statement,
  ]

  subnet_ids         = local.subnets
  security_group_ids = [local.app_sg]
  schedule           = local.schedule
}

# ---- Post-call Worker ----
module "postcall_worker" {
  source       = "../../modules/ecs-service"
  name_prefix  = local.name
  short_prefix = local.short
  service      = "postcall-worker"
  cluster_name = module.cluster.cluster_name
  cluster_arn  = module.cluster.cluster_arn
  image        = local.image["postcall-worker"]
  cpu          = 512
  memory       = 1024
  kms_key_arn  = local.kms

  environment = merge(local.common_env, {
    OTEL_SERVICE_NAME = "postcall-worker"
    CORE_API_URL      = local.core_api_url
    S3_BUCKET         = module.data.recordings_bucket
  })
  secrets = merge(local.manual_env["postcall-worker"], {
    REDIS_URL               = "${module.data.redis_secret_arn}:url::"
    SERVICE_JWT_PRIVATE_KEY = "${aws_secretsmanager_secret.service_jwt["postcall-worker"].arn}:SERVICE_JWT_PRIVATE_KEY::"
  })
  secret_arns = [
    module.data.redis_secret_arn, aws_secretsmanager_secret.service_jwt["postcall-worker"].arn,
    aws_secretsmanager_secret.manual["postcall-worker"].arn,
  ]
  task_role_statements = [
    {
      sid       = "RecordingsLifecycle" # read for summaries, delete early for shorter retention_days (ADR 0012)
      actions   = ["s3:GetObject", "s3:DeleteObject"]
      resources = ["${local.recordings_arn}/*"]
    },
    local.kms_data_statement,
  ]

  subnet_ids         = local.subnets
  security_group_ids = [local.app_sg]
  schedule           = local.schedule
}

# ---- Scheduler (BullMQ) ----
module "scheduler" {
  source       = "../../modules/ecs-service"
  name_prefix  = local.name
  short_prefix = local.short
  service      = "scheduler"
  cluster_name = module.cluster.cluster_name
  cluster_arn  = module.cluster.cluster_arn
  image        = local.image["scheduler"]
  cpu          = 256
  memory       = 512
  kms_key_arn  = local.kms

  environment = merge(local.common_env, {
    NODE_ENV          = "production"
    OTEL_SERVICE_NAME = "scheduler"
    CORE_API_URL      = local.core_api_url
  })
  secrets = merge(local.manual_env["scheduler"], {
    REDIS_URL               = "${module.data.redis_secret_arn}:url::"
    SERVICE_JWT_PRIVATE_KEY = "${aws_secretsmanager_secret.service_jwt["scheduler"].arn}:SERVICE_JWT_PRIVATE_KEY::"
  })
  secret_arns = [
    module.data.redis_secret_arn, aws_secretsmanager_secret.service_jwt["scheduler"].arn,
    aws_secretsmanager_secret.manual["scheduler"].arn,
  ]

  subnet_ids         = local.subnets
  security_group_ids = [local.app_sg]
  schedule           = local.schedule
}
