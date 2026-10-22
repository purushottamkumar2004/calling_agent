# 0010: Staging timing and toolchain conventions
Date: 2026-10-22
Status: Accepted

## Staging environment
Staging is created in the **Pilot** stage, and must be live before the first clinic is onboarded (end of Phase 2). Phases 1-2 run locally plus CI only. Staging mirrors the pilot setup (ECS in ap-south-1) at minimum size and scales to zero outside working hours. `main` deploys to staging from then on; production deploys by tag.

## Toolchain
- Python 3.12, managed with **uv** (`pyproject.toml` + `uv.lock` per Python app).
- Node 24 LTS, **pnpm** workspaces, TypeScript strict.
- Every app exposes the same task names, whatever the language: `dev`, `build`, `test`, `lint`, `typecheck`, `format`.
  - Node apps: `package.json` scripts with those names.
  - Python apps: run through `uv run` behind the same names (root `Makefile`: `make <task> APP=<app>`).
- CI calls only these task names, so adding an app never changes the pipeline.

## Consequences
Version pins live in `.nvmrc`, `.python-version` and `packageManager`; Chat 08 owns them.
