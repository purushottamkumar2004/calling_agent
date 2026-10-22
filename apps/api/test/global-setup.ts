import { Client } from 'pg';
import { runMigrations } from '../src/scripts/migrate';
import { TEST_APP_ROLE, TEST_APP_PASSWORD, testUrls } from './env';

/**
 * Fresh schema per run, then the RLS-bound login role the service uses. Tests run against
 * real Postgres with a NON-superuser owner, as on RDS and in CI.
 *
 * Reset uses DROP OWNED BY CURRENT_USER, not DROP SCHEMA public CASCADE: the latter also
 * drops superuser-installed extensions (pgvector), which the owner cannot reinstall.
 */
export default async function globalSetup(): Promise<void> {
  const { ownerUrl } = testUrls();
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query('DROP OWNED BY CURRENT_USER CASCADE');
    // Only drops `public` if this role owned it (older local setups); recreate it then.
    await owner.query('CREATE SCHEMA IF NOT EXISTS public');
    await runMigrations({ databaseUrl: ownerUrl });
    await owner.query(`
      DO $$ BEGIN
        CREATE ROLE ${TEST_APP_ROLE} LOGIN PASSWORD '${TEST_APP_PASSWORD}';
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    await owner.query(`GRANT api_app TO ${TEST_APP_ROLE}`);
  } finally {
    await owner.end();
  }
}
