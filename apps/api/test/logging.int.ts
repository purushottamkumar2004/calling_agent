import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { type Fixture, seedTenant, serviceHeaders, startApp, type TestContext } from './helpers';

describe('structured logging', () => {
  let ctx: TestContext;
  let f: Fixture;
  const lines: Array<Record<string, unknown>> = [];
  const raw: string[] = [];

  beforeAll(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          raw.push(line);
          lines.push(JSON.parse(line));
        }
        cb();
      },
    });
    ctx = await startApp({ LOG_LEVEL: 'info' }, stream);
    f = await seedTenant(ctx);
  });
  afterAll(() => ctx.close());

  it('stamps tenant_id, call_id and request_id on every line of a call-scoped request', async () => {
    lines.length = 0;
    raw.length = 0;
    const requestId = `req-${randomUUID()}`;
    const res = await ctx
      .http()
      .post('/internal/v1/appointments')
      .set(await serviceHeaders(ctx, f))
      .set('Idempotency-Key', randomUUID())
      .set('X-Request-Id', requestId)
      .send({ slot_id: f.slotIds[0], contact: { phone: '+919812345678', name: 'Log Test' } });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));

    const mine = lines.filter((l) => l.request_id === requestId);
    if (process.env.PRINT_LOGS) process.stdout.write(`${mine.map((l) => JSON.stringify(l)).join('\n')}\n`);
    expect(mine.map((l) => l.message)).toEqual(expect.arrayContaining(['appointment booked', 'request completed']));
    for (const line of mine) {
      expect(line).toMatchObject({ service: 'core-api', tenant_id: f.tenantId, call_id: f.callId });
    }
    // Phone numbers and credentials never reach the logs.
    expect(raw.join('\n')).not.toContain('9812345678');
    expect(raw.join('\n')).not.toMatch(/Bearer [A-Za-z0-9]/);
  });
});
