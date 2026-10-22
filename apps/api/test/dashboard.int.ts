import { randomUUID } from 'node:crypto';
import { type Fixture, seedTenant, startApp, type TestContext, userToken } from './helpers';

describe('dashboard auth and scheduling API', () => {
  let ctx: TestContext;
  let f: Fixture;
  let other: Fixture;

  beforeAll(async () => {
    ctx = await startApp();
    f = await seedTenant(ctx);
    other = await seedTenant(ctx);
  });
  afterAll(() => ctx.close());

  describe('auth', () => {
    it('logs in, exposes /me, and rejects bad credentials uniformly', async () => {
      const ok = await ctx.http().post('/v1/auth/login').send({ email: f.users.admin.email.toUpperCase(), password: f.users.admin.password });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
      const me = await ctx.http().get('/v1/auth/me').set('Authorization', `Bearer ${ok.body.access_token}`);
      expect(me.body).toEqual({ tenant_id: f.tenantId, user_id: f.users.admin.id, role: 'admin' });

      const wrong = await ctx.http().post('/v1/auth/login').send({ email: f.users.admin.email, password: 'nope' });
      const unknown = await ctx.http().post('/v1/auth/login').send({ email: 'ghost@example.com', password: 'nope' });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
    });

    it('rotates refresh tokens and revokes the family on reuse', async () => {
      const login = await ctx.http().post('/v1/auth/login').send({ email: f.users.staff.email, password: f.users.staff.password });
      const r1 = login.body.refresh_token;
      const refreshed = await ctx.http().post('/v1/auth/refresh').send({ refresh_token: r1 });
      expect(refreshed.status).toBe(200);
      const r2 = refreshed.body.refresh_token;
      expect(r2).not.toBe(r1);

      const reuse = await ctx.http().post('/v1/auth/refresh').send({ refresh_token: r1 });
      expect(reuse.status).toBe(401);
      // Reuse of r1 revoked r2 as well.
      expect((await ctx.http().post('/v1/auth/refresh').send({ refresh_token: r2 })).status).toBe(401);
    });

    it('logout revokes the refresh token', async () => {
      const login = await ctx.http().post('/v1/auth/login').send({ email: f.users.owner.email, password: f.users.owner.password });
      expect((await ctx.http().post('/v1/auth/logout').send({ refresh_token: login.body.refresh_token })).status).toBe(204);
      expect((await ctx.http().post('/v1/auth/refresh').send({ refresh_token: login.body.refresh_token })).status).toBe(401);
    });

    it('rejects disabled users', async () => {
      await ctx.owner.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [other.users.staff.id]);
      const res = await ctx.http().post('/v1/auth/login').send({ email: other.users.staff.email, password: other.users.staff.password });
      expect(res.status).toBe(401);
    });

    it('rejects service tokens on dashboard routes', async () => {
      const res = await ctx.http().get('/v1/auth/me').set('Authorization', `Bearer ${await ctx.jwt.signServiceToken('voice-worker')}`);
      expect(res.status).toBe(401);
    });
  });

  describe('slots', () => {
    const later = (days: number, hour: number) => {
      const d = new Date(f.slotStarts[0]!.getTime() + days * 86_400_000);
      d.setUTCHours(hour, 0, 0, 0);
      return d;
    };

    it('lets owners/admins create slots and forbids staff', async () => {
      const body = { slots: [{ provider_id: f.provider2Id, start: later(1, 5).toISOString(), end: later(1, 6).toISOString() }] };
      const staff = await ctx.http().post('/v1/slots').set('Authorization', `Bearer ${await userToken(ctx, f, 'staff')}`).send(body);
      expect(staff.status).toBe(403);
      expect(staff.body.error.code).toBe('FORBIDDEN');

      const admin = await ctx.http().post('/v1/slots').set('Authorization', `Bearer ${await userToken(ctx, f, 'admin')}`).send(body);
      expect(admin.status).toBe(201);
      expect(admin.body.slots[0]).toMatchObject({ provider_id: f.provider2Id, status: 'open' });
    });

    it('rejects a batch with overlaps atomically (409 CONFLICT)', async () => {
      const token = await userToken(ctx, f, 'owner');
      const res = await ctx
        .http()
        .post('/v1/slots')
        .set('Authorization', `Bearer ${token}`)
        .send({
          slots: [
            { provider_id: f.provider2Id, start: later(2, 5).toISOString(), end: later(2, 6).toISOString() },
            { provider_id: f.provider2Id, start: new Date(later(2, 5).getTime() + 1800_000).toISOString(), end: later(2, 7).toISOString() },
          ],
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      const { rows } = await ctx.owner.query('SELECT count(*)::int AS n FROM slots WHERE provider_id = $1 AND starts_at = $2', [
        f.provider2Id,
        later(2, 5),
      ]);
      expect(rows[0].n).toBe(0);
    });

    it("rejects another tenant's provider", async () => {
      const res = await ctx
        .http()
        .post('/v1/slots')
        .set('Authorization', `Bearer ${await userToken(ctx, f, 'owner')}`)
        .send({ slots: [{ provider_id: other.providerId, start: later(3, 5).toISOString(), end: later(3, 6).toISOString() }] });
      expect(res.status).toBe(400);
    });

    it('blocks and reopens slots, but never a booked one', async () => {
      const token = await userToken(ctx, f, 'admin');
      const blocked = await ctx.http().patch(`/v1/slots/${f.slotIds[0]}`).set('Authorization', `Bearer ${token}`).send({ status: 'blocked' });
      expect(blocked.body.status).toBe('blocked');
      await ctx.http().patch(`/v1/slots/${f.slotIds[0]}`).set('Authorization', `Bearer ${token}`).send({ status: 'open' });

      await ctx
        .http()
        .post('/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({ slot_id: f.slotIds[1], contact: { phone: '+919700000001', name: 'Walk-in' } });
      const res = await ctx.http().patch(`/v1/slots/${f.slotIds[1]}`).set('Authorization', `Bearer ${token}`).send({ status: 'blocked' });
      expect(res.status).toBe(409);
    });
  });

  describe('appointments', () => {
    it('books with source=dashboard and lists by window', async () => {
      const token = await userToken(ctx, f, 'staff');
      const res = await ctx
        .http()
        .post('/v1/appointments')
        .set('Authorization', `Bearer ${token}`)
        .send({ slot_id: f.slotIds[2], contact: { phone: '+919700000002' } });
      expect(res.status).toBe(201);
      expect(res.body.source).toBe('dashboard');
      const { rows } = await ctx.owner.query(`SELECT envelope FROM outbox WHERE envelope->'payload'->>'appointment_id' = $1`, [
        res.body.appointment_id,
      ]);
      expect(rows[0].envelope).toMatchObject({ call_id: null, payload: { source: 'dashboard' } });

      const list = await ctx
        .http()
        .get('/v1/appointments')
        .query({ from: new Date().toISOString(), to: new Date(Date.now() + 30 * 86_400_000).toISOString() })
        .set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(200);
      expect(list.body.appointments.map((a: { appointment_id: string }) => a.appointment_id)).toContain(res.body.appointment_id);
    });

    it("hides other tenants' appointments as NOT_FOUND (no TENANT_MISMATCH oracle for users)", async () => {
      const mine = await ctx
        .http()
        .post('/v1/appointments')
        .set('Authorization', `Bearer ${await userToken(ctx, f, 'staff')}`)
        .send({ slot_id: f.slotIds[3], contact: { phone: '+919700000003' } });
      const res = await ctx
        .http()
        .post(`/v1/appointments/${mine.body.appointment_id}/cancel`)
        .set('Authorization', `Bearer ${await userToken(ctx, other, 'owner')}`)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('requires authentication', async () => {
      const res = await ctx.http().get('/v1/appointments').query({ from: new Date().toISOString(), to: new Date().toISOString() });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(randomUUID()).toBeDefined();
    });
  });
});
