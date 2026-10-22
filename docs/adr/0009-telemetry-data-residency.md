# 0009: Telemetry and error tracking under India-only hosting
Date: 2026-10-22
Status: Accepted (amends 0004)

## Context
ADR 0004 keeps all services and data in India. Hosted error trackers (e.g. Sentry SaaS) store events outside India, and error payloads can leak personal data (phones, transcripts, request bodies).

## Decision
- Logs, metrics and traces stay in ap-south-1: OpenTelemetry collector plus a self-hosted or AWS-managed backend in Mumbai (Grafana/Loki/Tempo or CloudWatch).
- Hosted error tracking (Sentry SaaS) is allowed for stack traces only, with mandatory scrubbing: `send_default_pii=false`, no request or response bodies, no transcripts, no phone numbers, no recording keys. Only opaque IDs (`tenant_id`, `call_id`, `agent_version`) and code context leave India.
- A shared scrubber lives in `packages/py-common` and `packages/shared-types`; a CI test asserts that a sample event with a phone number and transcript is scrubbed.
- If a pilot clinic contract or legal review requires it, switch to self-hosted Sentry in ap-south-1 with no code change beyond the DSN.

## Alternatives considered
Self-hosted Sentry from day one (heavy to operate for one developer); no error tracker (too blind for live calls).

## Consequences
Confirm with a lawyer before the pilot that scrubbed, ID-only error events abroad are acceptable under DPDP.
