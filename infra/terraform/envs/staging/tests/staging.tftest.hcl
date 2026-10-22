# Offline plan of the staging root with mocked providers (no AWS credentials needed).
# Runs in CI: tofu test. Asserts the properties the architecture and ADRs depend on.

# Mocks return random strings; give ARN- and JSON-shaped defaults where the provider validates them.
mock_provider "aws" {
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:ap-south-1:123456789012:key/00000000-0000-0000-0000-000000000000" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:loadbalancer/app/mock/0123456789abcdef", arn_suffix = "app/mock/0123456789abcdef" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:listener/app/mock/0123456789abcdef/0123456789abcdef" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:123456789012:targetgroup/mock/0123456789abcdef", arn_suffix = "targetgroup/mock/0123456789abcdef" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = { arn = "arn:aws:acm:ap-south-1:123456789012:certificate/00000000-0000-0000-0000-000000000000" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:ap-south-1:123456789012:cluster/calling-agent-staging" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:ap-south-1:123456789012:task-definition/mock:1" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:servicediscovery:ap-south-1:123456789012:service/srv-mock" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:ap-south-1:123456789012:mock" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:mock-AbCdEf" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:ap-south-1:123456789012:log-group:mock" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "123456789012.dkr.ecr.ap-south-1.amazonaws.com/calling-agent/mock" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "tls" {}

mock_provider "random" {
  mock_resource "random_password" {
    defaults = { result = "mockmockmockmockmockmockmockmockmockmockmockmock" }
  }
}

override_data {
  target = module.network.data.aws_availability_zones.available
  values = { names = ["ap-south-1a", "ap-south-1b", "ap-south-1c"] }
}

override_data {
  target = module.network.data.aws_region.current
  values = { region = "ap-south-1" }
}

override_data {
  target = module.data.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.github_oidc.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

override_data {
  target = module.github_oidc.data.aws_region.current
  values = { region = "ap-south-1" }
}

variables {
  aws_account_id = "123456789012"
  zone_name      = "staging.example.in"
}

override_data {
  target = module.edge.data.aws_vpc.this
  values = { cidr_block = "10.20.0.0/16" }
}

override_data {
  target = module.api.data.aws_region.current
  values = { region = "ap-south-1" }
}

run "network" {
  command = plan

  assert {
    condition     = length(module.network.azs) == 2 && module.network.azs[0] == "ap-south-1a"
    error_message = "Staging spans exactly two AZs in ap-south-1."
  }
  assert {
    condition     = length(module.network.data_subnet_ids) == 2 && length(module.network.app_subnet_ids) == 2
    error_message = "Each private tier needs a subnet per AZ (RDS/ElastiCache subnet groups)."
  }
  assert {
    condition     = length(module.network.nat_public_ips) == 1
    error_message = "Staging uses a single NAT gateway."
  }
}

run "data_layer" {
  command = plan

  assert {
    condition     = module.data.recordings_bucket == "calling-agent-staging-recordings-123456789012"
    error_message = "Recordings bucket name must be account-scoped."
  }
  assert {
    condition     = module.data.recordings_expiration_days == 90
    error_message = "Recordings expire at the 90-day platform ceiling (ADR 0012)."
  }
}

run "github_oidc_trust" {
  command = plan

  assert {
    condition = module.github_oidc.allowed_subjects == [
      "repo:purushottamkumar2004/calling_agent:environment:staging",
      "repo:purushottamkumar2004/calling_agent:environment:staging-migrations",
    ]
    error_message = "Deploy role must only trust the staging GitHub Environments of this repository."
  }
}

run "compute" {
  command = plan

  assert {
    condition     = module.edge.fqdns == { api = "api.staging.example.in", app = "app.staging.example.in", voice = "voice.staging.example.in" }
    error_message = "ALB serves exactly app., api. and voice. under the staging zone."
  }
  assert {
    condition     = module.api_migrate.service_name == null && module.api_migrate.task_definition_family == "calling-agent-staging-api-migrate"
    error_message = "Migrations are a one-off task (no service), named so the deploy role can run it."
  }
  assert {
    condition     = alltrue([for f in [module.api.task_definition_family, module.voice_worker.task_definition_family, module.otel_collector.task_definition_family] : startswith(f, "calling-agent-staging-")])
    error_message = "Task families must match the deploy role's RunTask/PassRole patterns."
  }
  assert {
    condition     = length(module.ecr.repository_urls) == 6
    error_message = "One ECR repository per app."
  }
}
