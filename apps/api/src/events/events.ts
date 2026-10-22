import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { AppointmentBookedV1, EventEnvelope } from '../contracts/generated/events';
import envelopeSchema from '../contracts/generated/envelope.schema.json';
import appointmentBookedSchema from '../contracts/generated/appointment.booked.v1.schema.json';
import { getContext } from '../common/request-context';
import type { Tx } from '../db/db.service';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateEnvelope = ajv.compile(envelopeSchema);
const payloadValidators = {
  'appointment.booked': { version: 1, validate: ajv.compile(appointmentBookedSchema) },
} as const;

export interface EventPayloads {
  'appointment.booked': AppointmentBookedV1;
}
export type EventType = keyof EventPayloads;

/** Stream naming per contract rule 6: events:{domain}. */
export function streamFor(type: EventType): string {
  return `events:${type.split('.')[0]}`;
}

export class EventSchemaError extends Error {}

/**
 * Builds the envelope and validates it and the payload against the frozen contract
 * schemas. An event that does not match its contract is a bug: it is never written.
 */
export function buildEvent<T extends EventType>(
  type: T,
  tenantId: string,
  payload: EventPayloads[T],
): EventEnvelope & { payload: EventPayloads[T] } {
  const spec = payloadValidators[type];
  const envelope = {
    event_id: randomUUID(),
    event_type: type,
    schema_version: spec.version,
    occurred_at: new Date().toISOString(),
    producer: 'api' as const,
    tenant_id: tenantId,
    call_id: getContext()?.callId ?? null,
    trace_id: null,
    payload,
  };
  if (!validateEnvelope(envelope)) {
    throw new EventSchemaError(`envelope invalid: ${ajv.errorsText(validateEnvelope.errors)}`);
  }
  if (!spec.validate(payload)) {
    throw new EventSchemaError(`${type} v${spec.version} payload invalid: ${ajv.errorsText(spec.validate.errors)}`);
  }
  return envelope;
}

/** Transactional outbox write: the event commits if and only if the business change does. */
export async function enqueueEvent<T extends EventType>(
  tx: Tx,
  type: T,
  tenantId: string,
  payload: EventPayloads[T],
): Promise<string> {
  const envelope = buildEvent(type, tenantId, payload);
  await tx.query('INSERT INTO outbox (event_id, tenant_id, stream, envelope) VALUES ($1, $2, $3, $4)', [
    envelope.event_id,
    tenantId,
    streamFor(type),
    JSON.stringify(envelope),
  ]);
  return envelope.event_id;
}
