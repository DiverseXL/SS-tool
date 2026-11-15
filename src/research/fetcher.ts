import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { assertSafeUrl, UrlSafetyError, type HostResolver, type ResolvedAddress } from './url-safety.js';

export const DEFAULT_USER_AGENT =
  'SS-Tool-Research/1.0 (manufacturer support-page discovery; respectful, rate-limited crawler)';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 3;

export type FetchErrorCode =
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'CROSS_HOST_REDIRECT'
  | 'TOO_MANY_REDIRECTS'
  | 'INVALID_REDIRECT'
  | 'NETWORK_ERROR';

export class FetchError extends Error {
  readonly code: FetchErrorCode;
  readonly url: string;
  readonly statusCode: number | undefined;

  constructor(code: FetchErrorCode, message: string, url: string, statusCode?: number) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.url = url;
    this.statusCode = statusCode;
  }
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** robots.txt is text/plain; only that caller may opt out of the HTML check. */
  allowNonHtml?: boolean;
}

export interface FetchResult {
  /** The URL that was requested. */
  url: string;
  /** URL after any same-host redirects. */
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: string;
  bytes: number;
  fetchedAt: Date;
  redirects: number;
}

export interface Fetcher {
  fetch(url: string, options?: FetchOptions): Promise<FetchResult>;
}

export interface TransportRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetcherOptions {
  resolve?: HostResolver;
  transport?: Transport;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

function sameHostname(left: URL, right: URL): boolean {
  const normalize = (hostname: string) => hostname.toLowerCase().replace(/\.$/, '');
  return normalize(left.hostname) === normalize(right.hostname);
}

/**
 * Performs a single HTTP(S) GET against a pre-validated address. The socket is
 * pinned to that address, so a second DNS answer cannot redirect it elsewhere.
 */
export const nodeTransport: Transport = ({ url, address, family, timeoutMs, maxBytes, userAgent, signal }) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const lookup: LookupFunction = (_hostname, options, callback) => {
      // Node requests `all` when Happy Eyeballs is in play; honour both forms.
      if (options.all) {
        callback(null, [{ address, family }]);
        return;
      }
      callback(null, address, family);
    };

    const request = requestFn(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
        },
        lookup,
        signal,
        ...(isHttps ? { servername: url.hostname.replace(/^\[|\]$/g, '') } : {}),
      },
      (response) => {
        const contentLength = Number(response.headers['content-length'] ?? 0);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          response.destroy();
          reject(
            new FetchError(
              'TOO_LARGE',
              `Response declares ${contentLength} bytes, limit is ${maxBytes}`,
              url.href,
              response.statusCode,
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;

        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maxBytes) {
            response.destroy();
            reject(
              new FetchError(
                'TOO_LARGE',
                `Response exceeded the ${maxBytes} byte limit`,
                url.href,
                response.statusCode,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });

        response.on('error', (error) => {
          reject(
            new FetchError('NETWORK_ERROR', `Response failed: ${error.message}`, url.href),
          );
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new FetchError('TIMEOUT', `Request timed out after ${timeoutMs}ms`, url.href),
      );
    });

    request.on('error', (error) => {
      if (error instanceof FetchError) {
        reject(error);
        return;
      }
      if (signal.aborted) {
        reject(new FetchError('TIMEOUT', `Request timed out after ${timeoutMs}ms`, url.href));
        return;
      }
      reject(new FetchError('NETWORK_ERROR', `Request failed: ${error.message}`, url.href));
    });

    request.end();
  });

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  url: string,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FetchError('TIMEOUT', `Request timed out after ${timeoutMs}ms`, url));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Builds the HTTP fetcher used in production. Every hop is resolved and
 * validated exactly once, then connected to by address. Cross-host redirects
 * are refused rather than followed.
 */
export function createSafeFetcher(options: SafeFetcherOptions = {}): Fetcher {
  const resolve = options.resolve ?? undefined;
  const transport = options.transport ?? nodeTransport;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultMaxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  return {
    async fetch(rawUrl, fetchOptions = {}) {
      const timeoutMs = fetchOptions.timeoutMs ?? defaultTimeout;
      const maxBytes = fetchOptions.maxBytes ?? defaultMaxBytes;
      const deadline = Date.now() + timeoutMs;

      let currentUrl = rawUrl;
      let redirects = 0;

      for (;;) {
        // Validates scheme, credentials, port, hostname and address family.
        let validated: { url: URL; addresses: ResolvedAddress[] };
        try {
          validated = await assertSafeUrl(currentUrl, resolve ? { resolve } : {});
        } catch (error) {
          if (error instanceof UrlSafetyError) throw error;
          throw new FetchError('NETWORK_ERROR', 'URL validation failed', currentUrl);
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new FetchError('TIMEOUT', `Request timed out after ${timeoutMs}ms`, currentUrl);
        }

        const primary = validated.addresses[0];
        if (!primary) {
          throw new FetchError('NETWORK_ERROR', 'URL resolved to no addresses', currentUrl);
        }

        // A fresh controller per hop keeps one slow redirect from consuming the
        // next hop's allowance; the overall deadline still bounds the request.
        const controller = new AbortController();
        const startedAt = Date.now();

        let response: TransportResponse;
        try {
          response = await withTimeout(
            transport({
              url: validated.url,
              address: primary.address,
              family: primary.family,
              timeoutMs: Math.min(remaining, timeoutMs),
              maxBytes,
              userAgent,
              signal: controller.signal,
            }),
            remaining,
            currentUrl,
            controller,
          );
        } catch (error) {
          if (error instanceof FetchError) throw error;
          if (error instanceof UrlSafetyError) throw error;
          throw new FetchError(
            'NETWORK_ERROR',
            error instanceof Error ? error.message : 'Request failed',
            currentUrl,
          );
        }

        if (response.body.byteLength > maxBytes) {
          throw new FetchError(
            'TOO_LARGE',
            `Response exceeded the ${maxBytes} byte limit`,
            currentUrl,
            response.status,
          );
        }

        const contentType = headerValue(response.headers, 'content-type') ?? null;
        const location = headerValue(response.headers, 'location');

        if (isRedirect(response.status) && location) {
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

          redirects += 1;
          currentUrl = next.href;
          continue;
        }

        if (
          response.status >= 200 &&
          response.status < 300 &&
          !fetchOptions.allowNonHtml &&
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
          body: response.body.toString('utf8'),
          bytes: response.body.byteLength,
          fetchedAt: new Date(startedAt),
          redirects,
        };
      }
    },
  };
}
