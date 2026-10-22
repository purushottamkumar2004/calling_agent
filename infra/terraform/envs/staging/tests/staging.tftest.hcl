# Offline plan of the staging root with mocked providers (no AWS credentials needed).
# Runs in CI: terraform test. Asserts the properties the architecture and ADRs depend on.

# Mocks return random strings; give ARN- and JSON-shaped defaults where the provider validates them.
mock_provider "aws" {
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:ap-south-1:123456789012:key/00000000-0000-0000-0000-000000000000" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_resource "aws_db_instance" {
    defaults = { master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:ap-south-1:123456789012:secret:mock", kms_key_id = "", secret_status = "active" }] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

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
