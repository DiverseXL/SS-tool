/**
 * Shared vocabulary for support-page discovery. Kept in one place so link
 * classification and heading filtering cannot drift apart.
 */
export const SECURITY_PATTERN =
  /\b(security|advisory|advisories|vulnerabilit(y|ies)|cve|psirt|security[- ]bulletin|threat)\b/i;

export const LIFECYCLE_PATTERN =
  /\b(end[- ]of[- ](life|support)|eol|eos|life[- ]?cycle|support[- ](policy|duration)|update[- ]policy|vulnerability[- ]disclosure|disclosure[- ]policy|policy)\b/i;

export const UPDATE_PATTERN = /\b(firmware|software|driver|drivers|download|downloads|update|updates)\b/i;

export const SUPPORT_PATTERN =
  /\b(support|documentation|manual|manuals|help|faq|knowledge[- ]?base|product[- ]support)\b/i;

/** Navigation, commerce and legal pages that are never support evidence. */
export const IRRELEVANT_PATTERN =
  /\b(login|log[- ]?in|sign[- ]?in|sign[- ]?up|register|logout|account|cart|basket|checkout|wishlist|privacy|cookies?|terms|legal|imprint|careers?|jobs?|contact|investors?|press|newsroom|social|facebook|twitter|linkedin|youtube|instagram|pinterest|tiktok|subscribe|newsletter|store|shop|buy)\b/i;

export const RELEVANT_HEADING_PATTERN = new RegExp(
  [SECURITY_PATTERN.source, LIFECYCLE_PATTERN.source, UPDATE_PATTERN.source, SUPPORT_PATTERN.source].join(
    '|',
  ),
  'i',
);

const IRRELEVANT_EXTENSIONS =
  /\.(pdf|zip|rar|7z|tar|gz|png|jpe?g|gif|svg|webp|ico|css|js|mjs|xml|json|rss|atom|mp4|mp3|wav|avi|exe|dmg|msi|apk|iso)(?:$|\?)/i;

export function isIrrelevantUrl(url: URL): boolean {
  if (IRRELEVANT_EXTENSIONS.test(url.pathname)) return true;
  const haystack = `${url.pathname} ${url.search}`.replace(/[-_/]+/g, ' ');
  return IRRELEVANT_PATTERN.test(haystack);
}
