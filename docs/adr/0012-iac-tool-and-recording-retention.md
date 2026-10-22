# 0012: IaC tool and recording retention
Date: 2026-10-22
Status: Accepted (raised in review of Chat 08's staging skeleton)

## 1. Infrastructure as code: OpenTofu everywhere
### Context
The staging skeleton was verified with OpenTofu, while CI ran Terraform 1.12. The two resolve providers from different registries, so the provider lock file and state handling would diverge on the first real apply.

### Decision
Use **OpenTofu** locally, in CI (`opentofu/setup-opentofu`) and for applies, with a pinned version. Commit `.terraform.lock.hcl` from the first real `tofu init`; once committed, CI fails if it is missing or out of date.

### Alternatives considered
Terraform everywhere (re-verify the skeleton, BSL licence); mixing both (rejected).

## 2. Recording retention ceiling
### Context
The recordings bucket expired objects after 30 days, while the agent config default `recording.retention_days` is 90. Recordings could disappear before a clinic expects, or a config could promise retention the storage does not honour.

### Decision
- Platform maximum retention in the MVP is **90 days**.
- The recordings bucket lifecycle expires objects at 90 days (Terraform variable, default 90).
- A tenant may set a shorter `retention_days`; the Post-call Worker deletes those recordings early.
- The Core API rejects agent configs with `retention_days` above 90. The agent config schema carries `maximum: 90` (a tightening of v1 validation, no shape change).

### Consequences
Raising the ceiling later needs a new ADR plus a legal check under DPDP.
