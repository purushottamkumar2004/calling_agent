# 0011: Cross-service conventions (auth, streams, appointment events, env)
Date: 2026-10-22
Status: Accepted (raised by Chat 01)

## 1. Service JWT
- Phases 1-2 (local + CI): **HS256**, as implemented in `apps/api`. Claims: `iss` (service name, must be in the allow-list), `aud = "core-api"`, `iat`, `exp`, `jti`. Lifetime at most 300 s. Tenant is never in the token; it comes from `X-Tenant-Id` and is checked against call ownership.
- **One secret per issuer** (`SERVICE_JWT_SECRETS` = map of `iss` to secret), so a leaked worker secret cannot mint tokens for another service.
- **Before staging (Pilot stage, ADR 0010):** move to **ES256** with one key pair per service; Core API verifies with public keys only. Private keys live in AWS Secrets Manager.

## 2. Redis Stream entries
Each entry has exactly one field, **`envelope`**, holding the JSON-serialized event envelope. Streams are `events:{domain}`, trimmed with approximate `MAXLEN`. Producers write through a transactional outbox (as the Core API does); consumers dedupe on `event_id` and use consumer groups.

## 3. Appointment lifecycle events
Add `appointment.rescheduled` v1 and `appointment.cancelled` v1 (schemas in `docs/contracts/events/`), both on `events:appointment`, emitted from the same outbox transaction as the change. The Scheduler needs them to cancel and re-create reminders. This is an additive contract change; v1 of the existing contracts is unchanged.

## 4. Slot carries tenant_id
`Slot` has `tenant_id` with a composite foreign key `(tenant_id, slot_id)` from appointments, so RLS applies directly to slots. Data model docs updated.

## 5. Environment variable naming
- Each app reads its own `apps/<app>/.env`. Variables are **unprefixed** inside an app: `DATABASE_URL` (RLS-bound runtime role), `MIGRATION_DATABASE_URL` (schema owner, never given to the running service), `REDIS_URL`.
- Only URLs that point at **another** service are prefixed by that service: `CORE_API_URL`, `VOICE_GATEWAY_URL`.
- The root `.env.example` is for `infra/docker` only. No `CORE_API_DATABASE_URL`.
