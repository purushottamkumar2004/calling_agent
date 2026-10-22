# apps/voice-gateway: Voice Gateway

Python (FastAPI). Receives Exotel webhooks, verifies them, accepts the bidirectional media WebSocket, and routes each call to the least-loaded Voice Worker. The telephony provider is hidden behind one interface so Plivo can be swapped in.

Owned by chat **02 Voice Gateway and Telephony**.
First task: inbound number to webhook to media WebSocket echo test.
