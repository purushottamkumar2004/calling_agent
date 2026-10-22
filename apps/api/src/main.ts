import 'reflect-metadata';
import { createApp } from './app';
import { loadConfig } from './config/env';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.PORT, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  // Logger may not exist yet (e.g. invalid config); write a single structured line.
  process.stderr.write(`${JSON.stringify({ level: 'fatal', message: 'startup failed', error: String(err) })}\n`);
  process.exit(1);
});
