variable "name" {
  description = "Name prefix, e.g. calling-agent-staging."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "data_subnet_ids" {
  description = "Private data-tier subnets (at least 2 AZs)."
  type        = list(string)
}

variable "app_security_group_id" {
  description = "Workload security group allowed to reach Postgres and Redis."
  type        = string
}

variable "kms_deletion_window_days" {
  type    = number
  default = 30
}

variable "secret_recovery_window_days" {
  description = "Secrets Manager recovery window (0 = delete immediately)."
  type        = number
  default     = 7
}

# ---- Postgres ----
variable "db_engine_version" {
  description = "RDS PostgreSQL version. Major only lets RDS pick the default minor; must ship pgvector 0.8."
  type        = string
  default     = "16"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
  default     = 50
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "db_deletion_protection" {
  type    = bool
  default = true
}

variable "db_name" {
  type    = string
  default = "calling_agent"
}

variable "db_owner_username" {
  description = "RDS master user = schema owner used by migrations (non-superuser, CREATEROLE), as in local dev."
  type        = string
  default     = "calling_agent"
}

variable "db_app_username" {
  description = "Login role for the running Core API (member of api_app). Created by a one-off task, not by Terraform."
  type        = string
  default     = "calling_agent_app"
}

# ---- Redis ----
variable "redis_engine_version" {
  type    = string
  default = "7.1"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

# ---- Recordings ----
variable "recordings_expiration_days" {
  description = "Bucket lifecycle expiry. Platform retention ceiling is 90 days (ADR 0012); tenants with shorter retention_days are deleted early by the Post-call Worker."
  type        = number
  default     = 90

  validation {
    condition     = var.recordings_expiration_days >= 1 && var.recordings_expiration_days <= 90
    error_message = "recordings_expiration_days must be 1-90 (ADR 0012 ceiling; raising it needs a new ADR and a DPDP check)."
  }
}

variable "apply_immediately" {
  description = "Apply RDS/ElastiCache changes now instead of in the maintenance window."
  type        = bool
  default     = false
}
