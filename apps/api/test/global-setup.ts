import { resolve } from 'node:path';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';
import { TEST_APP_ROLE, TEST_APP_PASSWORD, testUrls } from './env';

/**
 * Fresh schema per run: drop everything, apply all migrations as the owner role, then
 * create the RLS-bound login role the service uses. Tests run against real Postgres
 * (architecture: integration tests against real Postgres in CI).
 */
export default async function globalSetup(): Promise<void> {
  const { ownerUrl } = testUrls();
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query('DROP SCHEMA IF EXISTS public CASCADE');
    await owner.query('CREATE SCHEMA public');
    await runner({
      databaseUrl: ownerUrl,
      dir: resolve(__dirname, '../migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      count: Infinity,
      log: () => undefined,
    });
    await owner.query(`
      DO $$ BEGIN
        CREATE ROLE ${TEST_APP_ROLE} LOGIN PASSWORD '${TEST_APP_PASSWORD}';
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await owner.query(`GRANT api_app TO ${TEST_APP_ROLE}`);
  } finally {
    await owner.end();
  }
}
