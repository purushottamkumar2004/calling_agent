# infra

DevOps and infrastructure for the platform. Owned by chat **08 DevOps and Infrastructure**.
Source of truth: [`docs/architecture.md`](../docs/architecture.md) (Infrastructure and scaling; Observability).

| Path | What |
| --- | --- |
| [`docker/`](docker/README.md) | Local dev stack (Postgres + pgvector, Redis, MinIO; optional observability and ngrok) |
| [`terraform/`](terraform/README.md) | AWS ap-south-1 with OpenTofu (ADR 0012). Start with the [staging plan](terraform/staging-plan.md) |
| [`k8s/`](k8s/README.md) | Production on EKS (later) |
| [`scripts/`](scripts/) | CI helpers, e.g. `validate_contracts.py` |
| [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) | Lint, type-check, build, test (TypeScript + Python); contract, compose and OpenTofu checks |

## CI contract (ADR 0010)

CI discovers apps and calls only the standard task names, so adding an app never changes the pipeline.

**Every app** exposes `dev`, `build`, `test`, `lint`, `typecheck`, `format`. From the repo root: `make <task> APP=<app>` (e.g. `make test APP=api`). CI runs `lint`, `typecheck`, `build`, `test`.

**Versions** are pinned in `.nvmrc` (Node 24), `.python-version` (3.12) and `packageManager` (pnpm). Owned by chat 08.

**Node apps** (listed in `pnpm-workspace.yaml`): define the tasks as `package.json` scripts; commit `pnpm-lock.yaml`. Integration tests get:

| Var | Value in CI |
| --- | --- |
| `TEST_DATABASE_URL` | Postgres 16 + pgvector, database `calling_agent_test`, owned by `calling_agent`, which is **not** a superuser (as on RDS) but has `CREATEROLE` |
| `TEST_REDIS_URL` | `redis://localhost:6379/15` |

**Python apps** (`apps/*` or `packages/*` with a `pyproject.toml`): uv with a committed `uv.lock`; `ruff`, `mypy`, `pytest` in the `dev` dependency group. The root `Makefile` provides `lint` (ruff check + format check), `typecheck` (mypy), `test` (pytest; "no tests" passes), `build` (lock check + compile), `format`. Override any task, and define `dev`, with a `Makefile` in the app. Tests get `REDIS_URL` (db 15).

**Telemetry scrubbing (ADR 0009)**: the scrubber tests in `packages/py-common` and `packages/shared-types` run as normal `test` tasks, so they gate every PR once those packages exist.

**Contracts**: every PR validates `docs/contracts` (schemas compile, OpenAPI 3.1 valid, examples match). Locally: `pnpm contracts:check`.

**Branch protection**: require the single `CI OK` check on `main`.
