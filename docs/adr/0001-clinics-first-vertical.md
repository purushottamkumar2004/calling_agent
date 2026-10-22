# 0001: Clinics as first vertical; sector-agnostic engine
Date: 2026-10-22
Status: Accepted

## Context
A general-purpose calling agent is hard to sell and hard to evaluate.

## Decision
Launch with clinics (inbound booking, reminders, follow-ups). Keep the engine sector-agnostic; verticals are templates in `packages/agent-templates`.

## Alternatives considered
General platform from day one; real estate first.

## Consequences
Clear MVP and pilot customers. Clinic-specific logic must stay in templates and tools, not in the core runtime.
