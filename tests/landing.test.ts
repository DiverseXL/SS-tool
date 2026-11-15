import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/db/client.js';

function createDatabaseStub(): Database {
  return { ping: async () => {} } as unknown as Database;
}

function buildTestApp() {
  return buildApp({ database: createDatabaseStub(), logger: false });
}

describe('landing page', () => {
  it('serves the landing page at GET /', async () => {
    const app = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Know how long your devices will stay supported.');
    expect(response.body).toContain('Illustrative example — not a verified product record');

    const header = response.body.slice(
      response.body.indexOf('<header'),
      response.body.indexOf('</header>'),
    );
    expect(header).toContain('href="/dashboard"');
    expect(header).not.toContain('Explore SS Tool');
    expect(header).not.toContain('How it works');

    await app.close();
  });

  it('serves the hero image from the public assets directory', async () => {
    const app = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/images/ss-tool-hero.webp' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.rawPayload.length).toBeGreaterThan(10_000);

    await app.close();
  });

  it('keeps unknown API routes as JSON errors', async () => {
    const app = buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });
});
