# Staging on AWS ap-south-1: plan

Status: **Accepted direction** (chat 08). Follows `docs/architecture.md` and ADRs 0004, 0006, 0007, 0009 (telemetry residency), 0010 (staging timing, toolchain) and 0012 (OpenTofu, 90-day recording ceiling).

**When:** staging is built in the Pilot stage and must be live before the first clinic is onboarded (end of Phase 2). Phases 1-2 run locally plus CI only (ADR 0010).

## Principles

1. **Staging mirrors the pilot platform.** The pilot runs on ECS, so staging runs on ECS with the same task definitions, at minimum size, scaled to zero outside working hours. When production moves to EKS, staging moves first.
2. **`main` deploys to staging automatically; tags deploy to production** (architecture: Conventions).
3. **No real patient data in staging.** Synthetic tenants and contacts only, separate Exotel test numbers, separate AI provider keys with spend caps. This keeps staging out of DPDP scope for real data subjects.
4. **Everything in ap-south-1** (ADR 0004, 0007). Infrastructure as code with OpenTofu (ADR 0012); no click-ops.
5. **No long-lived AWS keys.** GitHub Actions assumes an IAM role through OIDC.

## Accounts and Terraform layout

- AWS Organizations with separate accounts: `calling-agent-staging` and `calling-agent-prod` (blast-radius and cost isolation, clean IAM). A `shared` account is not needed yet.
- OpenTofu 1.12.9 (pinned, ADR 0012), state in S3 per account with native lockfile locking (`use_lockfile = true`), encrypted, versioned.

```
infra/terraform/
  bootstrap/        # state bucket, once per account   (written)
  modules/
    network/        # VPC, subnets, NAT, endpoints      (written)
    data/           # RDS, ElastiCache, S3 recordings bucket, KMS   (written)
    ecs-cluster/    # cluster, Cloud Map namespace      (written)
    ecs-service/    # one module, used for each app     (written)
    edge/           # ALB, ACM, Route 53                (written)
    ecr/            # one repository per app            (written)
    github-oidc/    # GitHub OIDC provider + deploy role   (written)
  envs/
    staging/        # composes modules; staging sizes  (all layers written, plan only)
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
| RDS PostgreSQL 16 | `db.t4g.micro`, single-AZ, 20 GB gp3, KMS-encrypted, 7-day backups, pgvector extension (confirm the RDS minor version ships pgvector 0.8). The master user (non-superuser, `CREATEROLE`) owns the schema and runs migrations; Terraform creates the service login role in `api_app` with its password in Secrets Manager (same model as local dev and CI) |
| ElastiCache Redis OSS 7.x | `cache.t4g.micro`, single node, TLS + AUTH, parameter group with `maxmemory-policy noeviction` (BullMQ). Node-based, not Serverless, because Serverless does not let us set the eviction policy |
| S3 recordings | `calling-agent-staging-recordings-<account>`; Block Public Access on; SSE-KMS; access only via signed expiring URLs; lifecycle: delete after 90 days, the platform ceiling (ADR 0012) |
| Secrets | AWS Secrets Manager (the "managed vault"), injected through ECS `secrets`; non-secret config in SSM Parameter Store. Apps validate env at startup (architecture: Conventions) |

**Migrations** run as a one-off ECS task (`api` image, command `node dist/scripts/migrate.js`, reading `MIGRATION_DATABASE_URL` from the owner secret), triggered by a separate CI job that needs approval in the GitHub Environment `staging-migrations`, before the services roll. This is the "separate reviewed step" from the architecture.

## CI/CD to staging (next workflow, after CI)

On merge to `main`:

1. CI must be green (`CI OK`).
2. Build images only for changed apps; push to ECR with immutable tags (git SHA). ECR scan on push.
3. If the commit touches migrations: pause for approval, run the migration task.
4. Register new task definitions and update ECS services; wait for stability. Voice workers drain via task protection.
5. Smoke test: health endpoints, plus one scripted test call when the voice path exists.

Production (by tag, evaluation suite as a gate) reuses the same pipeline against the prod account.

## Observability (staging, ADR 0009)

- Logs, metrics and traces stay in ap-south-1. Services emit OpenTelemetry (OTLP) to an ADOT/OTel collector sidecar per task.
- Backend in Mumbai. Recommended for staging: CloudWatch Logs (JSON, 14-day retention, every line with `tenant_id` and `call_id`) plus X-Ray traces and CloudWatch metrics through the collector, with Grafana on top for dashboards. A self-hosted Grafana/Loki/Tempo stack stays an option if CloudWatch costs or query limits bite; switching is a collector config change.
- Error tracking: hosted Sentry for stack traces only, with mandatory scrubbing (`send_default_pii=false`; no bodies, transcripts, phones or recording keys; only `tenant_id`, `call_id`, `agent_version`). DSN in Secrets Manager. Moving to self-hosted Sentry in ap-south-1 is a DSN change.
- One shared ADOT collector service (`otel.internal`, pinned image) instead of a sidecar per task: traces to X-Ray, metrics to CloudWatch via EMF (`CallingAgent/staging`).
- Infra alarms written (CloudWatch -> SNS, optional email): ALB 5xx, per-service target 5xx and unhealthy targets, Postgres CPU/storage/memory, Redis memory (critical with `noeviction`). Missing data is not an alarm for services (they scale to zero at night) but is for Postgres and Redis.
- App alerts from the architecture: p95 turn latency over target, call failure rate, provider errors, worker capacity.
- Before the pilot: legal confirmation that scrubbed, ID-only error events abroad are acceptable under DPDP (ADR 0009 consequence).

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
| 01 Core API | Done: `node dist/scripts/migrate.js` (infra provides `MIGRATION_DATABASE_URL` from the owner secret's `url` key). Still needed: ES256 verification reading `SERVICE_JWT_PUBLIC_KEYS` (provisional name); a production-safe version of `db:setup-local-role` for the one-off app-login role task; `S3_BUCKET` for signed recording URLs |
| 02 Voice Gateway | `/health` on port 8000; reads worker capacity from Redis by private IP; signs service JWTs with `SERVICE_JWT_PRIVATE_KEY` (ES256) |
| 03 Voice Worker | Listen on 8080 for the gateway (ASSUMED); toggle ECS task scale-in protection around active calls; `SIGTERM` = stop taking new calls; confirm provider key names (`SARVAM_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `LLM_API_KEY`) |
| All apps | Follow the CI contract in `infra/README.md`; Dockerfile-ready start command; config only via env vars. In AWS: Postgres needs `sslmode=require`, Redis URLs are `rediss://` (TLS + AUTH) |
