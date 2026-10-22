import { Injectable, Logger } from '@nestjs/common';
import { recordAudit } from '../audit/audit';
import { errors } from '../common/errors';
import { requireTenantContext } from '../common/request-context';
import { DbService, PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '../db/db.service';
import { type ContractSlot, SchedulingRepository, type SlotRow, toContractSlot } from './scheduling.repository';

export interface NewSlot {
  provider_id: string;
  start: Date;
  end: Date;
}

export type DashboardSlot = ContractSlot & { status: SlotRow['status'] };

const toDashboardSlot = (row: SlotRow): DashboardSlot => ({ ...toContractSlot(row), status: row.status });

/** Dashboard slot management (staff publish availability; booking happens elsewhere). */
@Injectable()
export class SlotsAdminService {
  private readonly logger = new Logger(SlotsAdminService.name);

  constructor(
    private readonly db: DbService,
    private readonly repo: SchedulingRepository,
  ) {}

  /** All-or-nothing bulk create; any overlap with an existing slot rejects the batch. */
  async create(slots: NewSlot[]): Promise<DashboardSlot[]> {
    const { tenantId } = requireTenantContext();
    const providerIds = [...new Set(slots.map((s) => s.provider_id))];
    try {
      return await this.db.tenantTx(tenantId, async (tx) => {
        const { rows: found } = await tx.query<{ id: string }>('SELECT id FROM providers WHERE id = ANY($1::uuid[])', [
          providerIds,
        ]);
        const missing = providerIds.filter((id) => !found.some((r) => r.id === id));
        if (missing.length) throw errors.validation('Unknown provider_id', { provider_ids: missing });

        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO slots (tenant_id, provider_id, starts_at, ends_at)
           SELECT app_current_tenant(), * FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[])
           RETURNING id`,
          [slots.map((s) => s.provider_id), slots.map((s) => s.start), slots.map((s) => s.end)],
        );
        const created = await this.repo.getSlots(
          tx,
          rows.map((r) => r.id),
        );
        await recordAudit(tx, { action: 'slots.create', targetType: 'slot', metadata: { count: created.length } });
        this.logger.log({ count: created.length }, 'slots created');
        return created.map(toDashboardSlot);
      });
    } catch (err) {
      const code = pgErrorCode(err);
      if (code === PG_EXCLUSION_VIOLATION || code === PG_UNIQUE_VIOLATION) {
        throw errors.conflict('One or more slots overlap an existing slot for the same provider');
      }
      throw err;
    }
  }

  async list(filters: { from: Date; to: Date; providerId?: string; status?: SlotRow['status'] }, limit: number) {
    const { tenantId } = requireTenantContext();
    return this.db.tenantTx(tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT s.id FROM slots s
          WHERE s.starts_at >= $1 AND s.starts_at < $2
            AND ($3::uuid IS NULL OR s.provider_id = $3) AND ($4::text IS NULL OR s.status = $4)
          ORDER BY s.starts_at, s.id LIMIT $5`,
        [filters.from, filters.to, filters.providerId ?? null, filters.status ?? null, limit],
      );
      return (
        await this.repo.getSlots(
          tx,
          rows.map((r) => r.id),
        )
      ).map(toDashboardSlot);
    });
  }

  /** Open or block a slot. A booked slot changes only through its appointment. */
  async setStatus(slotId: string, status: 'open' | 'blocked'): Promise<DashboardSlot> {
    const { tenantId } = requireTenantContext();
    return this.db.tenantTx(tenantId, async (tx) => {
      const { rows } = await tx.query<{ status: string }>('SELECT status FROM slots WHERE id = $1 FOR UPDATE', [
        slotId,
      ]);
      const current = rows[0];
      if (!current) throw errors.notFound('Slot');
      if (current.status === 'booked') throw errors.conflict('Slot is booked; cancel or reschedule the appointment');
      await tx.query('UPDATE slots SET status = $2 WHERE id = $1', [slotId, status]);
      await recordAudit(tx, {
        action: `slot.${status === 'open' ? 'open' : 'block'}`,
        targetType: 'slot',
        targetId: slotId,
      });
      const row = await this.repo.getSlot(tx, slotId);
      return toDashboardSlot(row as SlotRow);
    });
  }
}
