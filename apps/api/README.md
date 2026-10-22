# apps/api: Core API

NestJS + TypeScript (strict). Auth, tenants, scheduling. The only service that writes business data.
Postgres with row-level security on `tenant_id`.

Owned by chat **01 Core API and Database**. Source of truth: [`docs/architecture.md`](../../docs/architecture.md)
and the frozen contracts in [`docs/contracts/`](../../docs/contracts/).

## Status

| Area | State |
| --- | --- |
| Schema + migrations (tenants, users, auth, locations, providers, slots, contacts, calls, appointments, idempotency, outbox, audit) | done |
| Tenant isolation: RLS on every tenant table, service connects as a non-owner role | done |
| Dashboard auth: login, rotating refresh tokens with reuse detection, logout, RBAC | done |
| Internal API: service JWT + `X-Tenant-Id`/`X-Call-Id` with call-ownership check | done |
| `GET /availability`, `GET/POST /appointments`, `POST .../reschedule`, `POST .../cancel` | done, contract-tested |
| `appointment.booked` v1 via transactional outbox → Redis Stream `events:appointment` | done, schema-validated |
| Dashboard slots and appointments API (`/v1/...`) | done |
| `POST /calls`, `/calls/{id}/transfer`, `/contacts/lookup`, `/knowledge/search`, `call.ended` ingestion | next |

## Run locally

```bash
# repo root
cp .env.example .env && pnpm infra:up           # Postgres (pgvector), Redis, MinIO
cd apps/api
cp .env.example .env                            # fill the four secrets: openssl rand -base64 32
pnpm install
pnpm db:migrate                                 # as the schema owner
pnpm db:setup-local-role                        # creates the RLS-bound login role from DATABASE_URL
SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD='at-least-12-chars' pnpm seed
pnpm dev                                        # http://localhost:4000
```

| Script | |
| --- | --- |
| `pnpm test` | unit + integration (integration needs Postgres and Redis) |
| `pnpm test:unit` / `pnpm test:integration` | one project only |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | CI gates |
| `pnpm contracts:gen` | regenerate `src/contracts/generated/` from `docs/contracts/` |
| `pnpm db:migrate:create <name>` | new SQL migration |

Integration tests use `TEST_DATABASE_URL` (default `postgresql://calling_agent:change_me@localhost:5432/calling_agent_test`),
which must be a disposable database whose owner is **not** a superuser (as on RDS). Each run drops and recreates its schema.
Redis tests use `TEST_REDIS_URL` (default db 15).

## Design

### Two database roles

| Role | Used by | Can |
| --- | --- | --- |
| Schema owner (`MIGRATION_DATABASE_URL`) | migrations, seed, operators | everything; never given to the running service |
| Login role in `api_app` (`DATABASE_URL`) | the running API | DML on tenant tables, always under RLS |

Every request runs in one transaction that starts with `set_config('app.tenant_id', $tenant, true)`.
With no tenant bound, every policy is false and nothing is visible. The binding is transaction-local, so pooled
connections cannot leak it. The few cross-tenant reads (login by email, refresh-token lookup, resource ownership,
outbox relay) are `SECURITY DEFINER` functions that return the minimum needed.

### Double-booking protection

1. **Slot claim**: `UPDATE slots SET status='booked' WHERE id=$1 AND status='open' AND starts_at > now()`.
   Row locking serialises concurrent claimers; losers see zero rows and get `SLOT_TAKEN` with alternatives.
2. **Partial unique index**: at most one `booked`/`rescheduled` appointment per slot, whatever the app does.
3. **Exclusion constraint**: a provider can never have overlapping slots (`tstzrange` + `btree_gist`).
4. **Idempotency**: the `Idempotency-Key` row is written first in the same transaction; concurrent duplicates block
   on it and then replay the stored response (`Idempotent-Replayed: true`). Only successes are stored.

Tested with 25 concurrent callers on one slot (exactly one 201, 24 × 409) and concurrent reschedules into one slot.

### Internal API (`/internal/v1`, contract v1)

- `Authorization: Bearer <service JWT>`: HS256 with `SERVICE_JWT_SECRET`; `iss` in `SERVICE_JWT_ALLOWED_ISSUERS`,
  `aud = "core-api"`, `iat` and `exp` required, lifetime at most `SERVICE_JWT_MAX_TTL_SEC` (300 s).
  **Pending Master-chat confirmation** (the contract does not define token claims or signing).
- `X-Tenant-Id` and `X-Call-Id` required; the call must belong to the tenant, otherwise `403 TENANT_MISMATCH`
  (unknown calls get the same answer, so there is no existence oracle).
- Another tenant's slot/appointment/contact/provider gives `TENANT_MISMATCH`; truly missing gives `NOT_FOUND`.
  Dashboard users always get `NOT_FOUND` for both.
- Errors are always `{"error": {"code", "message", "details"}}` with the contract codes.
- Policy: `tenants.settings.cancel_cutoff_minutes` and `reschedule_cutoff_minutes` (default 0) give `POLICY_BLOCKED`.
  Past appointments can never be changed.
- `OUTSIDE_HOURS` is returned only when no slot is open **and** the requested window misses the opening hours of
  every matching location; a full-but-open window returns `200` with an empty list.
- Reschedule keeps the same `appointment_id`, moves it to the new slot, sets status `rescheduled` and frees the old slot.

### Events

`appointment.booked` v1 is validated against the frozen envelope and payload schemas, then written to the
`outbox` table in the booking transaction and relayed to Redis Stream `events:appointment` as a single entry field
`envelope` (JSON; field name **pending Master-chat confirmation**). Delivery is at-least-once; consumers dedupe on
`event_id`. The relay runs in every replica (`FOR UPDATE SKIP LOCKED`).

### Security notes

- Phone numbers: AES-256-GCM with a key-id prefix (rotation-ready) plus an HMAC-SHA256 lookup hash. Never logged.
- Passwords: argon2id (OWASP parameters); unknown emails cost the same as wrong passwords.
- Refresh tokens are opaque, stored as SHA-256, rotated on use; replaying a used token revokes all the user's sessions.
- Login and refresh are rate-limited per IP.
- Every write records an `audit_log` row with actor, tenant and `call_id`.

### Logging

Pino JSON. Every line has `service`, `request_id` and, once known, `tenant_id` and `call_id`
(`X-Request-Id` is accepted and echoed). Authorization headers, phones, passwords and tokens are redacted.
