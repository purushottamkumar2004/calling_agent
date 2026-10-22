variable "name_prefix" {
  description = "Environment prefix, e.g. calling-agent-staging. Roles are named <prefix>-ecs-<service>-*, task families <prefix>-<service> (both matched by the GitHub deploy role)."
  type        = string
}

variable "short_prefix" {
  description = "Short prefix for names capped at 32 characters (target groups), e.g. ca-stg."
  type        = string
}

variable "service" {
  description = "Service name, e.g. api, voice-gateway, api-migrate."
  type        = string
}

variable "cluster_name" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "image" {
  description = "Initial image. Later deploys come from CI (new task definition revisions), which Terraform does not revert."
  type        = string
}

variable "command" {
  description = "Container command override (null = image default)."
  type        = list(string)
  default     = null
}

variable "cpu" {
  type = number
}

variable "memory" {
  type = number
}

variable "cpu_architecture" {
  type    = string
  default = "ARM64"
}

variable "ports" {
  description = "Container ports; the first one is used for the load balancer and service discovery."
  type        = list(number)
  default     = []
}

variable "environment" {
  description = "Plain (non-secret) environment variables. Unprefixed names inside an app (ADR 0011)."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Env var -> Secrets Manager valueFrom (\"<secret-arn>:<json-key>::\")."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Secret ARNs the execution role may read (the ones referenced in secrets)."
  type        = list(string)
  default     = []
}

variable "kms_key_arn" {
  description = "KMS key encrypting the secrets."
  type        = string
}

variable "readonly_root_filesystem" {
  type    = bool
  default = true
}

variable "stop_timeout_sec" {
  description = "Grace period after SIGTERM (Fargate max 120). Voice workers also use task protection."
  type        = number
  default     = 30
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "task_role_statements" {
  description = "Extra IAM statements for the application (task) role."
  type = list(object({
    sid       = string
    actions   = list(string)
    resources = list(string)
  }))
  default = []
}

variable "enable_task_protection" {
  description = "Allow the task to set ECS scale-in protection on itself (Voice Worker drains calls)."
  type        = bool
  default     = false
}

# ---- Service (omit for one-off tasks such as migrations) ----
variable "create_service" {
  type    = bool
  default = true
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "subnet_ids" {
  type    = list(string)
  default = []
}

variable "security_group_ids" {
  type    = list(string)
  default = []
}

variable "load_balancer" {
  description = "Attach to the shared HTTPS listener by host header."
  type = object({
    listener_arn          = string
    alb_security_group_id = string
    vpc_id                = string
    host                  = string
    priority              = number
    health_check_path     = string
    deny_path_patterns    = optional(list(string), [])
    deregistration_delay  = optional(number, 30)
  })
  default = null
}

variable "service_discovery" {
  description = "Register as <name>.internal in the Cloud Map namespace."
  type = object({
    namespace_id = string
    name         = string
  })
  default = null
}

variable "schedule" {
  description = "Scale to zero outside working hours (ADR 0010)."
  type = object({
    timezone   = string
    down_cron  = string
    up_cron    = string
    up_desired = number
  })
  default = null
}
