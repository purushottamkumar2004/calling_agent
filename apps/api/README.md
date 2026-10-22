# apps/api: Core API

NestJS + TypeScript (strict). Auth, tenants, scheduling. The only service that writes business data.
Postgres with row-level security on `tenant_id`.

Owned by chat **01 Core API and Database**. Source of truth: [`docs/architecture.md`](../../docs/architecture.md)
and the frozen contracts in [`docs/contracts/`](../../docs/contracts/).

## Status

| Area                                                                                                                               | State                  |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Schema + migrations (tenants, users, auth, locations, providers, slots, contacts, calls, appointments, idempotency, outbox, audit) | done                   |
| Tenant isolation: RLS on every tenant table, service connects as a non-owner role                                                  | done                   |
| Dashboard auth: login, rotating refresh tokens with reuse detection, logout, RBAC                                                  | done                   |
| Internal API: service JWT + `X-Tenant-Id`/`X-Call-Id` with call-ownership check                                                    | done                   |
| `GET /availability`, `GET/POST /appointments`, `POST .../reschedule`, `POST .../cancel`                                            | done, contract-tested  |
| `appointment.booked` v1 via transactional outbox → Redis Stream `events:appointment`                                               | done, schema-validated |
| Dashboard slots and appointments API (`/v1/...`)                                                                                   | done                   |
| `POST /calls`, `/calls/{id}/transfer`, `/contacts/lookup`, `/knowledge/search`, `call.ended` ingestion                             | next                   |

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

| Script                                      |                                                              |
| ------------------------------------------- | ------------------------------------------------------------ |
| `pnpm test`                                 | unit + integration (integration needs Postgres and Redis)    |
| `pnpm test:unit` / `pnpm test:integration`  | one project only                                             |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | CI gates                                                     |
| `pnpm contracts:gen`                        | regenerate `src/contracts/generated/` from `docs/contracts/` |
| `pnpm db:migrate:create <name>`             | new SQL migration                                            |

Integration tests use `TEST_DATABASE_URL` (default `postgresql://calling_agent:change_me@localhost:5432/calling_agent_test`),
a disposable database whose owner is **not** a superuser (as on RDS and in CI). Each run removes everything the owner
owns (`DROP OWNED BY CURRENT_USER`) and re-applies the migrations; superuser-installed extensions such as `vector`
are left in place. Redis tests use `TEST_REDIS_URL` (default db 15).

## Migrations in production

The image runs migrations itself; there is no tsx and no `.env` file in production.

```bash
node dist/scripts/migrate.js            # apply all pending migrations (what staging runs)
node dist/scripts/migrate.js down 1     # roll back the last migration (operators only, by hand)
```

|              |                                                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input        | `MIGRATION_DATABASE_URL` from the process environment only (schema owner, from Secrets Manager). `MIGRATION_LOCK_TIMEOUT_SEC` optional, default 600. Nothing else is read.                                                 |
| Exit code    | `0` on success, including "schema already up to date"; `1` on any failure (bad config, unreachable database, failed SQL, lock timeout).                                                                                    |
| Re-runs      | Safe. Applied migrations are recorded in `pgmigrations`; a re-run applies nothing and exits 0.                                                                                                                             |
| Concurrency  | Safe. The run holds a Postgres advisory lock; a second task waits for it (logging `waiting for another migration run to finish`), then finds nothing to do. It gives up with exit 1 after `MIGRATION_LOCK_TIMEOUT_SEC`.    |
| Atomicity    | All pending migrations run in one transaction: on failure nothing is applied.                                                                                                                                              |
| Logs         | One JSON object per line (`service: "core-api-migrate"`, `message`, `applied`, `applied_count`, `duration_ms`, `db_host`, `db_name`). The URL and password are never logged.                                               |
| Image layout | `apps/api/dist/scripts/migrate.js` must sit next to `apps/api/migrations/*.sql` (the script resolves `../../migrations`). `node-pg-migrate` and `pg` are runtime dependencies, so a production-only install includes them. |

Staging runs it as a one-off ECS task, from the same image as the service, before each deploy:
command `["node", "dist/scripts/migrate.js"]` with `MIGRATION_DATABASE_URL` injected as a secret. The service task
definition must never receive `MIGRATION_DATABASE_URL`, only `DATABASE_URL` (the RLS-bound role). Deploy only if
the task exits 0.

## Design

### Two database roles

| Role                                     | Used by                     | Can                                            |
| ---------------------------------------- | --------------------------- | ---------------------------------------------- |
| Schema owner (`MIGRATION_DATABASE_URL`)  | migrations, seed, operators | everything; never given to the running service |
| Login role in `api_app` (`DATABASE_URL`) | the running API             | DML on tenant tables, always under RLS         |

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
  Confirmed by ADR 0011, which also requires one secret per issuer and a `jti` claim (not yet implemented; next task)
  and ES256 per-service keys before staging.
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
`envelope` (JSON), as fixed by ADR 0011. Delivery is at-least-once; consumers dedupe on
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
