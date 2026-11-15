import { handleReady } from '../server/pages/health.js';
import type { PagesContext } from '../server/pages/env.js';

export async function onRequest(context: PagesContext): Promise<Response> {
  return handleReady(context.env);
}
