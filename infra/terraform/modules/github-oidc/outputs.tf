output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN variable on the GitHub Environments."
  value       = aws_iam_role.deploy.arn
}

output "oidc_provider_arn" {
  value = local.oidc_arn
}

output "allowed_subjects" {
  description = "OIDC `sub` values the deploy role trusts."
  value       = local.subjects
}
