import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { expectErrorContract, type Fixture, seedTenant, serviceHeaders, startApp, type TestContext } from './helpers';

describe('internal API authentication and tenant/call binding', () => {
  let ctx: TestContext;
  let a: Fixture;
  let b: Fixture;
  const path = '/internal/v1/availability';
  const query = () => ({ from: new Date().toISOString(), to: new Date(Date.now() + 14 * 86_400_000).toISOString() });

  beforeAll(async () => {
    ctx = await startApp();
    a = await seedTenant(ctx);
    b = await seedTenant(ctx);
  });
  afterAll(() => ctx.close());

  const sign = (claims: { iss?: string; aud?: string; ttl?: number }, secret = ctx.config.SERVICE_JWT_SECRET) => {
    const jwt = new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuedAt();
    if (claims.iss) jwt.setIssuer(claims.iss);
    jwt.setAudience(claims.aud ?? 'core-api');
    jwt.setExpirationTime(Math.floor(Date.now() / 1000) + (claims.ttl ?? 60));
    return jwt.sign(Buffer.from(secret, 'base64'));
  };

  it('accepts a valid service token for a call the tenant owns', async () => {
    const res = await ctx.http().get(path).query(query()).set(await serviceHeaders(ctx, a));
    expect(res.status).toBe(200);
  });

  it.each([
    ['no token', async () => undefined],
    ['wrong secret', async () => sign({ iss: 'voice-worker' }, Buffer.alloc(32, 7).toString('base64'))],
    ['issuer not allowed', async () => sign({ iss: 'web' })],
    ['wrong audience', async () => sign({ iss: 'voice-worker', aud: 'dashboard' })],
    ['expired', async () => sign({ iss: 'voice-worker', ttl: -60 })],
    ['lifetime too long', async () => sign({ iss: 'voice-worker', ttl: 3600 })],
    ['user token', async () => ctx.jwt.signUserAccessToken({ userId: a.users.owner.id, tenantId: a.tenantId, role: 'owner' })],
  ])('rejects %s with 401 UNAUTHORIZED', async (_name, token) => {
    const t = await token();
    const req = ctx.http().get(path).query(query()).set({ 'X-Tenant-Id': a.tenantId, 'X-Call-Id': a.callId });
    if (t) req.set('Authorization', `Bearer ${t}`);
    const res = await req;
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expectErrorContract(res.body);
  });

  it('requires X-Tenant-Id and X-Call-Id', async () => {
    const h = await serviceHeaders(ctx, a);
    const res = await ctx.http().get(path).query(query()).set({ Authorization: h.Authorization, 'X-Tenant-Id': a.tenantId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it("rejects a tenant using another tenant's call with 403 TENANT_MISMATCH", async () => {
    const res = await ctx.http().get(path).query(query()).set(await serviceHeaders(ctx, { tenantId: a.tenantId, callId: b.callId }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
    expectErrorContract(res.body);
  });

  it('rejects an unknown call the same way (no existence oracle)', async () => {
    const res = await ctx.http().get(path).query(query()).set(await serviceHeaders(ctx, { tenantId: a.tenantId, callId: randomUUID() }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
  });

  it('echoes a request id for log correlation', async () => {
    const res = await ctx.http().get(path).query(query()).set(await serviceHeaders(ctx, a)).set('X-Request-Id', 'req-12345678');
    expect(res.headers['x-request-id']).toBe('req-12345678');
  });

  it('returns NOT_FOUND in the error envelope for unknown routes', async () => {
    const res = await ctx.http().get('/internal/v1/nope').set(await serviceHeaders(ctx, a));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns VALIDATION_ERROR for malformed JSON', async () => {
    const res = await ctx
      .http()
      .post('/internal/v1/appointments')
      .set(await serviceHeaders(ctx, a))
      .set('Idempotency-Key', 'k')
      .set('Content-Type', 'application/json')
      .send('{"slot_id":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
