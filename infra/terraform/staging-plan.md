# Staging on AWS ap-south-1: plan

Status: **Draft** (chat 08). Two items are open for the Master chat; see [Open decisions](#open-decisions-master-chat).
Follows `docs/architecture.md` (Infrastructure and scaling; CI; Observability) and ADRs 0004, 0006, 0007.

## Principles

1. **Staging mirrors the pilot platform.** The pilot runs on ECS, so staging runs on ECS with the same task definitions, sized down. When production moves to EKS, staging moves first.
2. **`main` deploys to staging automatically; tags deploy to production** (architecture: Conventions).
3. **No real patient data in staging.** Synthetic tenants and contacts only, separate Exotel test numbers, separate AI provider keys with spend caps. This keeps staging out of DPDP scope for real data subjects.
4. **Everything in ap-south-1** (ADR 0004, 0007). Infrastructure as code with Terraform; no click-ops.
5. **No long-lived AWS keys.** GitHub Actions assumes an IAM role through OIDC.

## Accounts and Terraform layout

- AWS Organizations with separate accounts: `calling-agent-staging` and `calling-agent-prod` (blast-radius and cost isolation, clean IAM). A `shared` account is not needed yet.
- Terraform >= 1.10, state in S3 per account with native lockfile locking (`use_lockfile = true`), encrypted, versioned.

```
infra/terraform/
  modules/
    network/        # VPC, subnets, NAT, endpoints
    data/           # RDS, ElastiCache, S3 recordings bucket, KMS
    ecs-cluster/    # cluster, Cloud Map namespace, log groups
    ecs-service/    # one module, used for each app
    edge/           # ALBs, ACM, Route 53
    ci-oidc/        # GitHub OIDC provider + deploy role
  envs/
    staging/        # composes modules; staging sizes
    prod/           # later
```

## Network

| Item | Staging |
| --- | --- |
| VPC | `10.20.0.0/16`, 2 AZs (ap-south-1a, 1b) |
| Subnets | public (ALBs, NAT), private-app (ECS tasks), private-data (RDS, Redis) |
| NAT | one NAT gateway (single-AZ, cost); prod gets one per AZ |
| Endpoints | S3 gateway endpoint (free). Interface endpoints (ECR, Secrets Manager, Logs) deferred to prod |
| Security groups | ALB -> web/api/gateway only; gateway -> worker port; app SG -> RDS 5432 and Redis 6379 only |

## Services (ECS Fargate, arm64)

| Service | Size (vCPU/GB) | Tasks | Exposure |
| --- | --- | --- | --- |
| web (Next.js) | 0.25 / 0.5 | 1 | public ALB `app.staging.<domain>` |
| api (NestJS) | 0.5 / 1 | 1 | public ALB `api.staging.<domain>` (`/internal/*` blocked); internal `api.internal` via Cloud Map |
| voice-gateway (FastAPI) | 0.5 / 1 | 1 | public ALB `voice.staging.<domain>`, HTTPS + WSS for Exotel |
| voice-worker (Pipecat) | 1 / 2 | 1 | private only; reached by the gateway at task IP |
| postcall-worker | 0.5 / 1 | 1 | none (Redis Streams consumer) |
| scheduler (BullMQ) | 0.25 / 0.5 | 1 | none |

- `api.internal` matches the server URL in `docs/contracts/internal-api.openapi.yaml`, so the voice services need no special config.
- Voice Gateway ALB: idle timeout raised for long media WebSockets; Exotel webhook signatures verified in-app (architecture); optional IP allowlist for Exotel ranges.
- Worker routing: workers register capacity in Redis with their private task IP (architecture: "workers report capacity to Redis"). Infra only provides the network path.
- **Graceful drain:** Fargate kills a stopping task after at most 120 s, shorter than many calls. Plan: the Voice Worker turns on **ECS task scale-in protection** while it has active calls and turns it off when idle, so deployments and scale-in wait for calls to finish. Requested from chat 03 (see below).
- arm64 (Graviton) is about 20% cheaper; fall back to x86 per service if a dependency lacks arm64 wheels.

## Data

| Item | Staging |
| --- | --- |
| RDS PostgreSQL 16 | `db.t4g.micro`, single-AZ, 20 GB gp3, KMS-encrypted, 7-day backups, pgvector extension (confirm the RDS minor version ships pgvector 0.8) |
| ElastiCache Redis OSS 7.x | `cache.t4g.micro`, single node, TLS + AUTH, parameter group with `maxmemory-policy noeviction` (BullMQ). Node-based, not Serverless, because Serverless does not let us set the eviction policy |
| S3 recordings | `calling-agent-staging-recordings-<account>`; Block Public Access on; SSE-KMS; access only via signed expiring URLs; lifecycle: delete after 30 days in staging |
| Secrets | AWS Secrets Manager (the "managed vault"), injected through ECS `secrets`; non-secret config in SSM Parameter Store. Apps validate env at startup (architecture: Conventions) |

**Migrations** run as a one-off ECS task (`api` image, migrate command), triggered by a separate CI job that needs approval in the GitHub Environment `staging-migrations`, before the services roll. This is the "separate reviewed step" from the architecture.

## CI/CD to staging (next workflow, after CI)

On merge to `main`:

1. CI must be green (`CI OK`).
2. Build images only for changed apps; push to ECR with immutable tags (git SHA). ECR scan on push.
3. If the commit touches migrations: pause for approval, run the migration task.
4. Register new task definitions and update ECS services; wait for stability. Voice workers drain via task protection.
5. Smoke test: health endpoints, plus one scripted test call when the voice path exists.

Production (by tag, evaluation suite as a gate) reuses the same pipeline against the prod account.

## Observability (staging)

- Logs: JSON to CloudWatch Logs, 14-day retention, every line with `tenant_id` and `call_id` (architecture).
- Infra alarms (CloudWatch -> SNS -> email/Slack): ALB 5xx, unhealthy targets, ECS running task count, RDS CPU/storage/connections, Redis memory and connections, NAT errors.
- Traces, metrics and error tracking: **blocked on open decision 1.** Services emit OpenTelemetry (OTLP) either way, so the backend can be chosen without code changes. App alerts from the architecture (p95 latency over target, call failure rate, provider errors, worker capacity) are wired once the backend is chosen.

## Rough cost (always on)

Order of magnitude only; confirm in the AWS Pricing Calculator for ap-south-1.

| Item | Approx. USD / month |
| --- | --- |
| Fargate (about 3 vCPU, 6 GB, arm64) | 70-90 |
| ALB (shared, host-based routing) | 20-25 |
| NAT gateway + data | 35-50 |
| RDS t4g.micro + storage | 15-25 |
| ElastiCache t4g.micro | 12-18 |
| S3, CloudWatch, Secrets Manager, Route 53 | 10-20 |
| **Total** | **about 160-230** |

Scaling ECS services to zero outside working hours cuts the Fargate line by roughly 60%. Apply for AWS Activate credits (ADR 0007).

## Needs from other chats

| From | What |
| --- | --- |
| 01 Core API | A migrate command runnable as a one-off task; `/health` endpoint |
| 02 Voice Gateway | `/health`; reads worker capacity from Redis by private IP |
| 03 Voice Worker | Toggle ECS task scale-in protection around active calls; `SIGTERM` = stop taking new calls |
| All apps | Follow the CI contract in `infra/README.md`; Dockerfile-ready start command; config only via env vars |

## Open decisions (Master chat)

1. **Error tracking and telemetry vs. Indian-region hosting.** The architecture says "Sentry everywhere" and Grafana, while ADR 0004 says all services and data stay in India. Sentry's hosted service offers US and EU data regions; I am not aware of an India region (worth confirming). Stack traces and spans can carry phone numbers or transcript fragments. Options:
   - (a) Hosted Sentry and Grafana Cloud with strict PII scrubbing, recorded as an explicit ADR exception to 0004.
   - (b) Self-host in ap-south-1: a Sentry-compatible tracker (e.g. GlitchTip, which accepts Sentry SDKs) plus Grafana with Tempo/Loki/Prometheus.
   - (c) AWS-native in ap-south-1: CloudWatch + X-Ray via the ADOT collector, Grafana on top.
2. **When staging exists.** The infra table lists "staging environment" under the Production (EKS) stage, but CI and Conventions say `main` deploys to staging from the start. This plan assumes staging exists from the Pilot stage, on ECS. Please confirm and update the doc wording.
