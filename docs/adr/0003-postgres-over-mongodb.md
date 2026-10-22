# 0003: Postgres over MongoDB for business data
Date: 2026-10-22
Status: Accepted

## Context
Appointments, slots and billing are relational and must not double-book.

## Decision
PostgreSQL with row-level security on `tenant_id`, and pgvector for knowledge-base embeddings.

## Alternatives considered
MongoDB (team familiarity); separate vector database.

## Consequences
Transactions and unique constraints prevent double-booking. MongoDB remains an option for raw transcripts at high volume.
