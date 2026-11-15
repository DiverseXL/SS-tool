/**
 * Replaceable AI provider contract.
 *
 * The extraction service only knows how to ask a provider for a JSON
 * completion. Any OpenAI-compatible endpoint, local model, or deterministic
 * test double can be supplied without touching extraction logic.
 */

export const DEFAULT_AI_TIMEOUT_MS = 30_000;
export const DEFAULT_AI_MAX_INPUT_TOKENS = 8_000;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 1_500;
/**
 * Rough, deliberately conservative characters-per-token estimate. It is only
 * used to bound prompt size before a request is made; providers still enforce
 * their own token limits.
 */
export const CHARS_PER_TOKEN = 4;

export interface AiCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Upper bound for generated tokens, sent to the provider. */
  maxOutputTokens: number;
  temperature: number;
  /** Optional response format (e.g. { type: 'json_object' } or json_schema). */
  responseFormat?: Record<string, unknown>;
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AiCompletionResult {
  /** Raw text returned by the model. It is not trusted until schema-validated. */
  text: string;
  model: string;
  requestId?: string;
  durationMs?: number;
  usage?: AiUsage;
}

export interface AiProvider {
  /** Human-readable provider name, safe to log. Never includes credentials. */
  readonly name: string;
  /** True when connected to the OpenServ SERV Reasoning API. */
  readonly isServ?: boolean;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}

export type AiProviderErrorCode =
  | 'NOT_CONFIGURED'
  | 'INPUT_TOO_LARGE'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE';

/**
 * Expected provider failures. Messages are safe for logs and API responses:
 * they never contain the API key, request headers, or the complete response
 * body.
 */
export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly providerStatus?: number;

  constructor(code: AiProviderErrorCode, message: string, options: { providerStatus?: number } = {}) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    if (options.providerStatus !== undefined) {
      this.providerStatus = options.providerStatus;
    }
  }
}

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  providerType?: 'openserv-serv' | 'openai-compatible';
}

export type AiConfigResolution =
  | { configured: true; config: AiConfig }
  | { configured: false; reason: string };

export function maxInputChars(maxInputTokens: number): number {
  return Math.max(2_000, Math.floor(maxInputTokens * CHARS_PER_TOKEN));
}

/**
 * Maps a provider failure onto an HTTP-facing presentation. Kept here so route
 * and service layers agree on status codes.
 */
export function describeProviderFailure(error: AiProviderError): {
  statusCode: number;
  code: string;
  message: string;
} {
  // Upstream HTTP failures get a slightly more specific presentation where the
  // status code makes the cause unambiguous, without echoing provider text.
  if (error.code === 'HTTP_ERROR' && error.providerStatus === 429) {
    return {
      statusCode: 429,
      code: 'AI_PROVIDER_RATE_LIMITED',
      message: 'The AI provider is rate limiting requests. Try again shortly.',
    };
  }

  if (error.code === 'HTTP_ERROR' && (error.providerStatus === 401 || error.providerStatus === 403)) {
    return {
      statusCode: 502,
      code: 'AI_PROVIDER_AUTH_FAILED',
      message: 'The AI provider rejected the configured credentials.',
    };
  }

  switch (error.code) {
    case 'NOT_CONFIGURED':
      return {
        statusCode: 503,
        code: 'AI_NOT_CONFIGURED',
        message:
          'AI provider is not configured. Set SERV_API_KEY, or AI_BASE_URL, AI_API_KEY and AI_MODEL, to enable extraction.',
      };
    case 'TIMEOUT':
      return {
        statusCode: 504,
        code: 'AI_PROVIDER_TIMEOUT',
        message: 'The AI provider did not respond before the configured timeout.',
      };
    case 'INPUT_TOO_LARGE':
      return {
        statusCode: 413,
        code: 'AI_INPUT_TOO_LARGE',
        message: 'The source content is too large for the configured AI input limit.',
      };
    case 'NETWORK_ERROR':
    case 'HTTP_ERROR':
    case 'INVALID_RESPONSE':
      return {
        statusCode: 502,
        code: 'AI_PROVIDER_ERROR',
        message: 'The AI provider request failed.',
      };
  }
}
