import { describe, expect, it } from 'vitest';
import {
  createSafeFetcher,
  FetchError,
  type Transport,
  type TransportRequest,
} from '../src/research/fetcher.js';
import { loadRobotsPolicy } from '../src/research/robots.js';
import { assertSafeUrl, isBlockedAddressForTests, type HostResolver } from '../src/research/url-safety.js';

function resolverReturning(...addresses: string[]): HostResolver {
  return async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? (6 as const) : (4 as const),
    }));
}

const publicResolver = resolverReturning('93.184.216.34');

function htmlResponse(
  body: string,
  status = 200,
  contentType = 'text/html; charset=utf-8',
) {
  return {
    status,
    headers: { 'content-type': contentType },
    body: Buffer.from(body),
  };
}

function transportFor(
  handler: (request: TransportRequest) => ReturnType<Transport>,
): Transport {
  return handler;
}

describe('URL safety', () => {
  it('blocks localhost, private, link-local and reserved destinations', async () => {
    for (const url of [
      'http://localhost/',
      'http://localhost.localdomain/',
      'http://127.0.0.1/',
      'http://127.10.0.1/',
      'http://10.1.2.3/',
      'http://172.16.5.4/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
    ]) {
      await expect(assertSafeUrl(url, { resolve: publicResolver })).rejects.toMatchObject({
        name: 'UrlSafetyError',
      });
    }
  });

  it('blocks a public hostname that resolves to a private address', async () => {
    await expect(
      assertSafeUrl('https://rebind.example/', { resolve: resolverReturning('10.0.0.7') }),
    ).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });

    await expect(
      assertSafeUrl('https://rebind.example/', { resolve: resolverReturning('8.8.8.8', '192.168.0.2') }),
    ).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
  });

  it('rejects unsupported schemes, credentials, non-standard ports and invalid URLs', async () => {
    const cases: Array<[string, string]> = [
      ['file:///etc/passwd', 'UNSUPPORTED_SCHEME'],
      ['ftp://example.com/', 'UNSUPPORTED_SCHEME'],
      ['javascript:alert(1)', 'UNSUPPORTED_SCHEME'],
      ['https://user:secret@example.com/', 'CREDENTIALS_IN_URL'],
      ['http://example.com:8080/', 'UNSUPPORTED_PORT'],
      ['not a url', 'INVALID_URL'],
    ];

    for (const [url, code] of cases) {
      await expect(assertSafeUrl(url, { resolve: publicResolver })).rejects.toMatchObject({ code });
    }
  });

  it('accepts a public address', async () => {
    const validated = await assertSafeUrl('https://example.com/support', {
      resolve: publicResolver,
    });

    expect(validated.hostname).toBe('example.com');
    expect(validated.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('classifies IPv4-mapped and documentation addresses as unsafe', () => {
    expect(isBlockedAddressForTests('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddressForTests('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedAddressForTests('192.0.2.1')).toBe(true);
    expect(isBlockedAddressForTests('8.8.4.4')).toBe(false);
  });
});

describe('safe fetcher limits', () => {
  it('follows a same-host redirect and reports the final URL', async () => {
    const transport = transportFor(({ url }) => {
      if (url.pathname === '/old') {
        return Promise.resolve({
          status: 301,
          headers: { location: '/new', 'content-type': 'text/html' },
          body: Buffer.from(''),
        });
      }
      return Promise.resolve(htmlResponse('<html><body>new</body></html>'));
    });

    const fetcher = createSafeFetcher({ resolve: publicResolver, transport });
    const result = await fetcher.fetch('https://example.com/old');

    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe('https://example.com/new');
    expect(result.redirects).toBe(1);
  });

  it('refuses cross-host redirects', async () => {
    const transport = transportFor(() =>
      Promise.resolve({
        status: 302,
        headers: { location: 'https://internal.example/admin', 'content-type': 'text/html' },
        body: Buffer.from(''),
      }),
    );

    const fetcher = createSafeFetcher({ resolve: publicResolver, transport });

    await expect(fetcher.fetch('https://example.com/start')).rejects.toMatchObject({
      code: 'CROSS_HOST_REDIRECT',
    });
  });

  it('stops after the redirect limit', async () => {
    const transport = transportFor(({ url }) =>
      Promise.resolve({
        status: 302,
        headers: {
          location: url.pathname === '/loop' ? '/loop' : '/loop',
          'content-type': 'text/html',
        },
        body: Buffer.from(''),
      }),
    );

    const fetcher = createSafeFetcher({ resolve: publicResolver, transport, maxRedirects: 2 });

    await expect(fetcher.fetch('https://example.com/loop')).rejects.toMatchObject({
      code: 'TOO_MANY_REDIRECTS',
    });
  });

  it('rejects responses larger than the byte limit', async () => {
    const transport = transportFor(() =>
      Promise.resolve(htmlResponse(`<html><body>${'x'.repeat(5000)}</body></html>`)),
    );

    const fetcher = createSafeFetcher({ resolve: publicResolver, transport, maxBytes: 1000 });

    await expect(fetcher.fetch('https://example.com/big')).rejects.toMatchObject({
      code: 'TOO_LARGE',
    });
  });

  it('times out slow responses', async () => {
    const transport = transportFor(
      () => new Promise((resolve) => setTimeout(() => resolve(htmlResponse('<html/>')), 500)),
    );

    const fetcher = createSafeFetcher({ resolve: publicResolver, transport, timeoutMs: 50 });

    await expect(fetcher.fetch('https://example.com/slow')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('rejects non-HTML successful responses', async () => {
    const transport = transportFor(() =>
      Promise.resolve(htmlResponse('%PDF-1.7', 200, 'application/pdf')),
    );

    const fetcher = createSafeFetcher({ resolve: publicResolver, transport });

    await expect(fetcher.fetch('https://example.com/manual.pdf')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT_TYPE',
    });
  });

  it('returns non-2xx responses so callers can report HTTP failures', async () => {
    const transport = transportFor(() =>
      Promise.resolve(htmlResponse('<html><body>gone</body></html>', 404)),
    );

    const fetcher = createSafeFetcher({ resolve: publicResolver, transport });
    const result = await fetcher.fetch('https://example.com/missing');

    expect(result.status).toBe(404);
  });

  it('revalidates a redirect hop, defeating DNS rebinding', async () => {
    // The first lookup is public and the second (for the redirect target)
    // returns a private address. Every hop must be revalidated.
    let lookups = 0;
    const resolve: HostResolver = async () => {
      lookups += 1;
      return [
        lookups === 1
          ? { address: '93.184.216.34', family: 4 as const }
          : { address: '127.0.0.1', family: 4 as const },
      ];
    };

    const transport = transportFor(() =>
      Promise.resolve({
        status: 302,
        headers: { location: 'https://rebind.example/next', 'content-type': 'text/html' },
        body: Buffer.from(''),
      }),
    );

    const fetcher = createSafeFetcher({ resolve, transport });

    await expect(fetcher.fetch('https://rebind.example/start')).rejects.toMatchObject({
      code: 'BLOCKED_ADDRESS',
    });
  });
});

describe('robots.txt', () => {
  function fakeFetcher(body: string, status = 200) {
    return {
      async fetch(url: string) {
        return {
          url,
          finalUrl: url,
          status,
          contentType: 'text/plain',
          body,
          bytes: Buffer.byteLength(body),
          fetchedAt: new Date(),
          redirects: 0,
        };
      },
    };
  }

  it('honours disallow rules and allows unmatched paths', async () => {
    const policy = await loadRobotsPolicy(
      new URL('https://example.com'),
      fakeFetcher('User-agent: *\nDisallow: /support/private\nAllow: /support/private/public\n'),
    );

    expect(policy.isAllowed('https://example.com/support/security')).toBe(true);
    expect(policy.isAllowed('https://example.com/support/private')).toBe(false);
    expect(policy.isAllowed('https://example.com/support/private/public')).toBe(true);
  });

  it('allows everything when robots.txt is missing', async () => {
    const policy = await loadRobotsPolicy(
      new URL('https://example.com'),
      fakeFetcher('not found', 404),
    );

    expect(policy.behaviour).toBe('unavailable');
    expect(policy.isAllowed('https://example.com/anything')).toBe(true);
  });

  it('forbids access when robots.txt is explicitly forbidden', async () => {
    const policy = await loadRobotsPolicy(
      new URL('https://example.com'),
      fakeFetcher('forbidden', 403),
    );

    expect(policy.behaviour).toBe('forbidden');
    expect(policy.isAllowed('https://example.com/')).toBe(false);
  });

  it('fetches text/plain robots.txt through the safe fetcher', async () => {
    const transport = transportFor(() =>
      Promise.resolve(htmlResponse('User-agent: *\nDisallow: /private', 200, 'text/plain')),
    );
    const fetcher = createSafeFetcher({ resolve: publicResolver, transport });
    const policy = await loadRobotsPolicy(new URL('https://example.com'), fetcher);

    expect(policy.behaviour).toBe('parsed');
    expect(policy.isAllowed('https://example.com/private')).toBe(false);
  });

  it('survives a robots.txt fetch failure', async () => {
    const policy = await loadRobotsPolicy(new URL('https://example.com'), {
      async fetch() {
        throw new FetchError('TIMEOUT', 'timed out', 'https://example.com/robots.txt');
      },
    });

    expect(policy.behaviour).toBe('unavailable');
    expect(policy.isAllowed('https://example.com/support')).toBe(true);
  });
});
