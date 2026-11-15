/**
 * Expected, client-facing failures. Anything else becomes a generic 500, so
 * database or internal details never reach the response.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }

  static notFound(code: string, message: string): AppError {
    return new AppError(404, code, message);
  }

  static conflict(code: string, message: string): AppError {
    return new AppError(409, code, message);
  }
}

interface PostgresError {
  code?: string;
  constraint_name?: string;
  constraint?: string;
}

/**
 * Maps PostgreSQL integrity violations onto HTTP semantics. Repositories call
 * this so route handlers never need to know about SQLSTATE codes.
 */
export function translateDatabaseError(error: unknown, options: { conflictMessage: string; foreignKeyMessage?: string }): never {
  const pgError = error as PostgresError | null;

  if (pgError?.code === '23505') {
    throw AppError.conflict('DUPLICATE_RECORD', options.conflictMessage);
  }

  if (pgError?.code === '23503' && options.foreignKeyMessage) {
    throw AppError.notFound('MANUFACTURER_NOT_FOUND', options.foreignKeyMessage);
  }

  throw error;
}
