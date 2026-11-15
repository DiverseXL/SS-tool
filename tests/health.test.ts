import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';

function createDatabaseStub(ping: () => Promise<void>): Database {
  return { ping } as unknown as Database;
}

function buildTestApp(ping: () => Promise<void> = async () => {}) {
  return buildApp({ database: createDatabaseStub(ping), logger: false });
}

describe('GET /healthz', () => {
  it('returns 200 with an ok status', async () => {
    const app = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
    expect(typeof response.json().timestamp).toBe('string');

    await app.close();
  });
});

describe('GET /readyz', () => {
  it('returns 200 when the database is reachable', async () => {
    const app = buildTestApp(async () => {});

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: { database: { status: 'up' } },
    });

    await app.close();
  });

  it('returns 503 without leaking error details when the database is unreachable', async () => {
    const app = buildTestApp(async () => {
      throw new Error('connection to postgresql://ss_tool:secret@localhost failed');
    });

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready',
      checks: { database: { status: 'down' } },
    });
    expect(response.body).not.toContain('secret');

    await app.close();
  });

  it('returns 503 when the database probe times out', async () => {
    vi.useFakeTimers();
    const app = buildTestApp(() => new Promise<void>(() => {}));

    const pending = app.inject({ method: 'GET', url: '/readyz' });
    await vi.advanceTimersByTimeAsync(3_000);
    const response = await pending;

    expect(response.statusCode).toBe(503);

    await app.close();
    vi.useRealTimers();
  });
});

describe('unknown routes', () => {
  it('returns a 404 JSON error', async () => {
    const app = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });
});
