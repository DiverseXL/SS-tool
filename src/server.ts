import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { closeDatabase, createDatabase } from './db/client.js';

async function main(): Promise<void> {
  const config = loadEnv();
  const database = createDatabase(config.DATABASE_URL);

  const app = buildApp({
    database,
    auth: {
      email: config.ADMIN_EMAIL,
      password: config.ADMIN_PASSWORD,
      sessionSecret: config.SESSION_SECRET,
      sessionTtlMs: config.SESSION_TTL_HOURS * 60 * 60 * 1000,
      secureCookies: config.NODE_ENV === 'production',
    },
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
  });

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info({ signal }, 'shutdown signal received');

    try {
      await app.close();
      await closeDatabase(database);
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    app.log.error({ err: error }, 'failed to start server');
    await closeDatabase(database);
    process.exit(1);
  }
}

void main();
