/* eslint-disable */
// GENERATED from docs/contracts by scripts/gen-contract-types.ts. Do not edit.

export interface EventEnvelope {
  /**
   * Consumers dedupe on this
   */
  event_id: string;
  event_type: string;
  schema_version: number;
  occurred_at: string;
  producer: "api" | "voice-gateway" | "voice-worker" | "postcall-worker" | "scheduler";
  tenant_id: string;
  call_id?: string | null;
  /**
   * OpenTelemetry trace id
   */
  trace_id?: string | null;
  payload: {};
}

/**
 * Emitted by the Core API after a booking commits (any source). Stream: events:appointment. The Scheduler uses it to send confirmations and schedule reminders.
 */
export interface AppointmentBookedV1 {
  appointment_id: string;
  contact_id: string;
  phone: string;
  contact_name?: string | null;
  language?: "en-IN" | "hi-IN";
  slot: {
    provider_id?: string;
    provider_name: string;
    location_name?: string;
    start: string;
    end: string;
    timezone: string;
  };
  source: "call" | "dashboard" | "import";
  consent_whatsapp?: boolean;
}

