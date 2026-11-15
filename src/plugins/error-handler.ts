import type { FastifyError, FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Array<{ path: string; message: string }>;
  };
}

function sendValidationError(request: FastifyRequest, reply: FastifyReply, error: ZodError) {
  request.log.warn({ err: error }, 'request validation failed');

  const body: ErrorBody = {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    },
  };

  return reply.code(400).send(body);
}

/**
 * Centralised error handling: consistent JSON shape, sensible status codes,
 * and internal errors are never echoed back to the client.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
    };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((error: FastifyError | ZodError | AppError, request, reply) => {
    if (error instanceof ZodError) {
      return sendValidationError(request, reply, error);
    }

    if (error instanceof AppError) {
      request.log.warn({ err: error }, 'request rejected');

      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }

    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode <= 599
        ? error.statusCode
        : 500;
    const isServerError = statusCode >= 500;

    if (isServerError) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.warn({ err: error }, 'request rejected');
    }

    const body: ErrorBody = {
      error: {
        code: error.code ?? (isServerError ? 'INTERNAL_SERVER_ERROR' : 'BAD_REQUEST'),
        message: isServerError ? 'Internal server error' : error.message,
      },
    };

    return reply.code(statusCode).send(body);
  });
}
