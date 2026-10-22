variable "name" {
  description = "Name prefix, e.g. calling-agent-staging."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. Must be a /16 so each tier gets /24 subnets."
  type        = string

  validation {
    condition     = can(cidrhost(var.cidr_block, 0)) && endswith(var.cidr_block, "/16")
    error_message = "cidr_block must be a valid /16."
  }
}

variable "az_count" {
  description = "Availability zones to span (2 is enough for staging and the pilot)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3 (RDS and ElastiCache subnet groups need at least 2)."
  }
}

variable "single_nat_gateway" {
  description = "One NAT gateway for all AZs (cheaper; staging). false = one per AZ (production)."
  type        = bool
  default     = true
}

variable "flow_logs_enabled" {
  description = "Send VPC flow logs (REJECT only) to CloudWatch."
  type        = bool
  default     = false
}

variable "flow_logs_retention_days" {
  type    = number
  default = 14
}
