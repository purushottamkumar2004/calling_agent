import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { OutboxRelayService, STREAM_FIELD } from '../src/events/outbox-relay.service';
import {
  expectContract,
  expectErrorContract,
  expectEventContract,
  type Fixture,
  seedTenant,
  serviceHeaders,
  startApp,
  type TestContext,
} from './helpers';

describe('booking (bookAppointment) with double-booking protection', () => {
  let ctx: TestContext;
  let f: Fixture;
  let other: Fixture;
  let redis: Redis;

  beforeAll(async () => {
    ctx = await startApp();
    redis = new Redis(ctx.config.REDIS_URL);
    await redis.flushdb();
    f = await seedTenant(ctx, { slots: 8 });
    other = await seedTenant(ctx);
  });
  afterAll(async () => {
    redis.disconnect();
    await ctx.close();
  });

  const book = async (body: unknown, key: string = randomUUID(), fx: Fixture = f) =>
    ctx
      .http()
      .post('/internal/v1/appointments')
      .set(await serviceHeaders(ctx, fx))
      .set('Idempotency-Key', key)
      .send(body as object);

  const outboxFor = async (appointmentId: string) =>
    (
      await ctx.owner.query<{ envelope: { payload: { appointment_id: string } } }>(
        `SELECT envelope FROM outbox WHERE envelope->'payload'->>'appointment_id' = $1`,
        [appointmentId],
      )
    ).rows.map((r) => r.envelope);

  it('books a slot for a new caller, matching the contract', async () => {
    const res = await book({
      slot_id: f.slotIds[0],
      contact: { phone: '+919876543210', name: 'Asha Patil', language: 'hi-IN' },
      reason: 'fever follow-up',
    });
    expect(res.status).toBe(201);
    expectContract(res.body, '/appointments', 'post', 201);
    expect(res.body).toMatchObject({
      status: 'booked',
      source: 'call',
      slot: { slot_id: f.slotIds[0], provider_name: 'Dr. Mehta' },
    });

    const { rows } = await ctx.owner.query(
      `SELECT a.call_id, s.status AS slot_status, c.phone_ciphertext, c.name FROM appointments a
         JOIN slots s ON s.id = a.slot_id JOIN contacts c ON c.id = a.contact_id WHERE a.id = $1`,
      [res.body.appointment_id],
    );
    expect(rows[0]).toMatchObject({ call_id: f.callId, slot_status: 'booked', name: 'Asha Patil' });
    expect(rows[0].phone_ciphertext).not.toContain('9876543210');
  });

  it('writes a contract-valid appointment.booked event to the outbox and relays it to Redis', async () => {
    const res = await book({ slot_id: f.slotIds[1], contact: { phone: '+919811112222', name: 'Ravi' } });
    const events = await outboxFor(res.body.appointment_id);
    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expectEventContract(event);
    expect(event).toMatchObject({
      event_type: 'appointment.booked',
      schema_version: 1,
      producer: 'api',
      tenant_id: f.tenantId,
      call_id: f.callId,
      payload: {
        appointment_id: res.body.appointment_id,
        phone: '+919811112222',
        contact_name: 'Ravi',
        source: 'call',
        consent_whatsapp: false,
        slot: { provider_name: 'Dr. Mehta', timezone: 'Asia/Kolkata', location_name: 'Sunrise Clinic, Baner' },
      },
    });

    const relay = ctx.app.get(OutboxRelayService);
    while ((await relay.publishBatch()) > 0);
    const entries = await redis.xrange('events:appointment', '-', '+');
    const published = entries.map(([, fields]) => JSON.parse(fields[fields.indexOf(STREAM_FIELD) + 1] as string));
    const mine = published.find((e) => e.payload.appointment_id === res.body.appointment_id);
    expect(mine).toEqual(event);
    const { rows } = await ctx.owner.query('SELECT published_at FROM outbox WHERE event_id = $1', [mine.event_id]);
    expect(rows[0].published_at).not.toBeNull();
  });

  it('reuses the contact for the same phone number', async () => {
    const r1 = await book({ slot_id: f.slotIds[2], contact: { phone: '+919800000001', name: 'Meena' } });
    const r2 = await book({ slot_id: f.slotIds[3], contact: { phone: '+919800000001', name: 'Someone Else' } });
    expect(r2.body.contact_id).toBe(r1.body.contact_id);
    const { rows } = await ctx.owner.query('SELECT name FROM contacts WHERE id = $1', [r1.body.contact_id]);
    expect(rows[0].name).toBe('Meena');
  });

  it('books by existing contact_id', async () => {
    const r1 = await book({ slot_id: f.slotIds[4], contact: { phone: '+919800000002' } });
    await ctx
      .http()
      .post(`/internal/v1/appointments/${r1.body.appointment_id}/cancel`)
      .set(await serviceHeaders(ctx, f))
      .set('Idempotency-Key', randomUUID())
      .send({});
    const r2 = await book({ slot_id: f.slotIds[4], contact: { contact_id: r1.body.contact_id } });
    expect(r2.status).toBe(201);
    expect(r2.body.contact_id).toBe(r1.body.contact_id);
  });

  it('returns 409 SLOT_TAKEN with nearby alternatives when the slot is booked', async () => {
    const res = await book({ slot_id: f.slotIds[0], contact: { phone: '+919811113333' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_TAKEN');
    expectErrorContract(res.body);
    const alts = res.body.error.details.alternatives as Array<{ slot_id: string }>;
    expect(alts.length).toBeGreaterThan(0);
    expect(alts.map((a) => a.slot_id)).not.toContain(f.slotIds[0]);
  });

  it('allows exactly one winner when many callers race for the same slot', async () => {
    const target = f.slotIds[5];
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        book({ slot_id: target, contact: { phone: `+91990000${String(i).padStart(4, '0')}` } }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(24);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('SLOT_TAKEN');

    const { rows } = await ctx.owner.query(
      `SELECT count(*)::int AS n FROM appointments WHERE slot_id = $1 AND status IN ('booked', 'rescheduled')`,
      [target],
    );
    expect(rows[0].n).toBe(1);
    const events = await ctx.owner.query(
      `SELECT count(*)::int AS n FROM outbox o JOIN appointments a ON a.id = (o.envelope->'payload'->>'appointment_id')::uuid WHERE a.slot_id = $1`,
      [target],
    );
    expect(events.rows[0].n).toBe(1);
  });

  describe('idempotency', () => {
    it('replays the original response for a retried tool call and books once', async () => {
      const key = `${f.callId}:tc_${randomUUID()}`;
      const body = { slot_id: f.slotIds[6], contact: { phone: '+919822223333' } };
      const first = await book(body, key);
      const retry = await book(body, key);
      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(await outboxFor(first.body.appointment_id)).toHaveLength(1);
    });

    it('handles concurrent duplicates of the same key', async () => {
      const key = `${f.callId}:tc_${randomUUID()}`;
      const body = { slot_id: f.slotIds[7], contact: { phone: '+919822224444' } };
      const results = await Promise.all(Array.from({ length: 5 }, () => book(body, key)));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(new Set(results.map((r) => r.body.appointment_id)).size).toBe(1);
    });

    it('rejects reuse of a key with a different body', async () => {
      const key = `k-${randomUUID()}`;
      const slot = await seedTenantSlot();
      expect((await book({ slot_id: slot, contact: { phone: '+919800000010' } }, key)).status).toBe(201);
      const reused = await book({ slot_id: slot, contact: { phone: '+919800000011' } }, key);
      expect(reused.status).toBe(400);
      expect(reused.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('does not store failures: a retried failed request is re-evaluated', async () => {
      const key = `k-${randomUUID()}`;
      const body = { slot_id: f.slotIds[0], contact: { phone: '+919800000009' } };
      expect((await book(body, key)).status).toBe(409);
      const retry = await book(body, key);
      expect(retry.status).toBe(409);
      expect(retry.headers['idempotent-replayed']).toBeUndefined();
    });

    it('requires Idempotency-Key on writes', async () => {
      const res = await ctx
        .http()
        .post('/internal/v1/appointments')
        .set(await serviceHeaders(ctx, f))
        .send({ slot_id: f.slotIds[0], contact: { phone: '+919800000012' } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('scopes keys per tenant', async () => {
      const key = `shared-${randomUUID()}`;
      const mine = await book({ slot_id: await seedTenantSlot(), contact: { phone: '+919800000013' } }, key);
      const theirs = await book({ slot_id: other.slotIds[0], contact: { phone: '+919800000013' } }, key, other);
      expect(mine.status).toBe(201);
      expect(theirs.status).toBe(201);
      expect(theirs.body.appointment_id).not.toBe(mine.body.appointment_id);
    });
  });

  it("rejects booking another tenant's slot with TENANT_MISMATCH and an unknown slot with NOT_FOUND", async () => {
    const cross = await book({ slot_id: other.slotIds[1], contact: { phone: '+919800000020' } });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('TENANT_MISMATCH');
    const missing = await book({ slot_id: randomUUID(), contact: { phone: '+919800000020' } });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects past slots with POLICY_BLOCKED', async () => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      `INSERT INTO slots (tenant_id, provider_id, starts_at, ends_at) VALUES ($1, $2, now() - interval '3 hours', now() - interval '150 minutes') RETURNING id`,
      [f.tenantId, f.provider2Id],
    );
    const res = await book({ slot_id: rows[0]!.id, contact: { phone: '+919800000021' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('POLICY_BLOCKED');
  });

  it.each([
    [{ contact: { phone: '+919800000022' } }],
    [{ slot_id: 'nope', contact: { phone: '+919800000022' } }],
    [{ slot_id: randomUUID(), contact: {} }],
    [{ slot_id: randomUUID(), contact: { phone: '9876543210' } }],
    [{ slot_id: randomUUID(), contact: { phone: '+919800000022', language: 'ta-IN' } }],
    [{ slot_id: randomUUID(), contact: { phone: '+919800000022' }, reason: 'x'.repeat(301) }],
  ])('rejects invalid body %j with VALIDATION_ERROR', async (body) => {
    const res = await book(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  let extraSlot = 0;
  async function seedTenantSlot(): Promise<string> {
    extraSlot += 1;
    const start = new Date(f.slotStarts[0]!.getTime() + 24 * 3600_000 + extraSlot * 30 * 60_000);
    const { rows } = await ctx.owner.query<{ id: string }>(
      `INSERT INTO slots (tenant_id, provider_id, starts_at, ends_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [f.tenantId, f.provider2Id, start, new Date(start.getTime() + 30 * 60_000)],
    );
    return rows[0]!.id;
  }
});
