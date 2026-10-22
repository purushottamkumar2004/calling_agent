output "state_bucket" {
  description = "Put this in envs/<env>/backend.hcl as `bucket`."
  value       = aws_s3_bucket.state.bucket
}
