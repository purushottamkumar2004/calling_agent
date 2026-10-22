# calling_agent

AI voice calling agent platform: a multi-tenant SaaS that gives businesses an AI agent that answers and makes phone calls in English and Hindi (including Hinglish). Clinics are the first vertical; the core engine is sector-agnostic.

> Source of truth: [`docs/architecture.md`](docs/architecture.md). Decisions: [`docs/adr/`](docs/adr/).

## Repository layout

```
calling_agent/
  apps/
    web/               # Next.js clinic dashboard
    api/               # NestJS Core API (only writer of business data)
    voice-gateway/     # FastAPI: Exotel webhooks + media WebSockets
    voice-worker/      # Pipecat live call runtime (VAD, STT, LLM, TTS)
    postcall-worker/   # Summaries, outcome tags, analytics
    scheduler/         # BullMQ campaigns, WhatsApp/SMS notifications
  packages/
    shared-types/      # TS types + generated OpenAPI client
    agent-templates/   # Prompts + tool specs per vertical
    py-common/         # Python config, logging, Core API client
  infra/
    docker/            # Dockerfiles + docker-compose for local dev
    terraform/         # AWS (ap-south-1) resources
    k8s/               # Kubernetes manifests / Helm charts
  docs/
    architecture.md    # Master architecture (exported from the Claude Doc)
    adr/               # Architecture decision records
```

## Stack at a glance

| Layer | Choice |
| --- | --- |
| Telephony | Exotel (Plivo fallback) |
| Voice runtime | Python, Pipecat |
| STT / TTS | Sarvam (Hindi, Hinglish), Deepgram / ElevenLabs (English) |
| Business services | Node.js, TypeScript, NestJS, BullMQ |
| Dashboard | Next.js, TypeScript |
| Data | PostgreSQL + pgvector, Redis, S3 |
| Cloud | AWS Mumbai (ap-south-1) |

## Local development

```bash
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up -d   # Postgres, Redis, MinIO
```

Each app has its own README with run instructions once it is built.

## Working agreement

- Architecture changes are decided in the Master chat and recorded as an ADR before code changes.
- One module chat per folder in `apps/` and `packages/`.
- Conventional commits; `main` deploys to staging, tags deploy to production.
