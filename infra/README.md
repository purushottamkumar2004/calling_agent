# infra

DevOps and infrastructure for the platform. Owned by chat **08 DevOps and Infrastructure**.
Source of truth: [`docs/architecture.md`](../docs/architecture.md) (Infrastructure and scaling; Observability).

| Path | What |
| --- | --- |
| [`docker/`](docker/README.md) | Local dev stack (Postgres + pgvector, Redis, MinIO; optional observability and ngrok) |
| [`terraform/`](terraform/README.md) | AWS ap-south-1. Start with the [staging plan](terraform/staging-plan.md) |
| [`k8s/`](k8s/README.md) | Production on EKS (later) |
| [`scripts/`](scripts/) | CI helpers, e.g. `validate_contracts.py` |
| [`../.github/workflows/ci.yml`](../.github/workflows/ci.yml) | Lint, type-check, test (TypeScript + Python), contract and compose checks |

## CI contract

The CI workflow discovers projects instead of hard-coding them, so module chats only need to follow these rules for their code to be checked automatically.

**TypeScript** (anything in `pnpm-workspace.yaml`)

- Commit `pnpm-lock.yaml` at the repo root. Until it exists, TypeScript jobs are skipped.
- Define whichever of these scripts apply: `lint`, `typecheck` (`tsc --noEmit`), `test`. Missing scripts are skipped, failing ones fail CI.
- Node 24 LTS. Tests get `DATABASE_URL` (Postgres 16 + pgvector, database `calling_agent_test`) and `REDIS_URL`, for Core API integration tests against real Postgres.

**Python** (`apps/*` or `packages/*` containing a `pyproject.toml`)

- Managed with [uv](https://docs.astral.sh/uv/); commit `uv.lock`. Python 3.12.
- `ruff`, `mypy` and `pytest` in the `dev` dependency group; CI runs `ruff check .`, `ruff format --check .`, `mypy .`, `pytest` from the project directory.
- Depend on `packages/py-common` as a path dependency (or join a root uv workspace; CI handles both).
- Tests get `REDIS_URL`. "No tests collected" passes while a project is new.

**Contracts**: every PR validates `docs/contracts` (schemas compile, OpenAPI 3.1 valid, examples match). Run locally with `pnpm contracts:check`.

**Branch protection**: require the single `CI OK` check on `main`.
