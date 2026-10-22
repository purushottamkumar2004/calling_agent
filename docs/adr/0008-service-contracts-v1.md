# 0008: Service contracts v1
Date: 2026-10-22
Status: Accepted

## Context
Core API (Chat 01) and Voice Worker (Chat 03) must be built in parallel without changing each other's interfaces.

## Decision
Freeze v1 contracts in `docs/contracts/`: an internal REST tool API (OpenAPI), a common event envelope on Redis Streams, the `call.ended` and `appointment.booked` v1 schemas, and the agent config v1 schema. Service JWT plus `X-Tenant-Id` and `X-Call-Id` headers; `Idempotency-Key` on every write; stable error codes.

## Alternatives considered
gRPC between services (faster, but more tooling for a small team); Voice Worker reading Postgres directly (breaks the single-writer rule); Kafka instead of Redis Streams (heavier than needed for the pilot).

## Consequences
Breaking changes need a v2 and a new ADR. Both Python and TypeScript generate types from these files.
