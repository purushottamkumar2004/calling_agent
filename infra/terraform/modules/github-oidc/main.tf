# Lets GitHub Actions deploy to this account with short-lived credentials (no AWS keys
# in GitHub). Only jobs bound to the listed GitHub Environments of one repository can
# assume the role; the default `sub` claim for such jobs is repo:<owner/repo>:environment:<env>.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account  = data.aws_caller_identity.current.account_id
  region   = data.aws_region.current.region
  subjects = [for env in var.github_environments : "repo:${var.github_repository}:environment:${env}"]

  cluster_arn = "arn:aws:ecs:${local.region}:${local.account}:cluster/${var.ecs_cluster_name}"
  oidc_arn    = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.subjects
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-github-deploy"
  description          = "GitHub Actions deploys for ${var.github_repository}"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPushPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = ["arn:aws:ecr:${local.region}:${local.account}:repository/${var.ecr_repository_prefix}/*"]
  }

  # Task definition APIs do not support resource-level permissions.
  statement {
    sid = "TaskDefinitions"
    actions = [
      "ecs:DeregisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "UpdateServices"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = ["arn:aws:ecs:${local.region}:${local.account}:service/${var.ecs_cluster_name}/*"]
  }

  # One-off tasks (migrations, role setup), only in this cluster.
  statement {
    sid       = "RunOneOffTasks"
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${local.region}:${local.account}:task-definition/${var.name}-*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [local.cluster_arn]
    }
  }

  statement {
    sid       = "WatchTasks"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["arn:aws:ecs:${local.region}:${local.account}:task/${var.ecs_cluster_name}/*"]
  }

  # Task definitions reference task and execution roles; only ours, only to ECS tasks.
  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account}:role/${var.name}-ecs-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # Read migration task output in the job log.
  statement {
    sid       = "ReadTaskLogs"
    actions   = ["logs:FilterLogEvents", "logs:GetLogEvents"]
    resources = ["arn:aws:logs:${local.region}:${local.account}:log-group:/ecs/${var.name}/*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
