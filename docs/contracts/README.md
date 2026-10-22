# Service contracts (v1)

Frozen interfaces between services. Changing any of these requires a Master-chat decision and a new ADR. Additive, optional fields are allowed in a minor change; anything else needs a new version (`v2`) while `v1` stays supported.

| Contract | File | Producer | Consumers |
| --- | --- | --- | --- |
| Internal tool API | [`internal-api.openapi.yaml`](internal-api.openapi.yaml) | Core API | Voice Gateway, Voice Worker |
| Event envelope | [`events/envelope.schema.json`](events/envelope.schema.json) | all | all |
| `call.ended` v1 | [`events/call.ended.v1.schema.json`](events/call.ended.v1.schema.json) | Voice Worker | Post-call Worker, Core API |
| `appointment.booked` v1 | [`events/appointment.booked.v1.schema.json`](events/appointment.booked.v1.schema.json) | Core API | Scheduler and Notifier |
| Agent config v1 | [`agent-config.v1.schema.json`](agent-config.v1.schema.json) | Core API | Voice Worker |

Examples live in [`examples/`](examples/).

## Rules

1. **Voice Worker never touches the database.** Every tool call is an HTTP request to `/internal/v1` on the Core API.
2. **Auth between services:** short-lived service JWT in `Authorization: Bearer`, plus `X-Tenant-Id` and `X-Call-Id` headers on every call-scoped request. The Core API rejects a request whose tenant does not own the call.
3. **Idempotency:** every write takes an `Idempotency-Key` header (the Voice Worker uses `{call_id}:{tool_call_id}`), so a retried tool call never double-books.
4. **Latency SLO:** tool endpoints p95 under 300 ms. The Voice Worker times out at 2 s and plays a filler line after 1 s.
5. **Errors:** always `{"error": {"code", "message", "details"}}` with a stable `code` the LLM tool layer can map to a spoken reply.
6. **Events:** Redis Streams, stream `events:{domain}` (e.g. `events:call`), every message wrapped in the envelope. Consumers must be idempotent on `event_id`.
7. **Agent config is a snapshot:** the Voice Worker receives the full config for one `version` at call start and never re-reads it mid-call. The `Call` row stores that version.
8. **Times** are ISO-8601 UTC; **phones** are E.164 (`+919876543210`); **languages** are BCP-47 (`en-IN`, `hi-IN`).

## Tool catalogue (LLM-facing names to endpoints)

| Tool | Endpoint |
| --- | --- |
| `lookup_contact` | `GET /contacts/lookup` |
| `check_availability` | `GET /availability` |
| `book_appointment` | `POST /appointments` |
| `list_appointments` | `GET /appointments` |
| `reschedule_appointment` | `POST /appointments/{id}/reschedule` |
| `cancel_appointment` | `POST /appointments/{id}/cancel` |
| `search_knowledge` | `POST /knowledge/search` |
| `transfer_to_human` | `POST /calls/{call_id}/transfer` |
| `end_call` | handled inside the Voice Worker (no API call) |

## Error codes

| Code | HTTP | Meaning | Agent behaviour |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Bad or missing input | Re-ask the caller for the missing detail |
| `UNAUTHORIZED` | 401 | Bad service token | Fail call safely, transfer |
| `TENANT_MISMATCH` | 403 | Call or resource not owned by tenant | Fail call safely, transfer |
| `NOT_FOUND` | 404 | Contact, slot or appointment missing | Say so, offer to search again |
| `SLOT_TAKEN` | 409 | Slot booked by someone else | Offer the `alternatives` in `details` |
| `OUTSIDE_HOURS` | 422 | Requested time outside clinic hours | Offer nearest open times |
| `POLICY_BLOCKED` | 422 | Business rule (e.g. cancel window passed) | Explain and offer transfer |
| `INTERNAL` | 500 | Server error | Apologise, offer transfer |
