import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type UrlSafetyErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'CREDENTIALS_IN_URL'
  | 'UNSUPPORTED_PORT'
  | 'BLOCKED_HOSTNAME'
  | 'BLOCKED_ADDRESS'
  | 'DNS_RESOLUTION_FAILED';

export class UrlSafetyError extends Error {
  readonly code: UrlSafetyErrorCode;
  readonly url: string;

  constructor(code: UrlSafetyErrorCode, message: string, url: string) {
    super(message);
    this.name = 'UrlSafetyError';
    this.code = code;
    this.url = url;
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface ValidatedUrl {
  url: URL;
  hostname: string;
  addresses: ResolvedAddress[];
}

const ALLOWED_PORTS = new Set(['', '80', '443']);

// Names that never legitimately resolve to a public manufacturer website.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'localhost4',
  'localhost6',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  '169.254.169.254',
]);

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

export const resolveHostname: HostResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
};

function parseIpv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inIpv4Range(value: number, network: string, prefix: number): boolean {
  const base = parseIpv4(network);
  if (base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function isBlockedIpv4(value: number): boolean {
  return (
    inIpv4Range(value, '0.0.0.0', 8) ||
    inIpv4Range(value, '10.0.0.0', 8) ||
    inIpv4Range(value, '100.64.0.0', 10) ||
    inIpv4Range(value, '127.0.0.0', 8) ||
    inIpv4Range(value, '169.254.0.0', 16) ||
    inIpv4Range(value, '172.16.0.0', 12) ||
    inIpv4Range(value, '192.0.0.0', 24) ||
    inIpv4Range(value, '192.0.2.0', 24) ||
    inIpv4Range(value, '192.88.99.0', 24) ||
    inIpv4Range(value, '192.168.0.0', 16) ||
    inIpv4Range(value, '198.18.0.0', 15) ||
    inIpv4Range(value, '198.51.100.0', 24) ||
    inIpv4Range(value, '203.0.113.0', 24) ||
    inIpv4Range(value, '224.0.0.0', 4) ||
    inIpv4Range(value, '240.0.0.0', 4) ||
    value === 0xffffffff
  );
}

/** Expands an IPv6 literal (optionally with an embedded IPv4 tail) to 8 hextets. */
function parseIpv6(address: string): number[] | null {
  const withoutZone = address.split('%')[0];
  if (!withoutZone) return null;

  const doubleColonParts = withoutZone.split('::');
  if (doubleColonParts.length > 2) return null;

  const head = doubleColonParts[0] ? doubleColonParts[0].split(':') : [];
  const tail = doubleColonParts.length === 2 && doubleColonParts[1] ? doubleColonParts[1].split(':') : [];
  const groups = [...head, ...tail];

  const normalized: number[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (group === undefined) return null;

    if (group.includes('.')) {
      // Embedded IPv4 is only valid as the final group.
      if (index !== groups.length - 1) return null;
      const ipv4 = parseIpv4(group);
      if (ipv4 === null) return null;
      normalized.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
      continue;
    }

    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    normalized.push(Number.parseInt(group, 16));
  }

  const missing = 8 - normalized.length;
  if (doubleColonParts.length === 2) {
    if (missing < 1) return null;
    return [...normalized.slice(0, head.length), ...new Array<number>(missing).fill(0), ...normalized.slice(head.length)];
  }

  return normalized.length === 8 ? normalized : null;
}

function isBlockedIpv6(parts: number[]): boolean {
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = parts;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    fifth === undefined ||
    sixth === undefined ||
    seventh === undefined ||
    eighth === undefined
  ) {
    return true;
  }

  // IPv4-mapped (::ffff:0:0/96) and IPv4-translated (::ffff:0:0:0/96).
  if (first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0) {
    if (sixth === 0xffff || sixth === 0) {
      return isBlockedIpv4(((seventh << 16) | eighth) >>> 0);
    }
  }

  // Unspecified, loopback, ULA, link-local, multicast and reserved ranges.
  if (parts.every((part) => part === 0)) return true;
  if (parts.slice(0, 7).every((part) => part === 0) && eighth === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && second === 0x0db8) return true;
  if (first === 0x2001 && second === 0x0000) return true;
  if (first === 0x2002) return true;
  if (first === 0x0100 && second === 0 && third === 0 && fourth === 0) return true;
  if (first === 0x0064 && second === 0xff9b) return true;
  if (first === 0x2001 && second === 0x0002) return true;

  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase().replace(/\.$/, '');
}

function assertPublicAddress(address: string, family: 4 | 6, url: string): void {
  if (family === 4) {
    const value = parseIpv4(address);
    if (value === null || isBlockedIpv4(value)) {
      throw new UrlSafetyError(
        'BLOCKED_ADDRESS',
        `Refusing to fetch a non-public IPv4 address (${address})`,
        url,
      );
    }
    return;
  }

  const parts = parseIpv6(address);
  if (parts === null || isBlockedIpv6(parts)) {
    throw new UrlSafetyError(
      'BLOCKED_ADDRESS',
      `Refusing to fetch a non-public IPv6 address (${address})`,
      url,
    );
  }
}

/**
 * Validates that a URL is safe to request and resolves it exactly once.
 * Callers must connect to the returned address(es) rather than re-resolving,
 * which closes the DNS-rebinding window between validation and connection.
 */
export async function assertSafeUrl(
  rawUrl: string,
  options: { resolve?: HostResolver } = {},
): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlSafetyError('INVALID_URL', 'URL cannot be parsed', rawUrl);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlSafetyError(
      'UNSUPPORTED_SCHEME',
      `Unsupported URL scheme "${url.protocol.replace(/:$/, '')}"; only http and https are allowed`,
      rawUrl,
    );
  }

  if (url.username || url.password) {
    throw new UrlSafetyError('CREDENTIALS_IN_URL', 'URLs with embedded credentials are not allowed', rawUrl);
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UrlSafetyError(
      'UNSUPPORTED_PORT',
      `Port ${url.port} is not allowed; only 80 and 443 are permitted`,
      rawUrl,
    );
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) {
    throw new UrlSafetyError('INVALID_URL', 'URL has no hostname', rawUrl);
  }

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new UrlSafetyError('BLOCKED_HOSTNAME', `Refusing to fetch blocked hostname "${hostname}"`, rawUrl);
  }

  const literalFamily = isIP(hostname);
  let addresses: ResolvedAddress[];

  if (literalFamily !== 0) {
    addresses = [{ address: hostname, family: literalFamily === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await (options.resolve ?? resolveHostname)(hostname);
    } catch {
      throw new UrlSafetyError('DNS_RESOLUTION_FAILED', `Could not resolve hostname "${hostname}"`, rawUrl);
    }
  }

  if (addresses.length === 0) {
    throw new UrlSafetyError('DNS_RESOLUTION_FAILED', `Hostname "${hostname}" resolved to no addresses`, rawUrl);
  }

  for (const address of addresses) {
    assertPublicAddress(address.address, address.family, rawUrl);
  }

  return { url, hostname, addresses };
}

export function isBlockedAddressForTests(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = parseIpv4(address);
    return value === null || isBlockedIpv4(value);
  }
  if (family === 6) {
    const parts = parseIpv6(address);
    return parts === null || isBlockedIpv6(parts);
  }
  return true;
}
