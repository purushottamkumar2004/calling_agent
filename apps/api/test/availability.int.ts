import { randomUUID } from 'node:crypto';
import {
  expectContract,
  expectErrorContract,
  type Fixture,
  nextMondayIst,
  seedTenant,
  serviceHeaders,
  startApp,
  type TestContext,
} from './helpers';

describe('GET /internal/v1/availability (checkAvailability)', () => {
  let ctx: TestContext;
  let f: Fixture;
  let other: Fixture;
  const path = '/internal/v1/availability';

  beforeAll(async () => {
    ctx = await startApp();
    f = await seedTenant(ctx, { slots: 8 });
    other = await seedTenant(ctx);
    // A past slot and a blocked slot must never be offered.
    await ctx.owner.query(
      `INSERT INTO slots (tenant_id, provider_id, starts_at, ends_at) VALUES ($1, $2, now() - interval '2 hours', now() - interval '90 minutes')`,
      [f.tenantId, f.providerId],
    );
    await ctx.owner.query(`UPDATE slots SET status = 'blocked' WHERE id = $1`, [f.slotIds[0]]);
  });
  afterAll(() => ctx.close());

  const week = () => ({ from: new Date().toISOString(), to: new Date(Date.now() + 15 * 86_400_000).toISOString() });

  it('returns open future slots soonest first, contract-shaped, with speakable text', async () => {
    const res = await ctx
      .http()
      .get(path)
      .query({ ...week(), limit: 20 })
      .set(await serviceHeaders(ctx, f));
    expect(res.status).toBe(200);
    expectContract(res.body, '/availability', 'get', 200);
    const slots = res.body.slots as Array<{ slot_id: string; start: string; speakable: string; provider_name: string }>;
    expect(slots.map((s) => s.slot_id)).toEqual(f.slotIds.slice(1));
    expect(slots[0]!.provider_name).toBe('Dr. Mehta');
    expect(slots[0]!.speakable).toMatch(/^Monday \d{1,2} \w+ at 10:30 AM$/);
    const starts = slots.map((s) => Date.parse(s.start));
    expect([...starts].sort((x, y) => x - y)).toEqual(starts);
  });

  it('defaults limit to 5 and caps at 20', async () => {
    const res = await ctx
      .http()
      .get(path)
      .query(week())
      .set(await serviceHeaders(ctx, f));
    expect(res.body.slots).toHaveLength(5);
    const over = await ctx
      .http()
      .get(path)
      .query({ ...week(), limit: 21 })
      .set(await serviceHeaders(ctx, f));
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('filters by provider, specialty and location', async () => {
    const byProvider = await ctx
      .http()
      .get(path)
      .query({ ...week(), provider_id: f.provider2Id })
      .set(await serviceHeaders(ctx, f));
    expect(byProvider.body.slots).toEqual([]);
    const bySpecialty = await ctx
      .http()
      .get(path)
      .query({ ...week(), specialty: 'GENERAL' })
      .set(await serviceHeaders(ctx, f));
    expect(bySpecialty.body.slots.length).toBe(5);
    const none = await ctx
      .http()
      .get(path)
      .query({ ...week(), specialty: 'dermatology' })
      .set(await serviceHeaders(ctx, f));
    expect(none.body.slots).toEqual([]);
    const byLocation = await ctx
      .http()
      .get(path)
      .query({ ...week(), location_id: f.locationId })
      .set(await serviceHeaders(ctx, f));
    expect(byLocation.body.slots.length).toBe(5);
  });

  it("never returns another tenant's slots and flags their provider as TENANT_MISMATCH", async () => {
    const res = await ctx
      .http()
      .get(path)
      .query({ ...week(), limit: 20 })
      .set(await serviceHeaders(ctx, f));
    const ids = (res.body.slots as Array<{ slot_id: string }>).map((s) => s.slot_id);
    for (const id of other.slotIds) expect(ids).not.toContain(id);

    const cross = await ctx
      .http()
      .get(path)
      .query({ ...week(), provider_id: other.providerId })
      .set(await serviceHeaders(ctx, f));
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('TENANT_MISMATCH');
    const missing = await ctx
      .http()
      .get(path)
      .query({ ...week(), provider_id: randomUUID() })
      .set(await serviceHeaders(ctx, f));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 422 OUTSIDE_HOURS with the nearest open slots for a window when the clinic is closed', async () => {
    // Sunday before the slots (clinic closed all day).
    const sunday = new Date(nextMondayIst(0, 0).getTime() - 24 * 3600_000);
    const res = await ctx
      .http()
      .get(path)
      .query({ from: sunday.toISOString(), to: new Date(sunday.getTime() + 23 * 3600_000).toISOString() })
      .set(await serviceHeaders(ctx, f));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OUTSIDE_HOURS');
    expectErrorContract(res.body);
    expect(res.body.error.details.alternatives[0].slot_id).toBe(f.slotIds[1]);
  });

  it('returns an empty list (not OUTSIDE_HOURS) when open hours are simply full', async () => {
    const tuesday = nextMondayIst(16, 0);
    const from = new Date(tuesday.getTime() + 24 * 3600_000);
    const res = await ctx
      .http()
      .get(path)
      .query({ from: from.toISOString(), to: new Date(from.getTime() + 3600_000).toISOString() })
      .set(await serviceHeaders(ctx, f));
    expect(res.status).toBe(200);
    expect(res.body.slots).toEqual([]);
  });

  it.each([
    [{ from: 'tomorrow', to: new Date().toISOString() }],
    [{ to: new Date().toISOString() }],
    [{ from: new Date(Date.now() + 3600_000).toISOString(), to: new Date().toISOString() }],
    [{ from: new Date().toISOString(), to: new Date(Date.now() + 40 * 86_400_000).toISOString() }],
    [
      {
        ...{ from: new Date().toISOString(), to: new Date(Date.now() + 3600_000).toISOString() },
        provider_id: 'not-a-uuid',
      },
    ],
  ])('rejects bad query %j with VALIDATION_ERROR', async (q) => {
    const res = await ctx
      .http()
      .get(path)
      .query(q)
      .set(await serviceHeaders(ctx, f));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expectErrorContract(res.body);
  });
});
