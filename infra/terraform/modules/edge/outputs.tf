output "https_listener_arn" {
  value = aws_lb_listener.https.arn
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "alb_arn_suffix" {
  description = "For CloudWatch ALB metrics."
  value       = aws_lb.this.arn_suffix
}

output "zone_name_servers" {
  description = "Add these as an NS record for zone_name at the parent DNS zone."
  value       = aws_route53_zone.this.name_servers
}

output "fqdns" {
  description = "Label -> fully qualified hostname."
  value       = { for h in var.hostnames : h => "${h}.${var.zone_name}" }
}
