variable "name" {
  type = string
}

variable "zone_name" {
  description = "Delegated subdomain hosted in this account, e.g. staging.example.in. Add the output NS records at the parent zone."
  type        = string
}

variable "hostnames" {
  description = "Labels under zone_name served by the ALB, e.g. [\"app\", \"api\", \"voice\"]."
  type        = set(string)
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "idle_timeout_sec" {
  description = "ALB idle timeout. Media WebSockets carry audio continuously, so idle gaps are short."
  type        = number
  default     = 120
}

variable "access_logs_bucket" {
  description = "Optional S3 bucket for ALB access logs (null = off)."
  type        = string
  default     = null
}
