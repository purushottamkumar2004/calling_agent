# apps/voice-worker: Voice Worker

Python (Pipecat). One stateful session per live call: VAD (Silero), streaming STT, LLM with tool calls, streaming TTS, barge-in. Reaches business data only through Core API tool calls. Emits `call.ended` on hangup.

Latency target: under 1.2 s from end of caller speech to first agent audio.

Owned by chat **03 Voice Worker (Agent Runtime)**.
First task: STT to LLM to TTS loop with barge-in and per-turn latency logging.
