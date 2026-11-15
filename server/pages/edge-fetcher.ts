import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  FetchError,
  type Fetcher,
  type FetchOptions,
  type FetchResult,
} from '../../src/research/fetcher.js';
import type { UrlValidator } from '../../src/research/research-service.js';
import {
  assertSafeUrl,
  UrlSafetyError,
  type HostResolver,
  type ResolvedAddress,
} from '../../src/research/url-safety.js';

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

interface DohAnswer {
  type: number;
  data: string;
}

interface DohResponse {
  Answer?: DohAnswer[];
}

/**
 * Resolves a hostname with DNS-over-HTTPS. Workers has no general-purpose DNS
 * API, so this keeps the address allow-list check intact before an outbound
 * fetch instead of silently skipping validation.
 */
export const dohResolve: HostResolver = async (hostname) => {
  const addresses: ResolvedAddress[] = [];

  for (const [type, family] of [
    ['A', 4],
    ['AAAA', 6],
  ] as const) {
    const url = new URL(DOH_ENDPOINT);
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', type);

    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`DNS-over-HTTPS lookup failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as DohResponse;
    for (const answer of payload.Answer ?? []) {
      if (answer.type !== 1 && answer.type !== 28) continue;
      addresses.push({ address: answer.data, family });
    }
  }

  return addresses;
};

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

function sameHostname(left: URL, right: URL): boolean {
  const normalize = (hostname: string) => hostname.toLowerCase().replace(/\.$/, '');
  return normalize(left.hostname) === normalize(right.hostname);
}

async function readBody(response: Response, maxBytes: number, url: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new FetchError(
      'TOO_LARGE',
      `Response declares ${declared} bytes, limit is ${maxBytes}`,
      url,
      response.status,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError(
        'TOO_LARGE',
        `Response exceeded the ${maxBytes} byte limit`,
        url,
        response.status,
      );
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * Workers-compatible replacement for the Node HTTP transport in
 * `src/research/fetcher.ts`. URL safety, redirect rules, content-type and size
 * limits match the Node fetcher. DNS is resolved through DoH and validated
 * before every hop.
 */
export function createEdgeFetcher(): Fetcher {
  return {
    async fetch(rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
      const maxRedirects = DEFAULT_MAX_REDIRECTS;
      const deadline = Date.now() + timeoutMs;

      let currentUrl = rawUrl;
      let redirects = 0;

      for (;;) {
        let validated;
        try {
          validated = await assertSafeUrl(currentUrl, { resolve: dohResolve });
        } catch (error) {
          if (error instanceof UrlSafetyError) throw error;
          throw new FetchError('NETWORK_ERROR', 'URL validation failed', currentUrl);
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new FetchError('TIMEOUT', `Request timed out after ${timeoutMs}ms`, currentUrl);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);
        const startedAt = Date.now();

        let response: Response;
        try {
          response = await fetch(validated.url, {
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              'user-agent': DEFAULT_USER_AGENT,
              accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
              'accept-encoding': 'identity',
            },
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new FetchError('TIMEOUT', `Request timed out after ${timeoutMs}ms`, currentUrl);
          }
          throw new FetchError(
            'NETWORK_ERROR',
            error instanceof Error ? error.message : 'Request failed',
            currentUrl,
          );
        } finally {
          clearTimeout(timer);
        }

        const contentType = response.headers.get('content-type');
        const location = response.headers.get('location');

        if (
          response.status === 301 ||
          response.status === 302 ||
          response.status === 303 ||
          response.status === 307 ||
          response.status === 308
        ) {
          if (!location) {
            throw new FetchError('INVALID_REDIRECT', 'Redirect has no location', currentUrl);
          }
          if (redirects >= maxRedirects) {
            throw new FetchError(
              'TOO_MANY_REDIRECTS',
              `More than ${maxRedirects} redirects`,
              currentUrl,
              response.status,
            );
          }

          let next: URL;
          try {
            next = new URL(location, validated.url);
          } catch {
            throw new FetchError('INVALID_REDIRECT', 'Redirect location is not a valid URL', currentUrl);
          }

          if (!sameHostname(validated.url, next)) {
            throw new FetchError(
              'CROSS_HOST_REDIRECT',
              `Cross-host redirect from ${validated.url.hostname} to ${next.hostname} is not allowed`,
              currentUrl,
              response.status,
            );
          }

          await response.body?.cancel();
          redirects += 1;
          currentUrl = next.href;
          continue;
        }

        const body = await readBody(response, maxBytes, currentUrl);

        if (
          response.status >= 200 &&
          response.status < 300 &&
          !options.allowNonHtml &&
          !isHtmlContentType(contentType)
        ) {
          throw new FetchError(
            'UNSUPPORTED_CONTENT_TYPE',
            `Only HTML is supported, received "${contentType ?? 'no content type'}"`,
            currentUrl,
            response.status,
          );
        }

        return {
          url: rawUrl,
          finalUrl: validated.url.href,
          status: response.status,
          contentType,
          body: body.toString('utf8'),
          bytes: body.byteLength,
          fetchedAt: new Date(startedAt),
          redirects,
        };
      }
    },
  };
}

export const edgeValidateUrl: UrlValidator = async (url) => {
  const validated = await assertSafeUrl(url, { resolve: dohResolve });
  return { url: validated.url, hostname: validated.hostname };
};
