import { Injectable } from '@nestjs/common';
import type { components } from '../contracts/generated/internal-api';
import { errors } from '../common/errors';
import { getContext } from '../common/request-context';
import type { Tx } from '../db/db.service';
import { speakable } from './time';

export type ContractSlot = components['schemas']['Slot'];
export type ContractAppointment = components['schemas']['Appointment'];
export type AppointmentStatus = ContractAppointment['status'];
export type AppointmentSource = NonNullable<ContractAppointment['source']>;

export interface SlotRow {
  slot_id: string;
  provider_id: string;
  provider_name: string;
  specialty: string | null;
  location_id: string;
  location_name: string;
  timezone: string;
  starts_at: Date;
  ends_at: Date;
  status: 'open' | 'booked' | 'blocked';
}

export interface AppointmentRow extends SlotRow {
  appointment_id: string;
  appointment_status: AppointmentStatus;
  source: AppointmentSource;
  contact_id: string;
}

export interface SlotFilters {
  providerId?: string;
  locationId?: string;
  specialty?: string;
  from: Date;
  to: Date;
}

export type ResourceKind = 'call' | 'slot' | 'contact' | 'appointment' | 'provider' | 'location';

const SLOT_COLUMNS = `
  s.id AS slot_id, s.provider_id, p.name AS provider_name, p.specialty,
  l.id AS location_id, l.name AS location_name, l.timezone,
  s.starts_at, s.ends_at, s.status`;
const SLOT_JOINS = `
  JOIN providers p ON p.id = s.provider_id
  JOIN locations l ON l.id = p.location_id`;

export function toContractSlot(row: SlotRow): ContractSlot {
  return {
    slot_id: row.slot_id,
    provider_id: row.provider_id,
    provider_name: row.provider_name,
    location_id: row.location_id,
    location_name: row.location_name,
    start: row.starts_at.toISOString(),
    end: row.ends_at.toISOString(),
    speakable: speakable(row.starts_at, row.timezone),
  };
}

export function toContractAppointment(row: AppointmentRow): ContractAppointment {
  return {
    appointment_id: row.appointment_id,
    status: row.appointment_status,
    contact_id: row.contact_id,
    source: row.source,
    slot: toContractSlot(row),
  };
}

/** All queries run inside a tenant-bound transaction; RLS scopes every table. */
@Injectable()
export class SchedulingRepository {
  async findOpenSlots(tx: Tx, f: SlotFilters, limit: number): Promise<SlotRow[]> {
    const { rows } = await tx.query<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM slots s ${SLOT_JOINS}
        WHERE s.status = 'open' AND p.active
          AND s.starts_at >= greatest($1::timestamptz, now()) AND s.starts_at < $2
          AND ($3::uuid IS NULL OR s.provider_id = $3)
          AND ($4::uuid IS NULL OR p.location_id = $4)
          AND ($5::text IS NULL OR lower(p.specialty) = lower($5))
        ORDER BY s.starts_at, s.id
        LIMIT $6`,
      [f.from, f.to, f.providerId ?? null, f.locationId ?? null, f.specialty ?? null, limit],
    );
    return rows;
  }

  /** Locations that could serve a request, with their hours, for OUTSIDE_HOURS decisions. */
  async candidateLocations(
    tx: Tx,
    f: Omit<SlotFilters, 'from' | 'to'>,
  ): Promise<Array<{ timezone: string; hours: Record<string, unknown> }>> {
    const { rows } = await tx.query<{ timezone: string; hours: Record<string, unknown> }>(
      `SELECT DISTINCT l.id, l.timezone, l.hours FROM locations l JOIN providers p ON p.location_id = l.id
        WHERE p.active
          AND ($1::uuid IS NULL OR p.id = $1)
          AND ($2::uuid IS NULL OR l.id = $2)
          AND ($3::text IS NULL OR lower(p.specialty) = lower($3))`,
      [f.providerId ?? null, f.locationId ?? null, f.specialty ?? null],
    );
    return rows;
  }

  async getSlot(tx: Tx, slotId: string): Promise<SlotRow | undefined> {
    const { rows } = await tx.query<SlotRow>(`SELECT ${SLOT_COLUMNS} FROM slots s ${SLOT_JOINS} WHERE s.id = $1`, [
      slotId,
    ]);
    return rows[0];
  }

  async getSlots(tx: Tx, slotIds: string[]): Promise<SlotRow[]> {
    if (slotIds.length === 0) return [];
    const { rows } = await tx.query<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM slots s ${SLOT_JOINS} WHERE s.id = ANY($1::uuid[]) ORDER BY s.starts_at, s.id`,
      [slotIds],
    );
    return rows;
  }

  /**
   * Atomically takes an open, future slot of an active provider. Under concurrency the
   * row lock serialises claimers and the loser re-evaluates `status = 'open'` and gets
   * no row, so exactly one booking can win.
   */
  async claimSlot(tx: Tx, slotId: string): Promise<boolean> {
    const result = await tx.query(
      `UPDATE slots s SET status = 'booked'
        WHERE s.id = $1 AND s.status = 'open' AND s.starts_at > now()
          AND EXISTS (SELECT 1 FROM providers p WHERE p.id = s.provider_id AND p.active)`,
      [slotId],
    );
    return result.rowCount === 1;
  }

  async releaseSlot(tx: Tx, slotId: string): Promise<void> {
    await tx.query(`UPDATE slots SET status = 'open' WHERE id = $1 AND status = 'booked'`, [slotId]);
  }

  /** Nearest open slots to a requested time: same provider first, then same specialty. */
  async alternativesNear(tx: Tx, slot: SlotRow, limit = 3): Promise<SlotRow[]> {
    const { rows } = await tx.query<SlotRow>(
      `SELECT ${SLOT_COLUMNS} FROM slots s ${SLOT_JOINS}
        WHERE s.status = 'open' AND p.active AND s.starts_at > now() AND s.id <> $1
          AND s.starts_at BETWEEN $2::timestamptz - interval '7 days' AND $2::timestamptz + interval '7 days'
          AND (s.provider_id = $3 OR ($4::text IS NOT NULL AND lower(p.specialty) = lower($4)))
        ORDER BY (s.provider_id = $3) DESC, abs(extract(epoch FROM s.starts_at - $2::timestamptz)), s.id
        LIMIT $5`,
      [slot.slot_id, slot.starts_at, slot.provider_id, slot.specialty, limit],
    );
    return rows;
  }

  async getAppointment(tx: Tx, appointmentId: string, forUpdate = false): Promise<AppointmentRow | undefined> {
    const { rows } = await tx.query<AppointmentRow>(
      `SELECT a.id AS appointment_id, a.status AS appointment_status, a.source, a.contact_id, ${SLOT_COLUMNS}
         FROM appointments a JOIN slots s ON s.id = a.slot_id ${SLOT_JOINS}
        WHERE a.id = $1 ${forUpdate ? 'FOR UPDATE OF a' : ''}`,
      [appointmentId],
    );
    return rows[0];
  }

  async listAppointmentsForContact(
    tx: Tx,
    contactId: string,
    filter: 'upcoming' | 'past' | 'all',
  ): Promise<AppointmentRow[]> {
    const where = {
      upcoming: `AND s.starts_at >= now() AND a.status IN ('booked', 'rescheduled')`,
      past: `AND s.starts_at < now()`,
      all: '',
    }[filter];
    const { rows } = await tx.query<AppointmentRow>(
      `SELECT a.id AS appointment_id, a.status AS appointment_status, a.source, a.contact_id, ${SLOT_COLUMNS}
         FROM appointments a JOIN slots s ON s.id = a.slot_id ${SLOT_JOINS}
        WHERE a.contact_id = $1 ${where}
        ORDER BY s.starts_at ${filter === 'past' ? 'DESC' : 'ASC'}
        LIMIT 50`,
      [contactId],
    );
    return rows;
  }

  async listAppointmentsInWindow(tx: Tx, from: Date, to: Date, limit: number): Promise<AppointmentRow[]> {
    const { rows } = await tx.query<AppointmentRow>(
      `SELECT a.id AS appointment_id, a.status AS appointment_status, a.source, a.contact_id, ${SLOT_COLUMNS}
         FROM appointments a JOIN slots s ON s.id = a.slot_id ${SLOT_JOINS}
        WHERE s.starts_at >= $1 AND s.starts_at < $2
        ORDER BY s.starts_at, a.id
        LIMIT $3`,
      [from, to, limit],
    );
    return rows;
  }

  async tenantSettings(tx: Tx): Promise<Record<string, unknown>> {
    const { rows } = await tx.query<{ settings: Record<string, unknown> }>(
      'SELECT settings FROM tenants WHERE id = app_current_tenant()',
    );
    return rows[0]?.settings ?? {};
  }

  /**
   * Resource missing from this tenant's view. Service callers get TENANT_MISMATCH when it
   * belongs to another tenant (contract error table); dashboard users always get
   * NOT_FOUND so tenants cannot probe each other's ids.
   */
  async missing(tx: Tx, kind: ResourceKind, id: string, label: string): Promise<never> {
    if (getContext()?.actor?.type === 'service') {
      const { rows } = await tx.query<{ owner: string | null }>('SELECT resource_tenant($1, $2) AS owner', [kind, id]);
      if (rows[0]?.owner) throw errors.tenantMismatch(`${label} is not owned by this tenant`);
    }
    throw errors.notFound(label);
  }
}
