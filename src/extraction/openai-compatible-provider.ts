import { z } from 'zod';
import {
  AiProviderError,
  DEFAULT_AI_MAX_INPUT_TOKENS,
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  DEFAULT_AI_TIMEOUT_MS,
  maxInputChars,
  type AiCompletionRequest,
  type AiCompletionResult,
  type AiConfig,
  type AiConfigResolution,
  type AiProvider,
} from './provider.js';

const MAX_RESPONSE_BYTES = 1_000_000;

const envSchema = z.object({
  AI_BASE_URL: z.url('must be a valid absolute URL'),
  AI_API_KEY: z.string().trim().min(1, 'must not be empty'),
  AI_MODEL: z.string().trim().min(1, 'must not be empty'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(DEFAULT_AI_TIMEOUT_MS),
  AI_MAX_INPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(256)
    .max(200_000)
    .default(DEFAULT_AI_MAX_INPUT_TOKENS),
  AI_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(64)
    .max(16_000)
    .default(DEFAULT_AI_MAX_OUTPUT_TOKENS),
});

const completionResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          // OpenAI-compatible servers normally return a string, but some
          // gateways return an array of content parts.
          content: z.union([
            z.string(),
            z.array(
              z.object({
                type: z.string().optional(),
                text: z.string().optional(),
              }),
            ),
          ]),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

const errorBodySchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        code: z.union([z.string(), z.number()]).optional(),
      })
      .optional(),
  })
  .optional();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function contentToText(content: string | Array<{ type?: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === undefined || part.type === 'text' ? (part.text ?? '') : ''))
    .join('');
}

function safeProviderMessage(body: unknown): string {
  const parsed = errorBodySchema.safeParse(body);
  const message = parsed.success ? parsed.data?.error?.message : undefined;
  if (!message) return 'AI provider returned an error response.';
  // Provider error messages are not expected to contain credentials, but they
  // are still trimmed and length-limited before they can reach a log.
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * Reads AI configuration from the environment.
 * Supports both dedicated SERV_* variables (OpenServ SERV Reasoning API) and
 * generic AI_* variables. Missing configuration is reported as a typed
 * resolution rather than thrown at startup, so research and catalogue
 * endpoints keep working when AI is not enabled.
 */
export function resolveAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfigResolution {
  const servApiKey = (env.SERV_API_KEY ?? '').trim();
  const servModel = (env.SERV_MODEL ?? '').trim() || 'gpt-5.4-mini';
  const servBaseUrl = (env.SERV_BASE_URL ?? '').trim() || 'https://inference-api.openserv.ai/v1';

  if (servApiKey.length > 0) {
    try {
      new URL(servBaseUrl);
    } catch {
      return {
        configured: false,
        reason: 'invalid AI configuration: SERV_BASE_URL must be a valid absolute URL',
      };
    }

    return {
      configured: true,
      config: {
        baseUrl: servBaseUrl.replace(/\/+$/, ''),
        apiKey: servApiKey,
        model: servModel,
        timeoutMs: Number(env.SERV_TIMEOUT_MS || env.AI_TIMEOUT_MS) || DEFAULT_AI_TIMEOUT_MS,
        maxInputTokens:
          Number(env.SERV_MAX_INPUT_TOKENS || env.AI_MAX_INPUT_TOKENS) || DEFAULT_AI_MAX_INPUT_TOKENS,
        maxOutputTokens:
          Number(env.SERV_MAX_OUTPUT_TOKENS || env.AI_MAX_OUTPUT_TOKENS) || DEFAULT_AI_MAX_OUTPUT_TOKENS,
        providerType: 'openserv-serv',
      },
    };
  }

  const names = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'] as const;
  const present = names.filter((name) => (env[name] ?? '').trim() !== '');

  if (present.length === 0) {
    return {
      configured: false,
      reason: 'SERV_API_KEY or (AI_BASE_URL, AI_API_KEY, AI_MODEL) are not set',
    };
  }

  if (present.length !== names.length) {
    const missing = names.filter((name) => !present.includes(name));
    return {
      configured: false,
      reason: `incomplete AI configuration; missing ${missing.join(', ')}`,
    };
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    return {
      configured: false,
      reason: `invalid AI configuration for ${fields.filter(Boolean).join(', ') || 'AI settings'}`,
    };
  }

  const baseUrl = parsed.data.AI_BASE_URL.replace(/\/+$/, '');
  const isServ = baseUrl.includes('openserv.ai');

  return {
    configured: true,
    config: {
      baseUrl,
      apiKey: parsed.data.AI_API_KEY,
      model: parsed.data.AI_MODEL,
      timeoutMs: parsed.data.AI_TIMEOUT_MS,
      maxInputTokens: parsed.data.AI_MAX_INPUT_TOKENS,
      maxOutputTokens: parsed.data.AI_MAX_OUTPUT_TOKENS,
      providerType: isServ ? 'openserv-serv' : 'openai-compatible',
    },
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  return baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
}

/**
 * Minimal client for any OpenAI-compatible `/chat/completions` endpoint.
 * Uses native fetch, enforces a timeout, bounds input/output size and never
 * logs the API key or the raw completion.
 */
export function createOpenAiCompatibleProvider(
  config: AiConfig,
  options: { fetchImpl?: typeof fetch } = {},
): AiProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = chatCompletionsUrl(config.baseUrl);
  const isServ = config.providerType === 'openserv-serv' || config.baseUrl.includes('openserv.ai');

  return {
    name: isServ ? `openserv-serv:${config.model}` : `openai-compatible:${config.model}`,
    isServ,

    async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
      const inputChars = request.systemPrompt.length + request.userPrompt.length;
      if (inputChars > maxInputChars(config.maxInputTokens)) {
        throw new AiProviderError(
          'INPUT_TOO_LARGE',
          `AI request contains ${inputChars} characters, above the configured input limit`,
        );
      }

      const outputLimit = Math.min(
        Math.max(1, request.maxOutputTokens),
        config.maxOutputTokens,
      );

      // SERV Reasoning rejects `max_tokens` and requires the newer
      // `max_completion_tokens` parameter. Generic OpenAI-compatible endpoints
      // still commonly expect `max_tokens`.
      const tokenLimitField = isServ ? 'max_completion_tokens' : 'max_tokens';

      const startTime = Date.now();
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: request.systemPrompt },
              { role: 'user', content: request.userPrompt },
            ],
            temperature: request.temperature,
            [tokenLimitField]: outputLimit,
            response_format: request.responseFormat ?? { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        if (isRecord(error) && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          throw new AiProviderError(
            'TIMEOUT',
            `AI provider did not respond within ${config.timeoutMs} ms`,
          );
        }
        throw new AiProviderError('NETWORK_ERROR', 'AI provider request failed before a response');
      }

      const durationMs = Date.now() - startTime;
      const rawBody = await response.text().catch(() => '');
      if (rawBody.length > MAX_RESPONSE_BYTES) {
        throw new AiProviderError('INVALID_RESPONSE', 'AI provider response exceeded the size limit', {
          providerStatus: response.status,
        });
      }

      let parsedBody: unknown;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        throw new AiProviderError('INVALID_RESPONSE', 'AI provider returned a non-JSON response', {
          providerStatus: response.status,
        });
      }

      if (!response.ok) {
        throw new AiProviderError(
          'HTTP_ERROR',
          `${safeProviderMessage(parsedBody)} (HTTP ${response.status})`,
          { providerStatus: response.status },
        );
      }

      const parsed = completionResponseSchema.safeParse(parsedBody);
      if (!parsed.success) {
        throw new AiProviderError(
          'INVALID_RESPONSE',
          'AI provider response did not match the chat completion shape',
          { providerStatus: response.status },
        );
      }

      const text = contentToText(parsed.data.choices[0]?.message.content ?? '');
      if (!text.trim()) {
        throw new AiProviderError('INVALID_RESPONSE', 'AI provider returned an empty completion', {
          providerStatus: response.status,
        });
      }

      const requestId =
        response.headers.get('x-request-id') ??
        (typeof parsedBody === 'object' && parsedBody !== null && 'id' in parsedBody
          ? String((parsedBody as Record<string, unknown>).id)
          : undefined);

      const usage = parsed.data.usage;
      const totalTokens =
        usage && usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined
          ? usage.prompt_tokens + usage.completion_tokens
          : undefined;

      return {
        text,
        model: parsed.data.model ?? config.model,
        requestId,
        durationMs,
        ...(usage
          ? {
              usage: {
                ...(usage.prompt_tokens !== undefined
                  ? { inputTokens: usage.prompt_tokens }
                  : {}),
                ...(usage.completion_tokens !== undefined
                  ? { outputTokens: usage.completion_tokens }
                  : {}),
                ...(totalTokens !== undefined ? { totalTokens } : {}),
              },
            }
          : {}),
      };
    },
  };
}

/**
 * Production entrypoint: builds a provider only when the environment supplies
 * a complete configuration.
 */
export function createAiProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: typeof fetch } = {},
): { provider: AiProvider | null; reason?: string; config?: AiConfig } {
  const resolution = resolveAiConfig(env);
  if (!resolution.configured) {
    return { provider: null, reason: resolution.reason };
  }

  return {
    provider: createOpenAiCompatibleProvider(resolution.config, options),
    config: resolution.config,
  };
}
