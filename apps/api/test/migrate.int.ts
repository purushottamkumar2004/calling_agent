import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { MIGRATION_LOCK_ID } from '../src/scripts/migrate';
import { testUrls } from './env';

/**
 * Exercises the COMPILED production entrypoint exactly as the ECS one-off task runs it:
 * `node dist/scripts/migrate.js`, configuration from the environment only.
 */
const appDir = resolve(__dirname, '..');
const entrypoint = join(appDir, 'dist/scripts/migrate.js');

interface Run {
  code: number | null;
  lines: Array<Record<string, unknown>>;
  raw: string;
}

function run(env: Record<string, string>, args: string[] = [], cwd = appDir): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    // Minimal environment: nothing inherited from the test runner except PATH.
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let raw = '';
    child.stdout.on('data', (d: Buffer) => (raw += d.toString()));
    child.stderr.on('data', (d: Buffer) => (raw += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const lines = raw
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      resolveRun({ code, lines, raw });
    });
  });
}

const last = (r: Run) => r.lines[r.lines.length - 1] ?? {};

describe('production migrate entrypoint (dist/scripts/migrate.js)', () => {
  const { ownerUrl } = testUrls();
  const env = { MIGRATION_DATABASE_URL: ownerUrl };
  const password = decodeURIComponent(new URL(ownerUrl).password);

  beforeAll(() => {
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
      cwd: appDir,
      stdio: 'inherit',
    });
  }, 120_000);

  const tableCount = async () => {
    const client = new Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
        [['tenants', 'slots', 'appointments', 'outbox']],
      );
      return rows[0]?.n ?? 0;
    } finally {
      await client.end();
    }
  };

  it('applies migrations to an empty schema, then is a no-op on re-run', async () => {
    const down = await run(env, ['down', '1']);
    expect(down.code).toBe(0);
    expect(await tableCount()).toBe(0);

    const up = await run(env);
    expect(up.code).toBe(0);
    expect(last(up)).toMatchObject({ level: 'info', message: 'migration finished', applied_count: 1 });
    expect(await tableCount()).toBe(4);

    const again = await run(env);
    expect(again.code).toBe(0);
    expect(last(again)).toMatchObject({ message: 'schema already up to date', applied_count: 0 });
  });

  it('is safe when several tasks start at once', async () => {
    const results = await Promise.all([run(env), run(env), run(env)]);
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(await tableCount()).toBe(4);
  });

  it('waits for a run that holds the lock, then succeeds', async () => {
    const holder = new Client({ connectionString: ownerUrl });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    const pending = run(env);
    await new Promise((r) => setTimeout(r, 1500));
    await holder.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    await holder.end();
    const r = await pending;
    expect(r.code).toBe(0);
    expect(r.lines.map((l) => l.message)).toContain('waiting for another migration run to finish');
  });

  it('gives up with exit 1 after MIGRATION_LOCK_TIMEOUT_SEC', async () => {
    const holder = new Client({ connectionString: ownerUrl });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      const r = await run({ ...env, MIGRATION_LOCK_TIMEOUT_SEC: '1' });
      expect(r.code).toBe(1);
      expect(String(last(r).error)).toMatch(/still running/);
    } finally {
      await holder.end();
    }
  });

  it('never logs the database password', async () => {
    const ok = await run(env);
    expect(ok.raw).not.toContain(password);
    const bad = new URL(ownerUrl);
    bad.password = 'wrong-password-123';
    const failed = await run({ MIGRATION_DATABASE_URL: bad.toString() });
    expect(failed.code).toBe(1);
    expect(failed.raw).not.toContain('wrong-password-123');
  });

  it('exits 1 with a structured error when MIGRATION_DATABASE_URL is missing', async () => {
    const r = await run({ DATABASE_URL: ownerUrl });
    expect(r.code).toBe(1);
    expect(last(r)).toMatchObject({
      level: 'error',
      message: 'migration failed',
      error: 'MIGRATION_DATABASE_URL is not set',
    });
  });

  it('does not read a .env file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
    writeFileSync(join(dir, '.env'), `MIGRATION_DATABASE_URL=${ownerUrl}\n`);
    const r = await run({}, [], dir);
    expect(r.code).toBe(1);
    expect(last(r).error).toBe('MIGRATION_DATABASE_URL is not set');
  });

  it('exits 1 when the database is unreachable', async () => {
    const r = await run({ MIGRATION_DATABASE_URL: 'postgresql://nobody:x@127.0.0.1:1/none' });
    expect(r.code).toBe(1);
    expect(last(r)).toMatchObject({ level: 'error', message: 'migration failed' });
  });

  it('exits 1 on bad arguments', async () => {
    expect((await run(env, ['sideways'])).code).toBe(1);
  });
});
