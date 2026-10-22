data "aws_caller_identity" "current" {}

# One customer-managed key for this environment's data at rest:
# RDS, its managed master secret, ElastiCache, the recordings bucket and app secrets.
resource "aws_kms_key" "data" {
  description             = "${var.name} data at rest"
  enable_key_rotation     = true
  deletion_window_in_days = var.kms_deletion_window_days
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}
