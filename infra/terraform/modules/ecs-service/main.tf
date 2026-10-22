data "aws_region" "current" {}

locals {
  family      = "${var.name_prefix}-${var.service}"
  role_prefix = "${var.name_prefix}-ecs-${var.service}"
  log_group   = "/ecs/${var.name_prefix}/${var.service}"
  primary     = length(var.ports) > 0 ? var.ports[0] : null
}

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
}

# ---- Execution role: pull image, read this service's secrets, write logs ----
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.role_prefix}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  count = length(var.secret_arns) > 0 ? 1 : 0

  statement {
    sid       = "ReadOwnSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }
  statement {
    sid       = "DecryptSecrets"
    actions   = ["kms:Decrypt"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count  = length(var.secret_arns) > 0 ? 1 : 0
  name   = "secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

# ---- Task role: what the application itself may call ----
resource "aws_iam_role" "task" {
  name               = "${local.role_prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

locals {
  protection_statements = var.enable_task_protection ? [{
    sid       = "OwnTaskProtection"
    actions   = ["ecs:GetTaskProtection", "ecs:UpdateTaskProtection"]
    resources = ["arn:aws:ecs:${data.aws_region.current.region}:*:task/${var.cluster_name}/*"]
  }] : []
  task_statements = concat(var.task_role_statements, local.protection_statements)
}

data "aws_iam_policy_document" "task" {
  count = length(local.task_statements) > 0 ? 1 : 0

  dynamic "statement" {
    for_each = local.task_statements
    content {
      sid       = statement.value.sid
      actions   = statement.value.actions
      resources = statement.value.resources
    }
  }
}

resource "aws_iam_role_policy" "task" {
  count  = length(local.task_statements) > 0 ? 1 : 0
  name   = "app"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task[0].json
}

# ---- Task definition ----
resource "aws_ecs_task_definition" "this" {
  family                   = local.family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name                   = var.service
    image                  = var.image
    essential              = true
    command                = var.command
    readonlyRootFilesystem = var.readonly_root_filesystem
    stopTimeout            = var.stop_timeout_sec
    linuxParameters        = { initProcessEnabled = true }
    portMappings           = [for p in var.ports : { containerPort = p, protocol = "tcp" }]
    environment            = [for k in sort(keys(var.environment)) : { name = k, value = var.environment[k] }]
    secrets                = [for k in sort(keys(var.secrets)) : { name = k, valueFrom = var.secrets[k] }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = var.service
      }
    }
  }])
}

# ---- Load balancer attachment ----
resource "aws_lb_target_group" "this" {
  count                = var.create_service && var.load_balancer != null ? 1 : 0
  name                 = "${var.short_prefix}-${var.service}"
  port                 = local.primary
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.load_balancer.vpc_id
  deregistration_delay = var.load_balancer.deregistration_delay

  health_check {
    path                = var.load_balancer.health_check_path
    matcher             = "200-399"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
  }
}

resource "aws_lb_listener_rule" "deny" {
  count        = var.create_service && var.load_balancer != null && try(length(var.load_balancer.deny_path_patterns), 0) > 0 ? 1 : 0
  listener_arn = var.load_balancer.listener_arn
  priority     = var.load_balancer.priority - 1

  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "not found"
      status_code  = "404"
    }
  }

  condition {
    host_header {
      values = [var.load_balancer.host]
    }
  }
  condition {
    path_pattern {
      values = var.load_balancer.deny_path_patterns
    }
  }
}

resource "aws_lb_listener_rule" "forward" {
  count        = var.create_service && var.load_balancer != null ? 1 : 0
  listener_arn = var.load_balancer.listener_arn
  priority     = var.load_balancer.priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this[0].arn
  }

  condition {
    host_header {
      values = [var.load_balancer.host]
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "from_alb" {
  count                        = var.create_service && var.load_balancer != null ? 1 : 0
  security_group_id            = var.security_group_ids[0]
  description                  = "ALB to ${var.service}"
  referenced_security_group_id = var.load_balancer.alb_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = local.primary
  to_port                      = local.primary
}

# ---- Service discovery ----
resource "aws_service_discovery_service" "this" {
  count = var.create_service && var.service_discovery != null ? 1 : 0
  name  = var.service_discovery.name

  dns_config {
    namespace_id   = var.service_discovery.namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

# ---- Service ----
resource "aws_ecs_service" "this" {
  count           = var.create_service ? 1 : 0
  name            = var.service
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  health_check_grace_period_seconds = var.load_balancer != null ? 60 : null
  propagate_tags                    = "SERVICE"
  enable_ecs_managed_tags           = true

  dynamic "load_balancer" {
    for_each = var.load_balancer != null ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.this[0].arn
      container_name   = var.service
      container_port   = local.primary
    }
  }

  dynamic "service_registries" {
    for_each = var.service_discovery != null ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.this[0].arn
    }
  }

  lifecycle {
    # CI registers new task definition revisions on deploy; the schedule sets desired count.
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener_rule.forward]
}

# ---- Scale to zero outside working hours ----
resource "aws_appautoscaling_target" "this" {
  count              = var.create_service && var.schedule != null ? 1 : 0
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this[0].name}"
  min_capacity       = 0
  max_capacity       = var.schedule.up_desired
}

resource "aws_appautoscaling_scheduled_action" "down" {
  count              = var.create_service && var.schedule != null ? 1 : 0
  name               = "${local.family}-down"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  schedule           = var.schedule.down_cron
  timezone           = var.schedule.timezone

  scalable_target_action {
    min_capacity = 0
    max_capacity = 0
  }
}

resource "aws_appautoscaling_scheduled_action" "up" {
  count              = var.create_service && var.schedule != null ? 1 : 0
  name               = "${local.family}-up"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  schedule           = var.schedule.up_cron
  timezone           = var.schedule.timezone

  scalable_target_action {
    min_capacity = var.schedule.up_desired
    max_capacity = var.schedule.up_desired
  }

  depends_on = [aws_appautoscaling_scheduled_action.down]
}
