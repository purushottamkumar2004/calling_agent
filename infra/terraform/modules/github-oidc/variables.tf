variable "name" {
  description = "Name prefix, e.g. calling-agent-staging."
  type        = string
}

variable "github_repository" {
  description = "owner/repo allowed to assume the deploy role."
  type        = string
}

variable "github_environments" {
  description = "GitHub Environments whose jobs may assume the role. Protect them in GitHub (main only, reviewers for migrations)."
  type        = list(string)
}

variable "create_oidc_provider" {
  description = "The GitHub OIDC provider is one per AWS account. false = look up an existing one."
  type        = bool
  default     = true
}

variable "ecr_repository_prefix" {
  description = "ECR repositories the role may push to: <prefix>/*."
  type        = string
  default     = "calling-agent"
}

variable "ecs_cluster_name" {
  description = "ECS cluster the role may deploy to and run one-off tasks (migrations) in."
  type        = string
}
