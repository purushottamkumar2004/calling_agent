import { Injectable, Logger } from '@nestjs/common';
import { errors } from '../common/errors';
import { requireTenantContext } from '../common/request-context';
import { DbService, type Tx } from '../db/db.service';
import { type ContractSlot, SchedulingRepository, type SlotFilters, toContractSlot } from './scheduling.repository';
import { openingHoursSchema, overlapsOpeningHours } from './time';

const ALTERNATIVES_HORIZON_MS = 14 * 24 * 3600 * 1000;

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly db: DbService,
    private readonly repo: SchedulingRepository,
  ) {}

  /**
   * Open slots soonest first. If nothing is open AND the requested window falls entirely
   * outside the opening hours of every matching location, returns OUTSIDE_HOURS with the
   * nearest open slots as alternatives. A window inside hours that is simply full
   * returns an empty list (the agent then asks for another time).
   */
  async check(filters: SlotFilters, limit: number): Promise<ContractSlot[]> {
    const { tenantId } = requireTenantContext();
    return this.db.tenantTx(tenantId, async (tx) => {
      await this.assertScopeExists(tx, filters);

      const slots = await this.repo.findOpenSlots(tx, filters, limit);
      if (slots.length > 0) return slots.map(toContractSlot);

      const locations = await this.repo.candidateLocations(tx, filters);
      if (locations.length === 0) return [];
      const anyOpen = locations.some((l) => {
        const hours = openingHoursSchema.safeParse(l.hours);
        if (!hours.success) {
          this.logger.error({ issues: hours.error.issues }, 'invalid location hours; treating as always open');
          return true;
        }
        return overlapsOpeningHours(filters.from, filters.to, l.timezone, hours.data);
      });
      if (anyOpen) return [];

      const from = new Date(Math.max(filters.from.getTime(), Date.now()));
      const alternatives = await this.repo.findOpenSlots(
        tx,
        { ...filters, from, to: new Date(from.getTime() + ALTERNATIVES_HORIZON_MS) },
        limit,
      );
      throw errors.outsideHours(alternatives.map(toContractSlot));
    });
  }

  private async assertScopeExists(tx: Tx, f: SlotFilters): Promise<void> {
    if (f.providerId) {
      const { rowCount } = await tx.query('SELECT 1 FROM providers WHERE id = $1', [f.providerId]);
      if (!rowCount) await this.repo.missing(tx, 'provider', f.providerId, 'Provider');
    }
    if (f.locationId) {
      const { rowCount } = await tx.query('SELECT 1 FROM locations WHERE id = $1', [f.locationId]);
      if (!rowCount) await this.repo.missing(tx, 'location', f.locationId, 'Location');
    }
  }
}
