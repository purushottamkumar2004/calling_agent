import type { Response } from 'express';
import type { WriteResult } from '../scheduling/appointments.service';
import type { ContractAppointment } from '../scheduling/scheduling.repository';

/** Sends a write result, marking idempotent replays so callers and logs can tell. */
export function respond(res: Response, result: WriteResult): ContractAppointment {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}
