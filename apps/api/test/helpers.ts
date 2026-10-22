import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { Pool } from 'pg';
import request from 'supertest';
import { parse as parseYaml } from 'yaml';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/passwords';
import { JwtService } from '../src/auth/jwt';
import type { AppConfig } from '../src/config/env';
import { FieldCrypto } from '../src/crypto/field-crypto';
import { testUrls } from './env';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const { appUrl, redisUrl } = testUrls();
  const key = () => randomBytes(32).toString('base64');
  return {
    NODE_ENV: 'test',
    PORT: 0,
    LOG_LEVEL: 'silent',
    DATABASE_URL: appUrl,
    DB_POOL_MAX: 30,
    DB_STATEMENT_TIMEOUT_MS: 5000,
    REDIS_URL: redisUrl,
    USER_JWT_SECRET: key(),
    ACCESS_TOKEN_TTL_SEC: 900,
    REFRESH_TOKEN_TTL_SEC: 86_400,
    SERVICE_JWT_SECRET: key(),
    SERVICE_JWT_ALLOWED_ISSUERS: ['voice-gateway', 'voice-worker', 'scheduler', 'postcall-worker'],
    SERVICE_JWT_MAX_TTL_SEC: 300,
    FIELD_ENCRYPTION_KEY_ID: 'k1',
    FIELD_ENCRYPTION_KEY: key(),
    PHONE_HASH_KEY: key(),
    OUTBOX_ENABLED: false,
    OUTBOX_POLL_INTERVAL_MS: 100,
    ...overrides,
  };
}

export interface TestContext {
  app: INestApplication;
  config: AppConfig;
  owner: Pool;
  jwt: JwtService;
  crypto: FieldCrypto;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function startApp(
  overrides: Partial<AppConfig> = {},
  logStream?: Parameters<typeof createApp>[1],
): Promise<TestContext> {
  const config = testConfig(overrides);
  const app = await createApp(config, logStream);
  await app.listen(0, '127.0.0.1');
  const owner = new Pool({ connectionString: testUrls().ownerUrl, max: 5 });
  return {
    app,
    config,
    owner,
    jwt: app.get(JwtService),
    crypto: app.get(FieldCrypto),
    http: () => request(app.getHttpServer()),
    close: async () => {
      await app.close();
      await owner.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures, inserted as the schema owner (bypasses RLS, like an operator seed would).
// ---------------------------------------------------------------------------

export interface Fixture {
  tenantId: string;
  locationId: string;
  providerId: string;
  provider2Id: string;
  callId: string;
  slotIds: string[];
  slotStarts: Date[];
  users: Record<'owner' | 'admin' | 'staff', { id: string; email: string; password: string }>;
}

/** Next Monday 10:00 IST onwards; the fixture location is open Mon-Sat 09:00-13:00 and 16:00-20:00. */
export function nextMondayIst(hour = 10, minute = 0, weeksAhead = 1): Date {
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 3600_000);
  const daysToMonday = ((8 - istNow.getUTCDay()) % 7 || 7) + 7 * (weeksAhead - 1);
  const d = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + daysToMonday, hour, minute),
  );
  return new Date(d.getTime() - 5.5 * 3600_000);
}

export const OPEN_HOURS = {
  mon: [
    ['09:00', '13:00'],
    ['16:00', '20:00'],
  ],
  tue: [
    ['09:00', '13:00'],
    ['16:00', '20:00'],
  ],
  wed: [
    ['09:00', '13:00'],
    ['16:00', '20:00'],
  ],
  thu: [
    ['09:00', '13:00'],
    ['16:00', '20:00'],
  ],
  fri: [
    ['09:00', '13:00'],
    ['16:00', '20:00'],
  ],
  sat: [['09:00', '13:00']],
};

export async function seedTenant(
  ctx: TestContext,
  opts: { slots?: number; settings?: Record<string, unknown>; name?: string } = {},
): Promise<Fixture> {
  const q = ctx.owner;
  const tenantId = randomUUID();
  await q.query('INSERT INTO tenants (id, name, settings) VALUES ($1, $2, $3)', [
    tenantId,
    opts.name ?? 'Sunrise Clinic',
    opts.settings ?? {},
  ]);
  const { rows: loc } = await q.query<{ id: string }>(
    `INSERT INTO locations (tenant_id, name, timezone, hours) VALUES ($1, 'Sunrise Clinic, Baner', 'Asia/Kolkata', $2) RETURNING id`,
    [tenantId, OPEN_HOURS],
  );
  const locationId = loc[0]!.id;
  const { rows: prov } = await q.query<{ id: string }>(
    `INSERT INTO providers (tenant_id, location_id, name, specialty)
     VALUES ($1, $2, 'Dr. Mehta', 'general'), ($1, $2, 'Dr. Rao', 'general') RETURNING id`,
    [tenantId, locationId],
  );
  const providerId = prov[0]!.id;
  const provider2Id = prov[1]!.id;

  const slotStarts: Date[] = [];
  const first = nextMondayIst(10, 0);
  for (let i = 0; i < (opts.slots ?? 6); i++) slotStarts.push(new Date(first.getTime() + i * 30 * 60_000));
  const slotIds: string[] = [];
  for (const start of slotStarts) {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO slots (tenant_id, provider_id, starts_at, ends_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, providerId, start, new Date(start.getTime() + 30 * 60_000)],
    );
    slotIds.push(rows[0]!.id);
  }

  const { rows: call } = await q.query<{ id: string }>(
    `INSERT INTO calls (tenant_id, provider, provider_call_id, direction) VALUES ($1, 'exotel', $2, 'inbound') RETURNING id`,
    [tenantId, `exo-${randomUUID()}`],
  );

  const users = {} as Fixture['users'];
  for (const role of ['owner', 'admin', 'staff'] as const) {
    const email = `${role}.${tenantId.slice(0, 8)}@example.com`;
    const password = `pw-${randomUUID()}`;
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, email, await hashPassword(password), role],
    );
    users[role] = { id: rows[0]!.id, email, password };
  }

  return { tenantId, locationId, providerId, provider2Id, callId: call[0]!.id, slotIds, slotStarts, users };
}

export async function serviceHeaders(
  ctx: TestContext,
  f: { tenantId: string; callId: string },
  service = 'voice-worker',
) {
  return {
    Authorization: `Bearer ${await ctx.jwt.signServiceToken(service)}`,
    'X-Tenant-Id': f.tenantId,
    'X-Call-Id': f.callId,
  };
}

export async function userToken(ctx: TestContext, f: Fixture, role: 'owner' | 'admin' | 'staff'): Promise<string> {
  return ctx.jwt.signUserAccessToken({ userId: f.users[role].id, tenantId: f.tenantId, role });
}

// ---------------------------------------------------------------------------
// Contract validators built straight from docs/contracts.
// ---------------------------------------------------------------------------

const contractsDir = resolve(__dirname, '../../../docs/contracts');
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(parseYaml(readFileSync(resolve(contractsDir, 'internal-api.openapi.yaml'), 'utf8')), 'openapi');
ajv.addSchema(
  JSON.parse(readFileSync(resolve(contractsDir, 'agent-config.v1.schema.json'), 'utf8')),
  './agent-config.v1.schema.json',
);
const envelope = ajv.compile(JSON.parse(readFileSync(resolve(contractsDir, 'events/envelope.schema.json'), 'utf8')));
const booked = ajv.compile(
  JSON.parse(readFileSync(resolve(contractsDir, 'events/appointment.booked.v1.schema.json'), 'utf8')),
);

function pointer(path: string, method: string, status: string): string {
  const p = path.replace(/~/g, '~0').replace(/\//g, '~1');
  return `openapi#/paths/${p}/${method}/responses/${status}/content/application~1json/schema`;
}

/** Asserts a response body matches the frozen OpenAPI schema for that operation. */
export function expectContract(body: unknown, path: string, method: string, status: number): void {
  const validate =
    ajv.getSchema(pointer(path, method, String(status))) ??
    ajv.compile({ $ref: pointer(path, method, String(status)) });
  const ok = validate(body);
  if (!ok)
    throw new Error(
      `Contract violation for ${method.toUpperCase()} ${path} ${status}: ${ajv.errorsText(validate.errors)}`,
    );
}

export function expectErrorContract(body: unknown): void {
  const validate =
    ajv.getSchema('openapi#/components/schemas/Error') ?? ajv.compile({ $ref: 'openapi#/components/schemas/Error' });
  if (!validate(body)) throw new Error(`Error contract violation: ${ajv.errorsText(validate.errors)}`);
}

export function expectEventContract(event: unknown): void {
  if (!envelope(event)) throw new Error(`Envelope violation: ${ajv.errorsText(envelope.errors)}`);
  const payload = (event as { payload: unknown }).payload;
  if (!booked(payload)) throw new Error(`appointment.booked violation: ${ajv.errorsText(booked.errors)}`);
}
