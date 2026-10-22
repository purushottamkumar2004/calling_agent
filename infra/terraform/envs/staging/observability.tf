# ADR 0009: logs, metrics and traces stay in ap-south-1.
#   logs     container stdout -> CloudWatch Logs (awslogs driver, 14 days, set per service)
#   traces   OTLP -> collector -> AWS X-Ray
#   metrics  OTLP -> collector -> CloudWatch (EMF), namespace CallingAgent/staging
# Hosted Sentry receives scrubbed stack traces only (DSN in each app's manual secret).

locals {
  metrics_log_group = "/otel/${local.name}/metrics"

  otel_config = yamlencode({
    extensions = { health_check = {} }
    receivers = {
      otlp = { protocols = {
        grpc = { endpoint = "0.0.0.0:4317" }
        http = { endpoint = "0.0.0.0:4318" }
      } }
    }
    processors = {
      batch             = {}
      resourcedetection = { detectors = ["env", "ecs"] }
    }
    exporters = {
      awsxray = { region = var.region }
      awsemf  = { region = var.region, namespace = "CallingAgent/staging", log_group_name = local.metrics_log_group, log_retention = 14 }
    }
    service = {
      extensions = ["health_check"]
      pipelines = {
        traces  = { receivers = ["otlp"], processors = ["resourcedetection", "batch"], exporters = ["awsxray"] }
        metrics = { receivers = ["otlp"], processors = ["resourcedetection", "batch"], exporters = ["awsemf"] }
      }
    }
  })
}

# One shared collector (cheaper than a sidecar per task), reachable as otel.internal.
module "otel_collector" {
  source       = "../../modules/ecs-service"
  name_prefix  = local.name
  short_prefix = local.short
  service      = "otel-collector"
  cluster_name = module.cluster.cluster_name
  cluster_arn  = module.cluster.cluster_arn
  image        = var.otel_collector_image
  cpu          = 256
  memory       = 512
  ports        = [4317, 4318]
  kms_key_arn  = local.kms

  readonly_root_filesystem = false
  environment              = { AOT_CONFIG_CONTENT = local.otel_config }
  task_role_statements = [
    {
      sid       = "XRay"
      actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
      resources = ["*"]
    },
    {
      sid       = "EmfMetrics"
      actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:PutRetentionPolicy"]
      resources = ["arn:aws:logs:${var.region}:${var.aws_account_id}:log-group:${local.metrics_log_group}:*"]
    },
  ]

  subnet_ids         = local.subnets
  security_group_ids = [local.app_sg]
  service_discovery  = { namespace_id = module.cluster.namespace_id, name = "otel" }
  schedule           = local.schedule
}

# ---- Alarms -> SNS ----
resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  # Services are scaled to zero at night: missing data is not an alarm.
  alarm_common = {
    alarm_actions      = [aws_sns_topic.alarms.arn]
    ok_actions         = [aws_sns_topic.alarms.arn]
    treat_missing_data = "notBreaching"
  }

  public_services = {
    api           = module.api.target_group_arn_suffix
    web           = module.web.target_group_arn_suffix
    voice-gateway = module.voice_gateway.target_group_arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-alb-5xx"
  alarm_description   = "Load balancer returned 5xx (no healthy target, timeouts)"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = module.edge.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_common.alarm_actions
  ok_actions          = local.alarm_common.ok_actions
  treat_missing_data  = local.alarm_common.treat_missing_data
}

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  for_each            = local.public_services
  alarm_name          = "${local.name}-${each.key}-5xx"
  alarm_description   = "${each.key} returned 5xx responses"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = module.edge.alb_arn_suffix, TargetGroup = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_common.alarm_actions
  ok_actions          = local.alarm_common.ok_actions
  treat_missing_data  = local.alarm_common.treat_missing_data
}

resource "aws_cloudwatch_metric_alarm" "unhealthy" {
  for_each            = local.public_services
  alarm_name          = "${local.name}-${each.key}-unhealthy"
  alarm_description   = "${each.key} has unhealthy targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = module.edge.alb_arn_suffix, TargetGroup = each.value }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_common.alarm_actions
  ok_actions          = local.alarm_common.ok_actions
  treat_missing_data  = local.alarm_common.treat_missing_data
}

resource "aws_cloudwatch_metric_alarm" "rds" {
  for_each = {
    cpu     = { metric = "CPUUtilization", stat = "Average", op = "GreaterThanThreshold", threshold = 80, why = "Postgres CPU above 80%" }
    storage = { metric = "FreeStorageSpace", stat = "Minimum", op = "LessThanThreshold", threshold = 2147483648, why = "Postgres free storage below 2 GB" }
    memory  = { metric = "FreeableMemory", stat = "Minimum", op = "LessThanThreshold", threshold = 104857600, why = "Postgres freeable memory below 100 MB" }
  }
  alarm_name          = "${local.name}-postgres-${each.key}"
  alarm_description   = each.value.why
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  dimensions          = { DBInstanceIdentifier = "${local.name}-postgres" }
  statistic           = each.value.stat
  period              = 300
  evaluation_periods  = 3
  threshold           = each.value.threshold
  comparison_operator = each.value.op
  alarm_actions       = local.alarm_common.alarm_actions
  ok_actions          = local.alarm_common.ok_actions
  treat_missing_data  = "breaching" # the database runs 24/7; no data means it is down
}

resource "aws_cloudwatch_metric_alarm" "redis_memory" {
  alarm_name          = "${local.name}-redis-memory"
  alarm_description   = "Redis memory above 80%: with noeviction, writes (BullMQ, streams) fail when full"
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  dimensions          = { ReplicationGroupId = "${local.name}-redis" }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_common.alarm_actions
  ok_actions          = local.alarm_common.ok_actions
  treat_missing_data  = "breaching"
}
