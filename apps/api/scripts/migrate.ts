/**
 * Applies migrations as the schema OWNER (MIGRATION_DATABASE_URL). Run as a separate,
 * reviewed deploy step; the running API never has owner credentials.
 *   pnpm db:migrate            # up
 *   pnpm db:migrate down 1     # roll back one
 */
import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';

async function main(): Promise<void> {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL is required');
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const count = direction === 'down' ? Number(process.argv[3] ?? 1) : Infinity;
  const applied = await runner({
    databaseUrl,
    dir: resolve(__dirname, '../migrations'),
    direction,
    count,
    migrationsTable: 'pgmigrations',
    singleTransaction: true,
    log: (msg) => process.stdout.write(`${msg}\n`),
  });
  process.stdout.write(`${direction}: ${applied.length} migration(s) applied\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
