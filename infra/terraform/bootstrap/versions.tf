terraform {
  # 1.11+: S3 backend native locking (use_lockfile), no DynamoDB table needed.
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.60"
    }
  }
}
