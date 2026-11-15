import { handleApiRequest } from '../../../server/api/handler.js';
import type { PagesContext } from '../../../server/pages/env.js';

/**
 * Thin Pages Function adapter. All /api/v1 contracts are dispatched by the
 * shared handler so Fastify tests and Pages use the same services and rules.
 */
export async function onRequest(context: PagesContext): Promise<Response> {
  return handleApiRequest(context.request, context.env);
}
