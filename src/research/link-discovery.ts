import type { SourceRelationshipType } from '../db/schema.js';
import type { DiscoveredLink } from './html-extractor.js';
import {
  IRRELEVANT_PATTERN,
  LIFECYCLE_PATTERN,
  SECURITY_PATTERN,
  SUPPORT_PATTERN,
  UPDATE_PATTERN,
  isIrrelevantUrl,
} from './keywords.js';

export interface RankedLink {
  url: string;
  anchorText: string;
  score: number;
  relationshipType: Extract<
    SourceRelationshipType,
    'support_page' | 'security_advisory' | 'policy_page'
  >;
}

export interface DiscoveryResult {
  /** Same-host pages, highest relevance first. */
  relevant: RankedLink[];
  /** Relevant pages on other hosts: recorded, never fetched. */
  external: RankedLink[];
  /** Every unique link seen on the page, including irrelevant ones. */
  totalLinks: number;
}

interface Classification {
  score: number;
  relationshipType: RankedLink['relationshipType'];
}

function classify(haystack: string): Classification | null {
  if (IRRELEVANT_PATTERN.test(haystack)) return null;

  let score = 0;
  if (SECURITY_PATTERN.test(haystack)) score += 50;
  if (LIFECYCLE_PATTERN.test(haystack)) score += 40;
  if (UPDATE_PATTERN.test(haystack)) score += 30;
  if (SUPPORT_PATTERN.test(haystack)) score += 20;

  if (score === 0) return null;

  let relationshipType: RankedLink['relationshipType'] = 'support_page';
  if (SECURITY_PATTERN.test(haystack)) {
    relationshipType = 'security_advisory';
  } else if (LIFECYCLE_PATTERN.test(haystack)) {
    relationshipType = 'policy_page';
  }

  return { score, relationshipType };
}

function normalizeForMatching(value: string): string {
  return value.replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Ranks links found on a fetched page. Only pages that mention a support topic
 * in their URL or anchor text survive; navigation, social, commerce and legal
 * links are dropped before ranking.
 */
export function discoverLinks(
  links: DiscoveredLink[],
  options: { pageUrl: string; manufacturerHostname: string },
): DiscoveryResult {
  const page = new URL(options.pageUrl);
  const manufacturerHostname = options.manufacturerHostname.toLowerCase();
  const ranked: RankedLink[] = [];

  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.url);
    } catch {
      continue;
    }

    if (!url.hostname) continue;
    if (url.href === page.href) continue;
    if (isIrrelevantUrl(url)) continue;

    const haystack = normalizeForMatching(`${url.pathname} ${url.search} ${link.anchorText}`);
    const classification = classify(haystack);
    if (!classification) continue;

    ranked.push({
      url: url.href,
      anchorText: link.anchorText.slice(0, 300),
      score: classification.score,
      relationshipType: classification.relationshipType,
    });
  }

  // Deduplicate by URL, keeping the highest-scoring occurrence.
  const byUrl = new Map<string, RankedLink>();
  for (const link of ranked) {
    const existing = byUrl.get(link.url);
    if (!existing || existing.score < link.score) byUrl.set(link.url, link);
  }

  const unique = [...byUrl.values()].sort(
    (left, right) => right.score - left.score || left.url.length - right.url.length,
  );

  return {
    relevant: unique.filter((link) => new URL(link.url).hostname.toLowerCase() === manufacturerHostname),
    external: unique.filter((link) => new URL(link.url).hostname.toLowerCase() !== manufacturerHostname),
    totalLinks: links.length,
  };
}
