/**
 * Onboards a pilot clinic (no self-serve signup in MVP): tenant, one location with
 * opening hours, providers, an owner login, and 30-minute slots for the next N days.
 * Runs as the schema owner. Idempotent per owner email.
 *
 *   SEED_OWNER_EMAIL=dr.mehta@example.com SEED_OWNER_PASSWORD='...' pnpm seed
 */
import { DateTime } from 'luxon';
import { Client } from 'pg';
import { hashPassword } from '../src/auth/passwords';
import { openingHoursSchema } from '../src/scheduling/time';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  const email = process.env.SEED_OWNER_EMAIL?.toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD;
  if (!url || !email || !password) {
    throw new Error('MIGRATION_DATABASE_URL, SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD are required');
  }
  if (password.length < 12) throw new Error('SEED_OWNER_PASSWORD must be at least 12 characters');
  const clinic = process.env.SEED_CLINIC_NAME ?? 'Sunrise Clinic';
  const timezone = process.env.SEED_TIMEZONE ?? 'Asia/Kolkata';
  const days = Number(process.env.SEED_SLOT_DAYS ?? 14);
  const hours = openingHoursSchema.parse({
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
  });

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const existing = await db.query('SELECT tenant_id FROM users WHERE email = $1', [email]);
    if (existing.rowCount) {
      process.stdout.write(`Owner ${email} already exists (tenant ${existing.rows[0].tenant_id}); nothing to do\n`);
      return;
    }
    await db.query('BEGIN');
    const t = await db.query<{ id: string }>('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [clinic]);
    const tenantId = t.rows[0]!.id;
    const l = await db.query<{ id: string }>(
      'INSERT INTO locations (tenant_id, name, timezone, hours) VALUES ($1, $2, $3, $4) RETURNING id',
      [tenantId, clinic, timezone, hours],
    );
    const p = await db.query<{ id: string; name: string }>(
      `INSERT INTO providers (tenant_id, location_id, name, specialty)
       VALUES ($1, $2, 'Dr. Mehta', 'general'), ($1, $2, 'Dr. Rao', 'pediatrics') RETURNING id, name`,
      [tenantId, l.rows[0]!.id],
    );
    await db.query('INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4)', [
      tenantId,
      email,
      await hashPassword(password),
      'owner',
    ]);

    let slots = 0;
    const today = DateTime.now().setZone(timezone).startOf('day');
    for (let d = 1; d <= days; d++) {
      const day = today.plus({ days: d });
      for (const [open, close] of hours[DAYS[day.weekday - 1]!] ?? []) {
        const [oh, om] = open.split(':').map(Number) as [number, number];
        const [ch, cm] = close.split(':').map(Number) as [number, number];
        let at = day.set({ hour: oh, minute: om });
        const end = day.set({ hour: ch, minute: cm });
        while (at.plus({ minutes: 30 }) <= end) {
          for (const provider of p.rows) {
            await db.query('INSERT INTO slots (tenant_id, provider_id, starts_at, ends_at) VALUES ($1, $2, $3, $4)', [
              tenantId,
              provider.id,
              at.toJSDate(),
              at.plus({ minutes: 30 }).toJSDate(),
            ]);
            slots++;
          }
          at = at.plus({ minutes: 30 });
        }
      }
    }
    await db.query('COMMIT');
    process.stdout.write(
      `${JSON.stringify({ tenant_id: tenantId, location_id: l.rows[0]!.id, providers: p.rows, owner: email, slots }, null, 2)}\n`,
    );
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
