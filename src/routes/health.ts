import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db/client.js';

const READINESS_TIMEOUT_MS = 3_000;

interface HealthRoutesOptions {
  database: Database;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('readiness check timed out'));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  const { database } = options;

  app.get('/healthz', async () => {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  });

  app.get('/readyz', async (request, reply) => {
    const startedAt = performance.now();

    try {
      await withTimeout(database.ping(), READINESS_TIMEOUT_MS);

      return {
        status: 'ready',
        checks: {
          database: {
            status: 'up',
            latencyMs: Math.round(performance.now() - startedAt),
          },
        },
      };
    } catch (error) {
      // Log only a safe summary: connection errors can include connection
      // details, and readiness failures are expected during startup.
      request.log.error(
        {
          err: {
            name: error instanceof Error ? error.name : 'UnknownError',
            code: (error as { code?: string }).code ?? 'UNKNOWN',
          },
        },
        'readiness check failed: database unreachable',
      );

      return reply.code(503).send({
        status: 'not_ready',
        checks: {
          database: { status: 'down' },
        },
      });
    }
  });
};
