# infra/docker: local development

Run everything from the **repo root** (the scripts pass `--env-file .env`, so your root `.env` is used).

```bash
cp .env.example .env
pnpm infra:up       # Postgres 16 + pgvector, Redis, MinIO; creates the recordings bucket
pnpm infra:obs      # optional: OTLP collector + Grafana on http://localhost:3001
pnpm infra:tunnel   # optional: ngrok -> Voice Gateway on :8000 (needs NGROK_AUTHTOKEN)
pnpm infra:down     # stop (keeps data)
pnpm infra:reset    # stop and delete all local data
```

| Service | Address | Notes |
| --- | --- | --- |
| Postgres | `localhost:5432` | DBs `calling_agent` and `calling_agent_test`, both with `vector` enabled |
| Redis | `localhost:6379` | AOF on, `maxmemory-policy noeviction` (required by BullMQ) |
| MinIO | API `localhost:9000`, console `localhost:9001` | Bucket `$S3_BUCKET` created by `minio-init` |
| Grafana (obs) | `localhost:3001` | Tempo, Loki, Prometheus pre-wired; send OTLP to `localhost:4317/4318` |
| ngrok (tunnel) | inspector `localhost:4040` | Copy the public URL into the Exotel applet (use `wss://` for the media stream) |

Ports bind to `127.0.0.1` only.

Notes

- Postgres init scripts in `postgres/init/` run only on an empty volume. After changing them: `pnpm infra:reset`.
- Schema, roles and RLS policies belong to the Core API migrations, not this folder.
- MinIO no longer publishes community images, so the stack uses Chainguard's free MinIO build. If it fails to start on your machine, tell chat 08.
- App services (api, web, voice-gateway, ...) run on the host for now. Each gets a Dockerfile here once its module chat has a runnable app; that is also what CI will build for staging.
