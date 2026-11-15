import { createHash } from 'node:crypto';
import { RELEVANT_HEADING_PATTERN } from './keywords.js';

export interface DiscoveredLink {
  url: string;
  anchorText: string;
}

export interface ExtractedPage {
  title: string | null;
  canonicalUrl: string | null;
  description: string | null;
  h1: string[];
  h2: string[];
  text: string;
  links: DiscoveredLink[];
  contentHash: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  copy: '(c)',
  reg: '(r)',
  trade: '(tm)',
  times: 'x',
  euro: 'EUR',
  pound: 'GBP',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }

    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

  for (const match of tag.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? '';
  }

  return attributes;
}

function removeElement(html: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  return html.replace(pattern, ' ');
}

function removeComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

function firstMatch(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html);
  return match?.[1] ? stripTags(match[1]) : null;
}

function extractHeadings(html: string, level: 1 | 2): string[] {
  const pattern = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
  const headings: string[] = [];

  for (const match of html.matchAll(pattern)) {
    const heading = stripTags(match[1] ?? '');
    if (heading) headings.push(heading);
    if (headings.length >= 20) break;
  }

  return headings;
}

function extractLinks(html: string, pageUrl: string): DiscoveredLink[] {
  const links: DiscoveredLink[] = [];
  const seen = new Set<string>();

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = parseAttributes(match[1] ?? '');
    const href = attributes['href']?.trim();
    if (!href) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, pageUrl);
    } catch {
      continue;
    }

    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;
    resolved.hash = '';

    const url = resolved.href;
    if (seen.has(url)) continue;
    seen.add(url);

    links.push({ url, anchorText: stripTags(match[2] ?? '') });
  }

  return links;
}

function extractReadableText(html: string): string {
  const main =
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ??
    html;

  const cleaned = decodeEntities(main.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= 20_000) return cleaned;

  // Cut at a word boundary so the stored excerpt never ends mid-word.
  const truncated = cleaned.slice(0, 20_000);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Extracts the small, reviewable subset of a page that later evidence work
 * needs. Full HTML is intentionally discarded after hashing.
 */
export function extractHtml(html: string, pageUrl: string): ExtractedPage {
  const contentHash = createHash('sha256').update(html, 'utf8').digest('hex');

  const title = firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);

  let description: string | null = null;
  for (const match of html.matchAll(/<meta\b([^>]*?)\/?>/gi)) {
    const attributes = parseAttributes(match[1] ?? '');
    const name = attributes['name']?.toLowerCase() ?? attributes['property']?.toLowerCase();
    if (name === 'description' && attributes['content']) {
      description = decodeEntities(attributes['content']).replace(/\s+/g, ' ').trim() || null;
      break;
    }
  }

  let canonicalUrl: string | null = null;
  for (const match of html.matchAll(/<link\b([^>]*?)\/?>/gi)) {
    const attributes = parseAttributes(match[1] ?? '');
    if (attributes['rel']?.toLowerCase() === 'canonical' && attributes['href']) {
      try {
        const canonical = new URL(attributes['href'], pageUrl);
        if (canonical.protocol === 'http:' || canonical.protocol === 'https:') {
          canonicalUrl = canonical.href;
        }
      } catch {
        canonicalUrl = null;
      }
      break;
    }
  }

  const h1 = extractHeadings(html, 1);
  const h2 = extractHeadings(html, 2).filter((heading) => RELEVANT_HEADING_PATTERN.test(heading));
  const links = extractLinks(html, pageUrl);

  let text = removeComments(html);
  for (const tag of ['script', 'style', 'noscript', 'template', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'iframe']) {
    text = removeElement(text, tag);
  }

  return {
    title,
    canonicalUrl,
    description,
    h1,
    h2,
    text: extractReadableText(text),
    links,
    contentHash,
  };
}
