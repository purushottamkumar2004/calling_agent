# 0002: Python (Pipecat) for voice, Node/TypeScript for business services
Date: 2026-10-22
Status: Accepted

## Context
Voice AI tooling is strongest in Python; the team's main strength is MERN/TypeScript.

## Decision
Voice Gateway, Voice Worker and Post-call Worker in Python. Core API, Scheduler and Dashboard in TypeScript.

## Alternatives considered
All-Python; all-Node with a Node voice framework.

## Consequences
Two toolchains in one monorepo. Contracts between them are OpenAPI and versioned event schemas.
