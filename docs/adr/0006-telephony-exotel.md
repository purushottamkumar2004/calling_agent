# 0006: Telephony: Exotel, Plivo fallback
Date: 2026-10-22
Status: Accepted

## Context
We need Indian numbers, low-latency bidirectional audio streaming, outbound calling, and human transfer.

## Decision
Exotel via its Voicebot Applet (bidirectional WebSocket streaming, Mumbai endpoint). Pipecat supports Exotel's streaming protocol natively. Plivo is the fallback, hidden behind the Voice Gateway provider interface.

## Alternatives considered
Plivo; Twilio (stronger outside India, costlier here).

## Consequences
Voice streaming must be enabled on the Exotel account by their support before testing.
