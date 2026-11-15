import { createServer, type RequestListener } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  createOpenAiCompatibleProvider,
  resolveAiConfig,
} from '../src/extraction/openai-compatible-provider.js';
import {
  ExtractionOutputError,
  parseAiExtractionResponse,
} from '../src/extraction/extraction-schema.js';
import { AiProviderError, describeProviderFailure } from '../src/extraction/provider.js';

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

describe('OpenServ SERV Reasoning Provider Integration', () => {
  it('resolves SERV_API_KEY with official OpenServ base URL and default gpt-5.4-mini model', () => {
    const resolution = resolveAiConfig({
      SERV_API_KEY: 'serv-test-key-12345',
    });

    expect(resolution.configured).toBe(true);
    if (!resolution.configured) return;
    expect(resolution.config.apiKey).toBe('serv-test-key-12345');
    expect(resolution.config.baseUrl).toBe('https://inference-api.openserv.ai/v1');
    expect(resolution.config.model).toBe('gpt-5.4-mini');
    expect(resolution.config.providerType).toBe('openserv-serv');
  });

  it('allows overriding SERV_MODEL and SERV_BASE_URL when specified', () => {
    const resolution = resolveAiConfig({
      SERV_API_KEY: 'serv-custom-key',
      SERV_MODEL: 'gpt-5.4-mini-custom',
      SERV_BASE_URL: 'https://custom.openserv.ai/v1',
    });

    expect(resolution.configured).toBe(true);
    if (!resolution.configured) return;
    expect(resolution.config.baseUrl).toBe('https://custom.openserv.ai/v1');
    expect(resolution.config.model).toBe('gpt-5.4-mini-custom');
  });

  it('reports unconfigured when neither SERV_API_KEY nor AI_* variables are present', () => {
    const resolution = resolveAiConfig({});
    expect(resolution.configured).toBe(false);
  });

  it('sends Bearer authentication, system message and model in request body', async () => {
    let capturedAuth: string | undefined;
    let capturedBody: any;

    const server = await listen(async (req, res) => {
      capturedAuth = req.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'req-serv-test-001',
      });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-serv-001',
          model: 'gpt-5.4-mini',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  claims: [
                    {
                      claimType: 'support_end',
                      statement: 'Updates provided until December 31, 2030.',
                      quotation: 'Updates provided until December 31, 2030.',
                      dateText: 'December 31, 2030',
                      confidence: 0.95,
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 45 },
        }),
      );
    });

    try {
      const provider = createOpenAiCompatibleProvider({
        baseUrl: server.url,
        apiKey: 'serv-secret-token',
        model: 'gpt-5.4-mini',
        timeoutMs: 5_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 1_500,
        providerType: 'openserv-serv',
      });

      expect(provider.isServ).toBe(true);
      expect(provider.name).toBe('openserv-serv:gpt-5.4-mini');

      const result = await provider.complete({
        systemPrompt: 'You extract security-support evidence.',
        userPrompt: 'Extract claims from sample page.',
        maxOutputTokens: 500,
        temperature: 0.1,
      });

      expect(capturedAuth).toBe('Bearer serv-secret-token');
      expect(capturedBody.model).toBe('gpt-5.4-mini');
      expect(capturedBody.max_completion_tokens).toBe(500);
      expect(capturedBody.max_tokens).toBeUndefined();
      expect(capturedBody.messages).toHaveLength(2);
      expect(capturedBody.messages[0]).toEqual({
        role: 'system',
        content: 'You extract security-support evidence.',
      });
      expect(capturedBody.response_format).toEqual({ type: 'json_object' });

      expect(result.model).toBe('gpt-5.4-mini');
      expect(result.requestId).toBe('req-serv-test-001');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.usage).toEqual({
        inputTokens: 120,
        outputTokens: 45,
        totalTokens: 165,
      });

      const parsed = parseAiExtractionResponse(result.text);
      expect(parsed.claims).toHaveLength(1);
      expect(parsed.claims[0]!.claimType).toBe('support_end');
      expect(parsed.claims[0]!.confidence).toBe(0.95);
    } finally {
      await server.close();
    }
  });

  it('normalizes common model variations: space-separated claimType, date key, string confidence', () => {
    const rawServJson = JSON.stringify({
      claims: [
        {
          claimType: 'support end',
          statement: 'Support ends in 2030.',
          evidence: 'Security support is guaranteed until 2030.',
          date: '2030',
          confidence: 'high',
          explanation: 'Explicit support end date.',
        },
      ],
    });

    const parsed = parseAiExtractionResponse(rawServJson);
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0]!.claimType).toBe('support_end');
    expect(parsed.claims[0]!.quotation).toBe('Security support is guaranteed until 2030.');
    expect(parsed.claims[0]!.dateText).toBe('2030');
    expect(parsed.claims[0]!.confidence).toBe(0.95);
  });

  it('normalizes SERV descriptive field names and recovers a verbatim statement as the quotation', () => {
    const sourceContent =
      'With the Fairphone 5, we became the first to offer guaranteed software support for at least eight years, with five major Android updates.';
    const rawServJson = JSON.stringify({
      claims: [
        {
          claim_type: 'support_duration',
          supported_claim:
            'Fairphone offers guaranteed software support for at least eight years.',
          verbatim_quote: sourceContent,
          date_text: null,
          confidence: 0.96,
        },
        {
          claim_type: 'support_policy',
          supported_statement: sourceContent,
          confidence: 0.9,
        },
      ],
    });

    const parsed = parseAiExtractionResponse(rawServJson, { sourceContent });
    expect(parsed.claims).toHaveLength(2);
    expect(parsed.claims[0]!.claimType).toBe('policy');
    expect(parsed.claims[0]!.quotation).toBe(sourceContent);
    expect(parsed.claims[1]!.claimType).toBe('policy');
    expect(parsed.claims[1]!.quotation).toBe(sourceContent);
  });

  it('rejects an omitted quotation when the statement is not verbatim source text', () => {
    const rawServJson = JSON.stringify({
      claims: [
        {
          claimType: 'support_end',
          statement: 'Support ends sometime in the future.',
          dateText: null,
          confidence: 0.9,
        },
      ],
    });

    let failure: unknown;
    try {
      parseAiExtractionResponse(rawServJson, {
        sourceContent: 'Security updates are provided until 31 December 2030.',
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ExtractionOutputError);
    expect((failure as ExtractionOutputError).issues?.[0]).toMatch(/quotation must not be empty/);
  });

  it('normalizes verbose operating-system claim types from model output', () => {
    const rawServJson = JSON.stringify({
      claims: [
        {
          claimType: 'operating_system_version',
          statement: 'The device supports Northline OS 3.0 and newer.',
          evidence: 'Supported operating systems: Northline OS 3.0 and newer.',
          dateText: null,
          confidence: 0.96,
          explanation: 'Operating-system compatibility statement.',
        },
      ],
    });

    const parsed = parseAiExtractionResponse(rawServJson);
    expect(parsed.claims[0]!.claimType).toBe('os_version');
  });

  it('handles HTTP 429 rate limit error cleanly without exposing credentials', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limit exceeded: quota depleted' } }));
    });

    try {
      const provider = createOpenAiCompatibleProvider({
        baseUrl: server.url,
        apiKey: 'sensitive-api-key',
        model: 'gpt-5.4-mini',
        timeoutMs: 5_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 1_500,
      });

      await expect(
        provider.complete({
          systemPrompt: 'sys',
          userPrompt: 'user',
          maxOutputTokens: 100,
          temperature: 0.1,
        }),
      ).rejects.toThrowError(/Rate limit exceeded.*HTTP 429/);
    } finally {
      await server.close();
    }
  });

  it('handles provider timeout through AbortSignal', async () => {
    const server = await listen((_req, _res) => {
      // Intentionally do not respond to trigger timeout
    });

    try {
      const provider = createOpenAiCompatibleProvider({
        baseUrl: server.url,
        apiKey: 'test-key',
        model: 'gpt-5.4-mini',
        timeoutMs: 80, // Very low timeout for test speed
        maxInputTokens: 8_000,
        maxOutputTokens: 1_500,
      });

      await expect(
        provider.complete({
          systemPrompt: 'sys',
          userPrompt: 'user',
          maxOutputTokens: 100,
          temperature: 0.1,
        }),
      ).rejects.toThrowError(AiProviderError);
    } finally {
      await server.close();
    }
  });

  it('handles non-JSON error response from provider gracefully', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<html>Bad Gateway</html>');
    });

    try {
      const provider = createOpenAiCompatibleProvider({
        baseUrl: server.url,
        apiKey: 'test-key',
        model: 'gpt-5.4-mini',
        timeoutMs: 5_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 1_500,
      });

      await expect(
        provider.complete({
          systemPrompt: 'sys',
          userPrompt: 'user',
          maxOutputTokens: 100,
          temperature: 0.1,
        }),
      ).rejects.toThrowError(/non-JSON response/);
    } finally {
      await server.close();
    }
  });

  it('maps upstream 429 to a rate-limit failure without leaking the key', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'quota exceeded' } }));
    });

    try {
      const provider = createOpenAiCompatibleProvider({
        baseUrl: server.url,
        apiKey: 'super-secret-serv-key',
        model: 'gpt-5.4-mini',
        timeoutMs: 5_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 1_500,
      });

      const error = await provider
        .complete({ systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 100, temperature: 0.1 })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AiProviderError);
      const failure = describeProviderFailure(error as AiProviderError);
      expect(failure.statusCode).toBe(429);
      expect(failure.code).toBe('AI_PROVIDER_RATE_LIMITED');
      expect(failure.message).not.toContain('super-secret-serv-key');
    } finally {
      await server.close();
    }
  });

  it('maps upstream 401 to an auth failure without echoing credentials', async () => {
    const server = await listen((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid token' } }));
    });

    try {
      const provider = createOpenAiCompatibleProvider({
        baseUrl: server.url,
        apiKey: 'super-secret-serv-key',
        model: 'gpt-5.4-mini',
        timeoutMs: 5_000,
        maxInputTokens: 8_000,
        maxOutputTokens: 1_500,
      });

      const error = await provider
        .complete({ systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 100, temperature: 0.1 })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AiProviderError);
      const failure = describeProviderFailure(error as AiProviderError);
      expect(failure.statusCode).toBe(502);
      expect(failure.code).toBe('AI_PROVIDER_AUTH_FAILED');
      expect(failure.message).not.toContain('super-secret-serv-key');
    } finally {
      await server.close();
    }
  });
});
