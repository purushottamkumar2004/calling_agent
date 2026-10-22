import { Body, Controller, Get, Headers, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ServiceAuthGuard } from '../auth/guards';
import { errors } from '../common/errors';
import { parse, zDateTime, zLanguage, zPhone, zUuid } from '../common/validation';
import { respond } from '../common/http';
import { AppointmentsService } from '../scheduling/appointments.service';
import { AvailabilityService } from '../scheduling/availability.service';
import type { ContractAppointment, ContractSlot } from '../scheduling/scheduling.repository';
import { InternalCallGuard } from './internal-call.guard';

/*
 * Implements docs/contracts/internal-api.openapi.yaml (v1, frozen):
 *   GET  /availability                          checkAvailability
 *   GET  /appointments                          listAppointments
 *   POST /appointments                          bookAppointment
 *   POST /appointments/{appointment_id}/reschedule  rescheduleAppointment
 *   POST /appointments/{appointment_id}/cancel      cancelAppointment
 * Unknown body fields are ignored (additive changes are allowed within v1).
 */

const MAX_WINDOW_MS = 31 * 24 * 3600 * 1000;

const availabilityQuery = z
  .object({
    provider_id: zUuid.optional(),
    specialty: z.string().trim().min(1).max(100).optional(),
    location_id: zUuid.optional(),
    from: zDateTime,
    to: zDateTime,
    limit: z.coerce.number().int().min(1).max(20).default(5),
  })
  .refine((q) => q.to > q.from, { message: 'must be after from', path: ['to'] })
  .refine((q) => q.to.getTime() - q.from.getTime() <= MAX_WINDOW_MS, { message: 'window must be 31 days or less', path: ['to'] });

const listQuery = z.object({
  contact_id: zUuid,
  status: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
});

const bookBody = z.object({
  slot_id: zUuid,
  contact: z
    .object({
      contact_id: zUuid.optional(),
      phone: zPhone.optional(),
      name: z.string().trim().min(1).max(120).optional(),
      language: zLanguage.optional(),
    })
    .refine((c) => c.contact_id || c.phone, { message: 'contact_id or phone is required' }),
  reason: z.string().max(300).optional(),
});

const rescheduleBody = z.object({ new_slot_id: zUuid });
const cancelBody = z.object({ reason: z.string().max(300).optional() }).default({});
const idempotencyKey = z.string().min(1).max(128);

@Controller('internal/v1')
@UseGuards(ServiceAuthGuard, InternalCallGuard)
export class InternalSchedulingController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly appointments: AppointmentsService,
  ) {}

  @Get('availability')
  async checkAvailability(@Query() query: unknown): Promise<{ slots: ContractSlot[] }> {
    const q = parse(availabilityQuery, query);
    const slots = await this.availability.check(
      { providerId: q.provider_id, specialty: q.specialty, locationId: q.location_id, from: q.from, to: q.to },
      q.limit,
    );
    return { slots };
  }

  @Get('appointments')
  async listAppointments(@Query() query: unknown): Promise<{ appointments: ContractAppointment[] }> {
    const q = parse(listQuery, query);
    return { appointments: await this.appointments.listForContact(q.contact_id, q.status) };
  }

  @Post('appointments')
  async bookAppointment(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContractAppointment> {
    const b = parse(bookBody, body);
    const contact = b.contact.contact_id
      ? { contact_id: b.contact.contact_id }
      : { phone: b.contact.phone as string, name: b.contact.name, language: b.contact.language };
    const result = await this.appointments.book(
      { slotId: b.slot_id, contact, reason: b.reason, source: 'call' },
      requireKey(key),
    );
    return respond(res, result);
  }

  @Post('appointments/:appointment_id/reschedule')
  async rescheduleAppointment(
    @Param('appointment_id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContractAppointment> {
    const appointmentId = parse(zUuid, id);
    const b = parse(rescheduleBody, body);
    return respond(res, await this.appointments.reschedule(appointmentId, b.new_slot_id, requireKey(key)));
  }

  @Post('appointments/:appointment_id/cancel')
  async cancelAppointment(
    @Param('appointment_id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ContractAppointment> {
    const appointmentId = parse(zUuid, id);
    const b = parse(cancelBody, body ?? {});
    return respond(res, await this.appointments.cancel(appointmentId, b.reason, requireKey(key)));
  }
}

/** Contract rule 3: Idempotency-Key is required on every internal write. */
function requireKey(key: string | undefined): string {
  if (key === undefined) throw errors.validation('Idempotency-Key header is required');
  return parse(idempotencyKey, key);
}
