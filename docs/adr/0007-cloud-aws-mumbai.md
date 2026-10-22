# 0007: Cloud: AWS ap-south-1 (Mumbai)
Date: 2026-10-22
Status: Accepted

## Context
Need managed Postgres, Redis, object storage and a container platform in India.

## Decision
AWS Mumbai: RDS Postgres, ElastiCache Redis, S3, ECS for the pilot, EKS for production.

## Alternatives considered
GCP Mumbai; Azure Pune.

## Consequences
Terraform targets AWS. Apply for startup credits early.
