import { handleHealth } from '../server/pages/health.js';

export function onRequest(): Response {
  return handleHealth();
}
