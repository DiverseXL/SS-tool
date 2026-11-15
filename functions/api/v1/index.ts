import { handleApiRequest } from '../../../server/api/handler.js';
import type { PagesContext } from '../../../server/pages/env.js';

export async function onRequest(context: PagesContext): Promise<Response> {
  return handleApiRequest(context.request, context.env);
}
