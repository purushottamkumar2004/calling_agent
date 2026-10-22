variable "aws_account_id" {
  description = "Account this bootstrap targets. Guards against running in the wrong account."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "region" {
  description = "State bucket region (ADR 0007)."
  type        = string
  default     = "ap-south-1"
}

variable "project" {
  description = "Name prefix."
  type        = string
  default     = "calling-agent"
}
