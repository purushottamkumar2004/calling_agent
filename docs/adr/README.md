# Architecture Decision Records

One file per decision, numbered in order. Decided in the Master chat, then recorded here.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-clinics-first-vertical.md) | Clinics as first vertical; sector-agnostic engine | Accepted |
| [0002](0002-python-voice-node-business.md) | Python (Pipecat) for voice, Node/TypeScript for business services | Accepted |
| [0003](0003-postgres-over-mongodb.md) | Postgres over MongoDB for business data | Accepted |
| [0004](0004-india-hosting.md) | Indian-region hosting and telephony | Accepted |
| [0005](0005-mvp-languages.md) | MVP languages: English and Hindi | Accepted |
| [0006](0006-telephony-exotel.md) | Telephony: Exotel, Plivo fallback | Accepted |
| [0007](0007-cloud-aws-mumbai.md) | Cloud: AWS ap-south-1 | Accepted |
| [0008](0008-service-contracts-v1.md) | Service contracts v1 | Accepted |
| [0009](0009-telemetry-data-residency.md) | Telemetry and error tracking under India-only hosting | Accepted |
| [0010](0010-staging-and-toolchain-conventions.md) | Staging timing and toolchain conventions | Accepted |
| [0011](0011-cross-service-conventions.md) | Cross-service conventions: service JWT, stream field, appointment events, env naming | Accepted |
| [0012](0012-iac-tool-and-recording-retention.md) | OpenTofu everywhere; recording retention ceiling 90 days | Accepted |
| [0013](0013-runtime-conventions.md) | Runtime conventions: ports, health checks, env names, ES256 service keys | Accepted |

## Template

```
# NNNN: Title
Date: YYYY-MM-DD
Status: Proposed | Accepted | Superseded by NNNN

## Context
## Decision
## Alternatives considered
## Consequences
```
