variable "aws_account_id" {
  description = "Staging account. The provider refuses to run against any other account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  type    = string
  default = "ap-south-1" # ADR 0004, 0007
}

variable "github_repository" {
  type    = string
  default = "purushottamkumar2004/calling_agent"
}

variable "zone_name" {
  description = "Delegated DNS zone for staging, e.g. staging.<your-domain>. Hosts: app., api., voice."
  type        = string
}

variable "alarm_email" {
  description = "Optional email subscribed to staging alarms (null = topic only)."
  type        = string
  default     = null
}

variable "image_tag" {
  description = "Initial image tag for every service. CI deploys real tags; Terraform does not revert them."
  type        = string
  default     = "bootstrap"
}

variable "scale_to_zero" {
  description = "Run services only during working hours (ADR 0010)."
  type        = bool
  default     = true
}

variable "otel_collector_image" {
  description = "AWS Distro for OpenTelemetry collector, pinned (ADR 0009 backend: X-Ray + CloudWatch in ap-south-1)."
  type        = string
  default     = "public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0"
}
