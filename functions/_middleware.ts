import { handlePagesMiddleware } from '../server/pages/middleware.js';
import type { PagesContext } from '../server/pages/env.js';

export async function onRequest(context: PagesContext): Promise<Response> {
  return handlePagesMiddleware(context);
}
