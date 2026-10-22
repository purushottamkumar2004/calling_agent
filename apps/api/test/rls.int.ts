import { randomUUID } from 'node:crypto';
import { DbService } from '../src/db/db.service';
import { type Fixture, seedTenant, startApp, type TestContext } from './helpers';

describe('row-level security (service role)', () => {
  let ctx: TestContext;
  let db: DbService;
  let a: Fixture;
  let b: Fixture;

  beforeAll(async () => {
    ctx = await startApp();
    db = ctx.app.get(DbService);
    a = await seedTenant(ctx);
    b = await seedTenant(ctx, { name: 'Other Clinic' });
  });
  afterAll(() => ctx.close());

  const tables = ['tenants', 'users', 'locations', 'providers', 'slots', 'calls'];

  it.each(tables)('%s: a tenant only sees its own rows', async (table) => {
    const rows = await db.tenantTx(a.tenantId, async (tx) => (await tx.query(`SELECT * FROM ${table}`)).rows);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(table === 'tenants' ? row.id : row.tenant_id).toBe(a.tenantId);
  });

  it.each(tables)('%s: nothing is visible with no tenant bound', async (table) => {
    const rows = await db.systemTx(async (tx) => (await tx.query(`SELECT * FROM ${table}`)).rows);
    expect(rows).toHaveLength(0);
  });

  it("cannot write rows into another tenant's scope", async () => {
    await expect(
      db.tenantTx(a.tenantId, (tx) =>
        tx.query(
          "INSERT INTO slots (tenant_id, provider_id, starts_at, ends_at) VALUES ($1, $2, now() + interval '30 days', now() + interval '30 days 30 min')",
          [b.tenantId, b.providerId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update another tenant's rows (they are invisible)", async () => {
    const result = await db.tenantTx(a.tenantId, (tx) =>
      tx.query(`UPDATE slots SET status = 'blocked' WHERE id = $1`, [b.slotIds[0]]),
    );
    expect(result.rowCount).toBe(0);
  });

  it('cannot read the outbox or bypass RLS directly', async () => {
    await expect(db.systemTx((tx) => tx.query('SELECT * FROM outbox'))).rejects.toThrow(/permission denied/);
    await expect(db.systemTx((tx) => tx.query('ALTER TABLE slots DISABLE ROW LEVEL SECURITY'))).rejects.toThrow();
  });

  it('does not leak the tenant binding across pooled connections', async () => {
    await db.tenantTx(a.tenantId, (tx) => tx.query('SELECT 1'));
    const setting = await db.systemTx(
      async (tx) =>
        (await tx.query<{ t: string | null }>("SELECT current_setting('app.tenant_id', true) AS t")).rows[0]?.t,
    );
    expect(setting ?? '').toBe('');
  });

  it('resource_tenant reports the owner without exposing data', async () => {
    const owner = await db.tenantTx(
      a.tenantId,
      async (tx) =>
        (await tx.query<{ o: string }>('SELECT resource_tenant($1, $2) AS o', ['slot', b.slotIds[0]])).rows[0]?.o,
    );
    expect(owner).toBe(b.tenantId);
    const none = await db.systemTx(
      async (tx) =>
        (await tx.query<{ o: string | null }>('SELECT resource_tenant($1, $2) AS o', ['call', randomUUID()])).rows[0]
          ?.o,
    );
    expect(none).toBeNull();
  });
});

describe('schema-level double-booking guards', () => {
  let ctx: TestContext;
  let f: Fixture;

  beforeAll(async () => {
    ctx = await startApp();
    f = await seedTenant(ctx);
  });
  afterAll(() => ctx.close());

  it('rejects overlapping slots for the same provider', async () => {
    const start = new Date(f.slotStarts[0]!.getTime() + 10 * 60_000);
    await expect(
      ctx.owner.query('INSERT INTO slots (tenant_id, provider_id, starts_at, ends_at) VALUES ($1, $2, $3, $4)', [
        f.tenantId,
        f.providerId,
        start,
        new Date(start.getTime() + 30 * 60_000),
      ]),
    ).rejects.toMatchObject({ constraint: 'slots_no_overlap' });
  });

  it('allows the same time for a different provider', async () => {
    await expect(
      ctx.owner.query('INSERT INTO slots (tenant_id, provider_id, starts_at, ends_at) VALUES ($1, $2, $3, $4)', [
        f.tenantId,
        f.provider2Id,
        f.slotStarts[0],
        new Date(f.slotStarts[0]!.getTime() + 30 * 60_000),
      ]),
    ).resolves.toBeDefined();
  });

  it('rejects a second active appointment on one slot even if the app is bypassed', async () => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, phone_ciphertext, phone_hash) VALUES ($1, 'x', '\\x01') RETURNING id`,
      [f.tenantId],
    );
    const insert = () =>
      ctx.owner.query(
        `INSERT INTO appointments (tenant_id, contact_id, slot_id, status, source) VALUES ($1, $2, $3, 'booked', 'import')`,
        [f.tenantId, rows[0]!.id, f.slotIds[5]],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ constraint: 'appointments_one_active_per_slot' });
  });
});
