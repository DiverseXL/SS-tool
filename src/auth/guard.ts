import type { FastifyInstance } from 'fastify';
import type { AuthService } from './auth-service.js';

const PRIVATE_API_PREFIXES = [
  '/api/v1/manufacturers',
  '/api/v1/products',
  '/api/v1/catalogue',
  '/api/v1/evidence',
  '/api/v1/dashboard',
  '/api/v1/auth/session',
] as const;

function isPrivateApiPath(path: string): boolean {
  return PRIVATE_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isDashboardPage(path: string): boolean {
  return path === '/dashboard' || path === '/dashboard/' || path.startsWith('/dashboard/') || path === '/dashboard.html';
}

/**
 * Default-deny guard for retailer-management routes. Public support APIs,
 * health checks, the marketing page and the login flow are registered
 * separately and remain reachable without a session.
 */
export function registerAuthGuard(app: FastifyInstance, authService: AuthService): void {
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';

    if (isPrivateApiPath(path)) {
      if (authService.authenticateRequest(request)) return;
      return reply.code(401).send({
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Authentication is required for this resource.',
        },
      });
    }

    if (isDashboardPage(path) && !authService.authenticateRequest(request)) {
      const next = path === '/dashboard/' ? '/dashboard' : request.url;
      return reply.redirect(`/login?next=${encodeURIComponent(next)}`);
    }
  });
}
