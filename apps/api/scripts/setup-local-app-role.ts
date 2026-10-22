/**
 * LOCAL DEVELOPMENT ONLY. Creates the LOGIN role named in DATABASE_URL and makes it a
 * member of api_app (the RLS-bound service role created by the migrations). In AWS this
 * is done by infra (Terraform) with credentials from the secrets vault.
 */
import { Client } from 'pg';

async function main(): Promise<void> {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) throw new Error('MIGRATION_DATABASE_URL and DATABASE_URL are required');
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run in production');

  const { username, password } = new URL(appUrl);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(username)) throw new Error(`Unsafe role name "${username}"`);

  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username]);
    const pw = client.escapeLiteral(decodeURIComponent(password));
    await client.query(
      rowCount ? `ALTER ROLE ${username} LOGIN PASSWORD ${pw}` : `CREATE ROLE ${username} LOGIN PASSWORD ${pw}`,
    );
    await client.query(`GRANT api_app TO ${username}`);
    process.stdout.write(`Role ${username} ready (member of api_app, subject to RLS)\n`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
