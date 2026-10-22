output "task_definition_family" {
  value = aws_ecs_task_definition.this.family
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.this.arn
}

output "service_name" {
  value = var.create_service ? aws_ecs_service.this[0].name : null
}

output "log_group" {
  value = aws_cloudwatch_log_group.this.name
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "target_group_arn_suffix" {
  description = "For CloudWatch target health alarms (null without a load balancer)."
  value       = var.create_service && var.load_balancer != null ? aws_lb_target_group.this[0].arn_suffix : null
}
