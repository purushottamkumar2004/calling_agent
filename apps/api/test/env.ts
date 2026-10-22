export const TEST_APP_ROLE = 'calling_agent_app_test';
export const TEST_APP_PASSWORD = 'test_app_password';

/** TEST_DATABASE_URL must point at a disposable database owned by a non-superuser. */
export function testUrls(): { ownerUrl: string; appUrl: string; redisUrl: string } {
  const ownerUrl =
    process.env.TEST_DATABASE_URL ?? 'postgresql://calling_agent:change_me@localhost:5432/calling_agent_test';
  const app = new URL(ownerUrl);
  app.username = TEST_APP_ROLE;
  app.password = TEST_APP_PASSWORD;
  return { ownerUrl, appUrl: app.toString(), redisUrl: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15' };
}
