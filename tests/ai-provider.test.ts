import { createServer, type RequestListener } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  chatCompletionsUrl,
  createOpenAiCompatibleProvider,
  resolveAiConfig,
} from '../src/extraction/openai-compatible-provider.js';
import { parseAiExtractionResponse } from '../src/extraction/extraction-schema.js';
import { AiProviderError, type AiConfig } from '../src/extraction/provider.js';

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function listen(handler: RequestListener): Promise<TestServer> {
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not expose a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function baseConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    baseUrl: 'https://ai.example/v1',
    apiKey: 'test-secret-key',
    model: 'test-model',
    timeoutMs: 5_000,
    maxInputTokens: 8_000,
    maxOutputTokens: 1_500,
    ...overrides,
  };
}

function completionBody(content: string): string {
  return JSON.stringify({
    model: 'test-model',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });
}

async function expectProviderError(
  promise: Promise<unknown>,
  code: AiProviderError['code'],
): Promise<AiProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AiProviderError);
    const providerError = error as AiProviderError;
    expect(providerError.code).toBe(code);
    expect(providerError.message).not.toContain('test-secret-key');
    return providerError;
  }

  throw new Error(`expected AiProviderError with code ${code}`);
}

describe('AI configuration', () => {
  it('reports missing configuration without exposing values', () => {
    const resolution = resolveAiConfig({});

    expect(resolution.configured).toBe(false);
    if (!resolution.configured) {
      expect(resolution.reason).toContain('AI_BASE_URL');
      expect(resolution.reason).toContain('AI_MODEL');
    }
  });

  it('reports partial configuration clearly', () => {
    const resolution = resolveAiConfig({
      AI_BASE_URL: 'https://ai.example/v1',
      AI_API_KEY: 'secret-value',
    });

    expect(resolution.configured).toBe(false);
    if (!resolution.configured) {
      expect(resolution.reason).toContain('AI_MODEL');
      expect(resolution.reason).not.toContain('secret-value');
    }
  });

  it('accepts a complete configuration and applies defaults', () => {
    const resolution = resolveAiConfig({
      AI_BASE_URL: 'https://ai.example/v1/',
      AI_API_KEY: 'secret-value',
      AI_MODEL: 'some-model',
    });

    expect(resolution.configured).toBe(true);
    if (resolution.configured) {
      expect(resolution.config).toMatchObject({
        baseUrl: 'https://ai.example/v1',
        model: 'some-model',
        timeoutMs: 30_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 1_500,
      });
      expect(resolution.config.apiKey).toBe('secret-value');
    }
  });

  it('normalizes the chat completions URL', () => {
    expect(chatCompletionsUrl('https://ai.example/v1')).toBe(
      'https://ai.example/v1/chat/completions',
    );
    expect(chatCompletionsUrl('https://ai.example/v1/chat/completions')).toBe(
      'https://ai.example/v1/chat/completions',
    );
  });
});

describe('OpenAI-compatible provider', () => {
  it('sends a structured JSON-mode request and returns the completion text', async () => {
    let capturedAuthorization: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    const server = await listen((request, response) => {
      capturedAuthorization = request.headers.authorization;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(completionBody('{"claims":[]}'));
      });
    });

    try {
      const provider = createOpenAiCompatibleProvider(baseConfig({ baseUrl: server.url }));
      const result = await provider.complete({
        systemPrompt: 'system',
        userPrompt: 'user',
        maxOutputTokens: 200,
        temperature: 0.1,
      });

      expect(result.text).toBe('{"claims":[]}');
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
      expect(capturedAuthorization).toBe('Bearer test-secret-key');
      expect(capturedBody).toMatchObject({
        model: 'test-model',
        max_tokens: 200,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'user' },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it('builds from environment configuration and yields schema-valid claims', async () => {
    const payload = {
      claims: [
        {
          claimType: 'support_end',
          statement: 'Security updates are provided until December 2030.',
          quotation: 'Security updates will be provided until December 2030.',
          dateText: 'December 2030',
          confidence: 0.9,
          explanation: 'Explicit end-of-support statement.',
        },
      ],
    };

    const server = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(completionBody(JSON.stringify(payload)));
    });

    try {
      const resolution = resolveAiConfig({
        AI_BASE_URL: server.url,
        AI_API_KEY: 'test-secret-key',
        AI_MODEL: 'configured-model',
      });
      expect(resolution.configured).toBe(true);
      if (!resolution.configured) return;

      const provider = createOpenAiCompatibleProvider(resolution.config);
      const result = await provider.complete({
        systemPrompt: 'system',
        userPrompt: 'user',
        maxOutputTokens: 200,
        temperature: 0.1,
      });

      expect(parseAiExtractionResponse(result.text).claims).toEqual([
        expect.objectContaining({
          claimType: 'support_end',
          dateText: 'December 2030',
          confidence: 0.9,
        }),
      ]);
    } finally {
      await server.close();
    }
  });

  it('maps an HTTP provider error without leaking credentials', async () => {
    const server = await listen((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'upstream unavailable' } }));
    });

    try {
      const provider = createOpenAiCompatibleProvider(baseConfig({ baseUrl: server.url }));
      const error = await expectProviderError(
        provider.complete({
          systemPrompt: 'system',
          userPrompt: 'user',
          maxOutputTokens: 200,
          temperature: 0.1,
        }),
        'HTTP_ERROR',
      );
      expect(error.providerStatus).toBe(500);
    } finally {
      await server.close();
    }
  });

  it('rejects a non-JSON provider response', async () => {
    const server = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('not json at all');
    });

    try {
      const provider = createOpenAiCompatibleProvider(baseConfig({ baseUrl: server.url }));
      await expectProviderError(
        provider.complete({
          systemPrompt: 'system',
          userPrompt: 'user',
          maxOutputTokens: 200,
          temperature: 0.1,
        }),
        'INVALID_RESPONSE',
      );
    } finally {
      await server.close();
    }
  });

  it('enforces the configured request timeout', async () => {
    const server = await listen(() => {
      // Deliberately never respond.
    });

    try {
      const provider = createOpenAiCompatibleProvider(
        baseConfig({ baseUrl: server.url, timeoutMs: 120 }),
      );
      const startedAt = Date.now();
      await expectProviderError(
        provider.complete({
          systemPrompt: 'system',
          userPrompt: 'user',
          maxOutputTokens: 200,
          temperature: 0.1,
        }),
        'TIMEOUT',
      );
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await server.close();
    }
  });

  it('rejects input above the configured token budget before calling the network', async () => {
    let fetched = false;
    const provider = createOpenAiCompatibleProvider(baseConfig({ maxInputTokens: 256 }), {
      fetchImpl: (async () => {
        fetched = true;
        return new Response(completionBody('{"claims":[]}'));
      }) as typeof fetch,
    });

    await expectProviderError(
      provider.complete({
        systemPrompt: 'x'.repeat(5_000),
        userPrompt: 'y'.repeat(5_000),
        maxOutputTokens: 200,
        temperature: 0.1,
      }),
      'INPUT_TOO_LARGE',
    );
    expect(fetched).toBe(false);
  });
});
