# 0013: Runtime conventions (ports, health checks, env names, service keys)
Date: 2026-10-22
Status: Accepted (raised by Chat 08 while building the staging compute layer; extends ADR 0011)

## 1. Ports
| App | Port | Notes |
| --- | --- | --- |
| api | 4000 | `CORE_API_URL=http://api.internal:4000` |
| web | 3000 | |
| voice-gateway | 8000 | public via ALB (webhooks + media WebSocket) |
| voice-worker | 8080 | internal only |
| postcall-worker | 8090 | health endpoints only |
| scheduler | 4100 | health endpoints only |

Ports are fixed in task definitions and local dev; override only with `PORT`.

## 2. Health checks (every app)
- `GET /healthz`: liveness, no dependencies checked, always fast.
- `GET /readyz`: readiness, checks the app's own dependencies (DB, Redis, Core API reachability). ALB and ECS use `/readyz`.
- Neither endpoint requires auth or returns personal data. `/` is never a health path.

## 3. Environment variable names (in addition to ADR 0011 section 5)
- Telephony: `EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_SUBDOMAIN`; later `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`.
- AI providers: `SARVAM_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `LLM_API_KEY`.
- Object storage: `S3_BUCKET` (recordings), `S3_ENDPOINT` set only locally (MinIO), `AWS_REGION`.
- Telemetry: `OTEL_EXPORTER_OTLP_ENDPOINT` (staging `http://otel.internal:4317`), `SENTRY_DSN` optional (ADR 0009).

## 4. Service JWT keys (ES256, from ADR 0011)
- Issuers (voice-gateway, voice-worker, scheduler, postcall-worker): `SERVICE_JWT_PRIVATE_KEY` = PKCS8 PEM; `SERVICE_JWT_ISSUER` = service name.
- Core API: `SERVICE_JWT_PUBLIC_KEYS` = JSON object mapping issuer to an **array** of SPKI PEMs. The array allows key rotation with overlap: add the new key, roll the issuer, then remove the old key.
- JWT header `kid` = `{issuer}:{key-fingerprint}`; the Core API picks the key by `kid`.
- HS256 (`SERVICE_JWT_SECRETS`) stays for local dev and CI only; staging and production reject HS256.

## 5. Database owner secret rotation
Staging accepts a generated owner password with manual rotation, exposed as a `url` field for `MIGRATION_DATABASE_URL`. Before production, rotation must be automated (Secrets Manager rotation or IAM database authentication). Tracked as an open item in the roadmap.
