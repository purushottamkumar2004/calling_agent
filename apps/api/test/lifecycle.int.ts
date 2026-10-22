import { randomUUID } from 'node:crypto';
import {
  expectContract,
  expectErrorContract,
  type Fixture,
  seedTenant,
  serviceHeaders,
  startApp,
  type TestContext,
} from './helpers';

describe('reschedule, cancel and list', () => {
  let ctx: TestContext;
  let f: Fixture;
  let other: Fixture;

  beforeAll(async () => {
    ctx = await startApp();
    f = await seedTenant(ctx, { slots: 8 });
    other = await seedTenant(ctx);
  });
  afterAll(() => ctx.close());

  const post = async (path: string, body: unknown, key: string = randomUUID(), fx: Fixture = f) =>
    ctx
      .http()
      .post(`/internal/v1${path}`)
      .set(await serviceHeaders(ctx, fx))
      .set('Idempotency-Key', key)
      .send(body as object);
  const book = (slotIndex: number, phone = '+919876500000') =>
    post('/appointments', { slot_id: f.slotIds[slotIndex], contact: { phone } });
  const slotStatus = async (id: string) =>
    (await ctx.owner.query<{ status: string }>('SELECT status FROM slots WHERE id = $1', [id])).rows[0]?.status;

  describe('rescheduleAppointment', () => {
    it('moves the appointment, frees the old slot, and is contract-shaped', async () => {
      const booked = await book(0);
      const res = await post(`/appointments/${booked.body.appointment_id}/reschedule`, { new_slot_id: f.slotIds[1] });
      expect(res.status).toBe(200);
      expectContract(res.body, '/appointments/{appointment_id}/reschedule', 'post', 200);
      expect(res.body).toMatchObject({
        appointment_id: booked.body.appointment_id,
        status: 'rescheduled',
        slot: { slot_id: f.slotIds[1] },
      });
      expect(await slotStatus(f.slotIds[0]!)).toBe('open');
      expect(await slotStatus(f.slotIds[1]!)).toBe('booked');
      // The freed slot is bookable again.
      expect((await book(0, '+919876500001')).status).toBe(201);
    });

    it('returns 409 SLOT_TAKEN with alternatives and leaves the appointment untouched', async () => {
      const a = await book(2, '+919876500002');
      const b = await book(3, '+919876500003');
      const res = await post(`/appointments/${a.body.appointment_id}/reschedule`, { new_slot_id: f.slotIds[3] });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SLOT_TAKEN');
      expectErrorContract(res.body);
      expect(await slotStatus(f.slotIds[2]!)).toBe('booked');
      expect(b.status).toBe(201);
    });

    it('is a no-op when the new slot is the current slot', async () => {
      const a = await book(4, '+919876500004');
      const res = await post(`/appointments/${a.body.appointment_id}/reschedule`, { new_slot_id: f.slotIds[4] });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('booked');
    });

    it("rejects another tenant's appointment with TENANT_MISMATCH", async () => {
      const theirs = await post(
        '/appointments',
        { slot_id: other.slotIds[0], contact: { phone: '+919876500005' } },
        randomUUID(),
        other,
      );
      const res = await post(`/appointments/${theirs.body.appointment_id}/reschedule`, { new_slot_id: f.slotIds[5] });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TENANT_MISMATCH');
    });

    it('two concurrent reschedules into one slot: exactly one wins', async () => {
      const a = await book(5, '+919876500006');
      const b = await book(6, '+919876500007');
      const target = await extraSlot();
      const [ra, rb] = await Promise.all([
        post(`/appointments/${a.body.appointment_id}/reschedule`, { new_slot_id: target }),
        post(`/appointments/${b.body.appointment_id}/reschedule`, { new_slot_id: target }),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    });
  });

  describe('cancelAppointment', () => {
    it('cancels, frees the slot, and is idempotent on repeat', async () => {
      const a = await book(7, '+919876500008');
      const res = await post(`/appointments/${a.body.appointment_id}/cancel`, { reason: 'feeling better' });
      expect(res.status).toBe(200);
      expectContract(res.body, '/appointments/{appointment_id}/cancel', 'post', 200);
      expect(res.body.status).toBe('cancelled');
      expect(await slotStatus(f.slotIds[7]!)).toBe('open');

      const again = await post(`/appointments/${a.body.appointment_id}/cancel`, {});
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('cancelled');
    });

    it('accepts an empty body', async () => {
      const slot = await extraSlot();
      const a = await post('/appointments', { slot_id: slot, contact: { phone: '+919876500009' } });
      const res = await ctx
        .http()
        .post(`/internal/v1/appointments/${a.body.appointment_id}/cancel`)
        .set(await serviceHeaders(ctx, f))
        .set('Idempotency-Key', randomUUID());
      expect(res.status).toBe(200);
    });

    it('cannot reschedule a cancelled appointment (POLICY_BLOCKED)', async () => {
      const slot = await extraSlot();
      const a = await post('/appointments', { slot_id: slot, contact: { phone: '+919876500010' } });
      await post(`/appointments/${a.body.appointment_id}/cancel`, {});
      const res = await post(`/appointments/${a.body.appointment_id}/reschedule`, { new_slot_id: await extraSlot() });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('POLICY_BLOCKED');
    });

    it('enforces the tenant cancel window with 422 POLICY_BLOCKED', async () => {
      const strict = await seedTenant(ctx, { settings: { cancel_cutoff_minutes: 60 * 24 * 30 } });
      const a = await post(
        '/appointments',
        { slot_id: strict.slotIds[0], contact: { phone: '+919876500011' } },
        randomUUID(),
        strict,
      );
      const res = await post(`/appointments/${a.body.appointment_id}/cancel`, {}, randomUUID(), strict);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('POLICY_BLOCKED');
      expectErrorContract(res.body);
    });

    it('returns NOT_FOUND for an unknown appointment', async () => {
      const res = await post(`/appointments/${randomUUID()}/cancel`, {});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('listAppointments', () => {
    it('lists upcoming active appointments for a contact', async () => {
      const s1 = await extraSlot();
      const s2 = await extraSlot();
      const a = await post('/appointments', { slot_id: s1, contact: { phone: '+919876500012' } });
      const b = await post('/appointments', { slot_id: s2, contact: { contact_id: a.body.contact_id } });
      await post(`/appointments/${b.body.appointment_id}/cancel`, {});

      const res = await ctx
        .http()
        .get('/internal/v1/appointments')
        .query({ contact_id: a.body.contact_id })
        .set(await serviceHeaders(ctx, f));
      expect(res.status).toBe(200);
      expectContract(res.body, '/appointments', 'get', 200);
      expect(res.body.appointments.map((x: { appointment_id: string }) => x.appointment_id)).toEqual([
        a.body.appointment_id,
      ]);

      const all = await ctx
        .http()
        .get('/internal/v1/appointments')
        .query({ contact_id: a.body.contact_id, status: 'all' })
        .set(await serviceHeaders(ctx, f));
      expect(all.body.appointments).toHaveLength(2);
    });

    it('requires contact_id', async () => {
      const res = await ctx
        .http()
        .get('/internal/v1/appointments')
        .set(await serviceHeaders(ctx, f));
      expect(res.status).toBe(400);
    });
  });

  let n = 0;
  async function extraSlot(): Promise<string> {
    n += 1;
    const start = new Date(f.slotStarts[0]!.getTime() + 2 * 24 * 3600_000 + n * 30 * 60_000);
    const { rows } = await ctx.owner.query<{ id: string }>(
      `INSERT INTO slots (tenant_id, provider_id, starts_at, ends_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [f.tenantId, f.providerId, start, new Date(start.getTime() + 30 * 60_000)],
    );
    return rows[0]!.id;
  }
});
