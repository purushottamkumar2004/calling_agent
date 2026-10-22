import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Roles, UserAuthGuard } from '../auth/guards';
import { parse, zDateTime, zLanguage, zPhone, zUuid } from '../common/validation';
import { requireTenantContext } from '../common/request-context';
import { DbService } from '../db/db.service';
import { respond } from '../common/http';
import { AppointmentsService } from '../scheduling/appointments.service';
import {
  SchedulingRepository,
  toContractAppointment,
  type ContractAppointment,
} from '../scheduling/scheduling.repository';
import { type DashboardSlot, SlotsAdminService } from '../scheduling/slots-admin.service';

/*
 * Dashboard (staff) API under /v1. Not part of the frozen internal contract; response
 * shapes reuse the contract's Slot and Appointment so the web app shares types.
 */

const MAX_WINDOW_MS = 62 * 24 * 3600 * 1000;

/** Time-window rules shared by dashboard list endpoints. */
function windowRules(q: { from: Date; to: Date }, ctx: z.RefinementCtx): void {
  if (q.to <= q.from) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be after from', path: ['to'] });
  else if (q.to.getTime() - q.from.getTime() > MAX_WINDOW_MS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'window must be 62 days or less', path: ['to'] });
  }
}

const createSlotsBody = z.object({
  slots: z
    .array(
      z
        .object({ provider_id: zUuid, start: zDateTime, end: zDateTime })
        .refine((s) => s.end > s.start, { message: 'end must be after start', path: ['end'] }),
    )
    .min(1)
    .max(500),
});
const listSlotsQuery = z
  .object({
    from: zDateTime,
    to: zDateTime,
    provider_id: zUuid.optional(),
    status: z.enum(['open', 'booked', 'blocked']).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  })
  .superRefine(windowRules);
const patchSlotBody = z.object({ status: z.enum(['open', 'blocked']) });

const bookBody = z.object({
  slot_id: zUuid,
  contact: z.union([
    z.object({ contact_id: zUuid }),
    z.object({ phone: zPhone, name: z.string().trim().min(1).max(120).optional(), language: zLanguage.optional() }),
  ]),
  reason: z.string().max(300).optional(),
});
const listAppointmentsQuery = z
  .object({ from: zDateTime, to: zDateTime, limit: z.coerce.number().int().min(1).max(500).default(200) })
  .superRefine(windowRules);
const idempotencyKey = z.string().min(1).max(128).optional();

@Controller('v1/slots')
@UseGuards(UserAuthGuard)
export class DashboardSlotsController {
  constructor(private readonly slots: SlotsAdminService) {}

  @Post()
  @Roles('owner', 'admin')
  async create(@Body() body: unknown): Promise<{ slots: DashboardSlot[] }> {
    return { slots: await this.slots.create(parse(createSlotsBody, body).slots) };
  }

  @Get()
  async list(@Query() query: unknown): Promise<{ slots: DashboardSlot[] }> {
    const q = parse(listSlotsQuery, query);
    return {
      slots: await this.slots.list({ from: q.from, to: q.to, providerId: q.provider_id, status: q.status }, q.limit),
    };
  }

  @Patch(':slot_id')
  @Roles('owner', 'admin')
  update(@Param('slot_id') id: string, @Body() body: unknown): Promise<DashboardSlot> {
    return this.slots.setStatus(parse(zUuid, id), parse(patchSlotBody, body).status);
  }
}

@Controller('v1/appointments')
@UseGuards(UserAuthGuard)
export class DashboardAppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly db: DbService,
    private readonly repo: SchedulingRepository,
  ) {}

  @Get()
  async list(@Query() query: unknown): Promise<{ appointments: ContractAppointment[] }> {
    const q = parse(listAppointmentsQuery, query);
    const { tenantId } = requireTenantContext();
    const rows = await this.db.tenantTx(tenantId, (tx) =>
      this.repo.listAppointmentsInWindow(tx, q.from, q.to, q.limit),
    );
    return { appointments: rows.map(toContractAppointment) };
  }

  @Post()
  async book(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContractAppointment> {
    const b = parse(bookBody, body);
    const result = await this.appointments.book(
      { slotId: b.slot_id, contact: b.contact, reason: b.reason, source: 'dashboard' },
      parse(idempotencyKey, key),
    );
    return respond(res, result);
  }

  @Post(':appointment_id/reschedule')
  async reschedule(
    @Param('appointment_id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContractAppointment> {
    const b = parse(z.object({ new_slot_id: zUuid }), body);
    return respond(
      res,
      await this.appointments.reschedule(parse(zUuid, id), b.new_slot_id, parse(idempotencyKey, key)),
    );
  }

  @Post(':appointment_id/cancel')
  async cancel(
    @Param('appointment_id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContractAppointment> {
    const b = parse(z.object({ reason: z.string().max(300).optional() }), body ?? {});
    return respond(res, await this.appointments.cancel(parse(zUuid, id), b.reason, parse(idempotencyKey, key)));
  }
}
