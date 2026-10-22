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
