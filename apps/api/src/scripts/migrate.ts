/**
 * Production migration entrypoint, compiled with the app:
 *
 *   node dist/scripts/migrate.js            # apply all pending migrations (default)
 *   node dist/scripts/migrate.js down [n]   # roll back n migrations (default 1); operators only
 *
 * - Reads MIGRATION_DATABASE_URL from the process environment only. It never loads a
 *   .env file (local dev wraps it: `pnpm db:migrate` = tsx --env-file=.env).
 * - Safe to run repeatedly and concurrently: applied migrations are tracked in
 *   `pgmigrations`, and the entrypoint holds a Postgres advisory lock for the whole run.
 *   A second task WAITS for the lock (up to MIGRATION_LOCK_TIMEOUT_SEC, default 600) and
 *   then finds nothing to do. (node-pg-migrate's own lock fails fast instead of waiting,
 *   so it is disabled in favour of this one; the same lock id is used, so a direct
 *   node-pg-migrate CLI run is still excluded.)
 * - All pending migrations run in ONE transaction: a failure leaves the schema unchanged.
 * - Logs one JSON object per line to stdout/stderr (CloudWatch-friendly). The database
 *   URL is never logged.
 * - Exit code: 0 on success (including "nothing to do"), 1 on any failure.
 *
 * Expects the image layout <app>/dist/scripts/migrate.js and <app>/migrations/*.sql.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';

export const MIGRATIONS_DIR = resolve(__dirname, '../../migrations');
export const MIGRATIONS_TABLE = 'pgmigrations';
/** node-pg-migrate's advisory lock id, reused so its CLI and this entrypoint exclude each other. */
export const MIGRATION_LOCK_ID = 7241865325823964;
const DEFAULT_LOCK_TIMEOUT_SEC = 600;

export type Direction = 'up' | 'down';

export interface MigrateOptions {
  databaseUrl: string;
  direction?: Direction;
  count?: number;
  /** Maximum wait for another run to finish before failing. */
  lockTimeoutSec?: number;
  log?: (message: string) => void;
  onWaiting?: () => void;
}

/**
 * Applies migrations under a waiting advisory lock; returns the names of the migrations
 * that ran (empty when the schema is already up to date).
 */
export async function runMigrations(opts: MigrateOptions): Promise<string[]> {
  const direction = opts.direction ?? 'up';
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`migrations directory not found at ${MIGRATIONS_DIR}`);
  }

  const lock = new Client({ connectionString: opts.databaseUrl, application_name: 'core-api-migrate-lock' });
  await lock.connect();
  try {
    const timeoutMs = (opts.lockTimeoutSec ?? DEFAULT_LOCK_TIMEOUT_SEC) * 1000;
    const { rows } = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATION_LOCK_ID]);
    if (!rows[0]?.ok) {
      opts.onWaiting?.();
      await lock.query(`SET lock_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      try {
        await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      } catch (err) {
        if ((err as { code?: string }).code === '55P03') {
          throw new Error(`another migration still running after ${timeoutMs / 1000}s; giving up`);
        }
        throw err;
      }
    }

    const applied = await runner({
      databaseUrl: opts.databaseUrl,
      dir: MIGRATIONS_DIR,
      direction,
      count: opts.count ?? (direction === 'up' ? Infinity : 1),
      migrationsTable: MIGRATIONS_TABLE,
      singleTransaction: true,
      checkOrder: true,
      noLock: true,
      log: opts.log ?? (() => undefined),
    });
    return applied.map((m) => m.name);
  } finally {
    // Ending the session releases the advisory lock even if unlock is skipped.
    await lock.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
    await lock.end().catch(() => undefined);
  }
}

/** Reads MIGRATION_LOCK_TIMEOUT_SEC (optional). */
export function readLockTimeout(env: NodeJS.ProcessEnv): number {
  const raw = env.MIGRATION_LOCK_TIMEOUT_SEC;
  if (raw === undefined || raw === '') return DEFAULT_LOCK_TIMEOUT_SEC;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3600)
    throw new Error('MIGRATION_LOCK_TIMEOUT_SEC must be an integer 1-3600');
  return n;
}

/** Parses argv into a direction and count; throws on anything unexpected. */
export function parseArgs(argv: string[]): { direction: Direction; count?: number } {
  const [command = 'up', countArg, ...rest] = argv;
  if (rest.length > 0) throw new Error(`unexpected arguments: ${rest.join(' ')}`);
  if (command === 'up') {
    if (countArg !== undefined) throw new Error('"up" takes no count; it always applies all pending migrations');
    return { direction: 'up' };
  }
  if (command === 'down') {
    const count = countArg === undefined ? 1 : Number(countArg);
    if (!Number.isInteger(count) || count < 1) throw new Error(`invalid count "${countArg}"`);
    return { direction: 'down', count };
  }
  throw new Error(`unknown command "${command}" (expected "up" or "down [n]")`);
}

/** Validates the URL without ever echoing it (it contains the owner password). */
export function readDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('MIGRATION_DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('MIGRATION_DATABASE_URL must be a postgres:// or postgresql:// URL');
  }
  return url;
}

function emit(
  stream: NodeJS.WriteStream,
  level: 'info' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  stream.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), service: 'core-api-migrate', message, ...fields })}\n`,
  );
}

/** Error text with any credentials in connection strings masked. */
function safeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+@/g, '$1***@');
}

async function main(): Promise<void> {
  const { direction, count } = parseArgs(process.argv.slice(2));
  const databaseUrl = readDatabaseUrl(process.env);
  const lockTimeoutSec = readLockTimeout(process.env);
  const { hostname, pathname } = new URL(databaseUrl);
  const target = { db_host: hostname, db_name: pathname.replace(/^\//, '') };
  emit(process.stdout, 'info', 'migration started', { direction, ...target });
  const started = Date.now();
  const applied = await runMigrations({
    databaseUrl,
    direction,
    count,
    lockTimeoutSec,
    onWaiting: () => emit(process.stdout, 'info', 'waiting for another migration run to finish', target),
  });
  emit(process.stdout, 'info', applied.length ? 'migration finished' : 'schema already up to date', {
    direction,
    applied,
    applied_count: applied.length,
    duration_ms: Date.now() - started,
    ...target,
  });
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      emit(process.stderr, 'error', 'migration failed', { error: safeError(err) });
      process.exit(1);
    },
  );
}
