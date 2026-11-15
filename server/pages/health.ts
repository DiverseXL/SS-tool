import { closeDatabase, getDatabase } from './context.js';
import type { PagesEnv } from './env.js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function handleHealth(): Response {
  return json({
    status: 'ok',
    runtime: 'cloudflare-pages-functions',
    timestamp: new Date().toISOString(),
  });
}

export async function handleReady(env: PagesEnv): Promise<Response> {
  const startedAt = performance.now();
  let database: ReturnType<typeof getDatabase> | null = null;
  try {
    database = getDatabase(env);
    await Promise.race([
      database.ping(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('readiness check timed out')), 3000),
      ),
    ]);

    return json({
      status: 'ready',
      checks: {
        database: {
          status: 'up',
          latencyMs: Math.round(performance.now() - startedAt),
        },
      },
    });
  } catch (error) {
    console.error('Pages readiness check failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: (error as { code?: string }).code ?? 'UNKNOWN',
    });
    return json(
      {
        status: 'not_ready',
        checks: { database: { status: 'down' } },
      },
      503,
    );
  } finally {
    if (database) {
      await closeDatabase(database).catch(() => {});
    }
  }
}
