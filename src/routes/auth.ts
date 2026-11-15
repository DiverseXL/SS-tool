import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE_NAME, type AuthService } from '../auth/auth-service.js';

const loginBodySchema = z
  .object({
    email: z.email('must be a valid email address').max(320),
    password: z.string().min(1, 'is required').max(1024),
  })
  .strict();

interface AuthRoutesOptions {
  authService: AuthService;
}

function sessionCookieOptions(authService: AuthService) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: authService.secureCookies,
    signed: true,
  };
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const { authService } = options;

  app.post('/api/v1/auth/login', async (request, reply) => {
    const configurationError = authService.configurationError();
    if (configurationError) {
      return reply.code(503).send({
        error: { code: 'AUTH_NOT_CONFIGURED', message: configurationError },
      });
    }

    const rateLimit = authService.checkRateLimit(request.ip);
    if (!rateLimit.allowed) {
      void reply.header('Retry-After', String(rateLimit.retryAfterSeconds));
      return reply.code(429).send({
        error: {
          code: 'LOGIN_RATE_LIMITED',
          message: 'Too many sign-in attempts. Wait a few minutes and try again.',
        },
      });
    }

    const body = loginBodySchema.parse(request.body);
    const session = await authService.login(body.email, body.password);

    if (!session) {
      authService.recordFailure(request.ip);
      return reply.code(401).send({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Email or password is incorrect.',
        },
      });
    }

    authService.clearFailures(request.ip);

    void reply.setCookie(SESSION_COOKIE_NAME, session.id, {
      ...sessionCookieOptions(authService),
      maxAge: authService.sessionTtlSeconds,
      expires: session.expiresAt,
    });

    return {
      data: {
        email: session.email,
        expiresAt: session.expiresAt.toISOString(),
      },
    };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    if (raw) {
      const unsigned = request.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        authService.destroySession(unsigned.value);
      }
    }

    void reply.clearCookie(SESSION_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: authService.secureCookies,
    });

    return { data: { loggedOut: true } };
  });

  app.get('/api/v1/auth/session', async (request, reply) => {
    const session = authService.authenticateRequest(request);

    if (!session) {
      return reply.code(401).send({
        error: { code: 'AUTH_REQUIRED', message: 'Your session has expired.' },
      });
    }

    return {
      data: {
        email: session.email,
        expiresAt: session.expiresAt.toISOString(),
        workspace: { name: 'SS Tool workspace' },
      },
    };
  });
};
