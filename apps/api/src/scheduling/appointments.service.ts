import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { recordAudit } from '../audit/audit';
import { errors } from '../common/errors';
import { getContext, requireTenantContext } from '../common/request-context';
import {
  DbService,
  PG_EXCLUSION_VIOLATION,
  PG_UNIQUE_VIOLATION,
  pgConstraint,
  pgErrorCode,
  type Tx,
} from '../db/db.service';
import { enqueueEvent } from '../events/events';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ContactsRepository, type ContactRef } from './contacts.repository';
import {
  type AppointmentSource,
  type ContractAppointment,
  SchedulingRepository,
  type SlotRow,
  toContractAppointment,
  toContractSlot,
} from './scheduling.repository';

export interface BookInput {
  slotId: string;
  contact: ContactRef;
  reason?: string;
  source: AppointmentSource;
}

export interface WriteResult {
  status: number;
  body: ContractAppointment;
  replayed: boolean;
}

/** Per-tenant scheduling policy, stored in tenants.settings. */
const policySchema = z.object({
  cancel_cutoff_minutes: z.number().int().min(0).default(0),
  reschedule_cutoff_minutes: z.number().int().min(0).default(0),
});

const ACTIVE = new Set(['booked', 'rescheduled']);

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private readonly db: DbService,
    private readonly repo: SchedulingRepository,
    private readonly contacts: ContactsRepository,
    private readonly idempotency: IdempotencyService,
  ) {}

  async book(input: BookInput, idempotencyKey?: string): Promise<WriteResult> {
    const { tenantId } = requireTenantContext();
    return this.write(tenantId, input.slotId, idempotencyKey, 'appointment.book', input, 201, async (tx) => {
      const contact = await this.contacts.resolve(tx, input.contact);
      await this.claimOrExplain(tx, input.slotId);

      const ctx = getContext();
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO appointments (tenant_id, contact_id, slot_id, status, source, reason, call_id, created_by_user_id)
         VALUES (app_current_tenant(), $1, $2, 'booked', $3, $4, $5, $6) RETURNING id`,
        [
          contact.id,
          input.slotId,
          input.source,
          input.reason ?? null,
          ctx?.callId ?? null,
          ctx?.actor?.type === 'user' ? ctx.actor.userId : null,
        ],
      );
      const appointment = await this.repo.getAppointment(tx, (rows[0] as { id: string }).id);
      if (!appointment) throw new Error('appointment vanished after insert');

      await enqueueEvent(tx, 'appointment.booked', tenantId, {
        appointment_id: appointment.appointment_id,
        contact_id: contact.id,
        phone: contact.phone,
        contact_name: contact.name,
        ...(contact.language ? { language: contact.language } : {}),
        slot: {
          provider_id: appointment.provider_id,
          provider_name: appointment.provider_name,
          location_name: appointment.location_name,
          start: appointment.starts_at.toISOString(),
          end: appointment.ends_at.toISOString(),
          timezone: appointment.timezone,
        },
        source: input.source,
        consent_whatsapp: contact.consentWhatsapp,
      });
      await recordAudit(tx, {
        action: 'appointment.book',
        targetType: 'appointment',
        targetId: appointment.appointment_id,
        metadata: { slot_id: input.slotId, source: input.source },
      });
      this.logger.log(
        { appointment_id: appointment.appointment_id, slot_id: input.slotId, source: input.source },
        'appointment booked',
      );
      return toContractAppointment(appointment);
    });
  }

  async reschedule(appointmentId: string, newSlotId: string, idempotencyKey?: string): Promise<WriteResult> {
    const { tenantId } = requireTenantContext();
    const request = { appointmentId, newSlotId };
    return this.write(tenantId, newSlotId, idempotencyKey, 'appointment.reschedule', request, 200, async (tx) => {
      const current = await this.lockAppointment(tx, appointmentId);
      if (!ACTIVE.has(current.appointment_status)) {
        throw errors.policyBlocked(`A ${current.appointment_status} appointment cannot be rescheduled`);
      }
      if (current.slot_id === newSlotId) return toContractAppointment(current);
      await this.enforceCutoff(tx, current, 'reschedule_cutoff_minutes', 'rescheduled');

      await this.claimOrExplain(tx, newSlotId);
      await this.repo.releaseSlot(tx, current.slot_id);
      await tx.query(`UPDATE appointments SET slot_id = $2, status = 'rescheduled' WHERE id = $1`, [
        appointmentId,
        newSlotId,
      ]);
      const updated = await this.repo.getAppointment(tx, appointmentId);
      if (!updated) throw new Error('appointment vanished after update');

      await recordAudit(tx, {
        action: 'appointment.reschedule',
        targetType: 'appointment',
        targetId: appointmentId,
        metadata: { from_slot_id: current.slot_id, to_slot_id: newSlotId },
      });
      this.logger.log(
        { appointment_id: appointmentId, from_slot_id: current.slot_id, to_slot_id: newSlotId },
        'appointment rescheduled',
      );
      return toContractAppointment(updated);
    });
  }

  async cancel(appointmentId: string, reason: string | undefined, idempotencyKey?: string): Promise<WriteResult> {
    const { tenantId } = requireTenantContext();
    const request = { appointmentId, reason };
    return this.write(tenantId, null, idempotencyKey, 'appointment.cancel', request, 200, async (tx) => {
      const current = await this.lockAppointment(tx, appointmentId);
      if (current.appointment_status === 'cancelled') return toContractAppointment(current);
      if (!ACTIVE.has(current.appointment_status)) {
        throw errors.policyBlocked(`A ${current.appointment_status} appointment cannot be cancelled`);
      }
      await this.enforceCutoff(tx, current, 'cancel_cutoff_minutes', 'cancelled');

      await tx.query(
        `UPDATE appointments SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
        [appointmentId, reason ?? null],
      );
      await this.repo.releaseSlot(tx, current.slot_id);
      await recordAudit(tx, { action: 'appointment.cancel', targetType: 'appointment', targetId: appointmentId });
      this.logger.log({ appointment_id: appointmentId, slot_id: current.slot_id }, 'appointment cancelled');
      return toContractAppointment({ ...current, appointment_status: 'cancelled' });
    });
  }

  async listForContact(contactId: string, filter: 'upcoming' | 'past' | 'all'): Promise<ContractAppointment[]> {
    const { tenantId } = requireTenantContext();
    return this.db.tenantTx(tenantId, async (tx) => {
      if (!(await this.contacts.exists(tx, contactId))) await this.repo.missing(tx, 'contact', contactId, 'Contact');
      const rows = await this.repo.listAppointmentsForContact(tx, contactId, filter);
      return rows.map(toContractAppointment);
    });
  }

  /**
   * Shared write path: one tenant transaction, idempotency inside it, and translation of
   * the database's own double-booking guards (which only fire if application logic is
   * bypassed or races in an unforeseen way) into SLOT_TAKEN.
   */
  private async write(
    tenantId: string,
    contestedSlotId: string | null,
    idempotencyKey: string | undefined,
    operation: string,
    request: unknown,
    successStatus: number,
    fn: (tx: Tx) => Promise<ContractAppointment>,
  ): Promise<WriteResult> {
    try {
      return await this.db.tenantTx(tenantId, async (tx) => {
        if (!idempotencyKey) return { status: successStatus, body: await fn(tx), replayed: false };
        return this.idempotency.run(tx, { key: idempotencyKey, operation, request }, async () => ({
          status: successStatus,
          body: await fn(tx),
        }));
      });
    } catch (err) {
      const isGuard =
        (pgErrorCode(err) === PG_UNIQUE_VIOLATION && pgConstraint(err) === 'appointments_one_active_per_slot') ||
        pgErrorCode(err) === PG_EXCLUSION_VIOLATION;
      if (isGuard && contestedSlotId) {
        this.logger.warn(
          { slot_id: contestedSlotId, constraint: pgConstraint(err) },
          'database double-booking guard fired',
        );
        const alternatives = await this.db.tenantTx(tenantId, async (tx) => {
          const slot = await this.repo.getSlot(tx, contestedSlotId);
          return slot ? (await this.repo.alternativesNear(tx, slot)).map(toContractSlot) : [];
        });
        throw errors.slotTaken(alternatives);
      }
      throw err;
    }
  }

  /** Claims the slot, or throws the precise contract error explaining why it cannot. */
  private async claimOrExplain(tx: Tx, slotId: string): Promise<void> {
    if (await this.repo.claimSlot(tx, slotId)) return;

    const slot = await this.repo.getSlot(tx, slotId);
    if (!slot) return this.repo.missing(tx, 'slot', slotId, 'Slot');
    if (slot.starts_at.getTime() <= Date.now()) {
      throw errors.policyBlocked('That slot is in the past');
    }
    const alternatives = await this.repo.alternativesNear(tx, slot);
    this.logger.log(
      { slot_id: slotId, slot_status: slot.status, alternatives: alternatives.length },
      'slot unavailable',
    );
    throw errors.slotTaken(alternatives.map(toContractSlot));
  }

  private async lockAppointment(tx: Tx, appointmentId: string) {
    const row = await this.repo.getAppointment(tx, appointmentId, true);
    if (!row) return this.repo.missing(tx, 'appointment', appointmentId, 'Appointment');
    return row;
  }

  private async enforceCutoff(
    tx: Tx,
    appointment: SlotRow,
    setting: 'cancel_cutoff_minutes' | 'reschedule_cutoff_minutes',
    verb: string,
  ): Promise<void> {
    const startsIn = appointment.starts_at.getTime() - Date.now();
    if (startsIn <= 0) throw errors.policyBlocked(`A past appointment cannot be ${verb}`);
    const parsed = policySchema.safeParse(await this.repo.tenantSettings(tx));
    const cutoff = parsed.success ? parsed.data[setting] : 0;
    if (!parsed.success)
      this.logger.error({ issues: parsed.error.issues }, 'invalid tenant scheduling settings; using defaults');
    if (startsIn < cutoff * 60_000) {
      throw errors.policyBlocked(`Appointments can only be ${verb} at least ${cutoff} minutes in advance`);
    }
  }
}
