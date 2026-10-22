# apps/api: Core API

NestJS + TypeScript. Auth, tenants, agents, appointments, slots, campaigns, billing. The only service that writes business data. Postgres with row-level security on `tenant_id`.

Owned by chat **01 Core API and Database**.
First task: schema + migrations, tenant/auth, appointments and slots API.
