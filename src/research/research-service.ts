import type { SourceRelationshipType } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { ProductSourceRepository } from '../repositories/product-source-repository.js';
import type { ProductRepository } from '../repositories/product-repository.js';
import type { SourceRepository } from '../repositories/source-repository.js';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  FetchError,
  type Fetcher,
} from './fetcher.js';
import { extractHtml, type ExtractedPage } from './html-extractor.js';
import { discoverLinks, type RankedLink } from './link-discovery.js';
import { loadRobotsPolicy } from './robots.js';
import { assertSafeUrl, UrlSafetyError } from './url-safety.js';

export const MAX_PAGES_PER_RESEARCH = 5;
export const MAX_DISCOVERY_DEPTH = 1;

export interface UrlValidator {
  (url: string): Promise<{ url: URL; hostname: string }>;
}

export interface ResearchOptions {
  products: ProductRepository;
  sources: SourceRepository;
  productSources: ProductSourceRepository;
  fetcher: Fetcher;
  /** Injectable in tests so no real DNS lookup is needed. */
  validateUrl?: UrlValidator;
  now?: () => Date;
}

export interface StoredSourceResult {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  httpStatus: number;
  contentHash: string;
  fetchedAt: string;
  relationshipType: SourceRelationshipType;
  unchanged: boolean;
}

export interface ResearchFailure {
  url: string;
  reason: string;
  statusCode?: number;
  message: string;
}

export interface ReviewItem {
  url: string;
  reason: 'limit_reached' | 'robots_disallowed' | 'unsafe_destination';
}

export interface ExternalCandidate {
  url: string;
  anchorText: string | null;
  sourceId: string | null;
  reason: 'external_domain';
}

export interface ResearchResult {
  productId: string;
  researchedAt: string;
  manufacturer: { id: string; name: string; website: string };
  pagesDiscovered: number;
  pagesFetched: number;
  pagesRequiringReview: ReviewItem[];
  externalCandidates: ExternalCandidate[];
  failures: ResearchFailure[];
  sources: StoredSourceResult[];
  storedSourceIds: string[];
  limits: {
    maxPages: number;
    maxDiscoveryDepth: number;
    maxBytes: number;
    timeoutMs: number;
  };
}

export interface ResearchService {
  research(productId: string): Promise<ResearchResult>;
}

const defaultValidateUrl: UrlValidator = async (url) => {
  const validated = await assertSafeUrl(url);
  return { url: validated.url, hostname: validated.hostname };
};

function describeFetchError(error: unknown): Omit<ResearchFailure, 'url'> {
  if (error instanceof FetchError) {
    switch (error.code) {
      case 'TIMEOUT':
        return { reason: 'timeout', message: error.message };
      case 'TOO_LARGE':
        return { reason: 'response_too_large', message: error.message, statusCode: error.statusCode };
      case 'UNSUPPORTED_CONTENT_TYPE':
        return {
          reason: 'unsupported_content_type',
          message: error.message,
          statusCode: error.statusCode,
        };
      case 'CROSS_HOST_REDIRECT':
        return { reason: 'cross_host_redirect', message: error.message, statusCode: error.statusCode };
      case 'TOO_MANY_REDIRECTS':
        return { reason: 'too_many_redirects', message: error.message, statusCode: error.statusCode };
      case 'INVALID_REDIRECT':
        return { reason: 'invalid_redirect', message: error.message, statusCode: error.statusCode };
      case 'NETWORK_ERROR':
        return { reason: 'network_error', message: error.message };
    }
  }

  if (error instanceof UrlSafetyError) {
    return { reason: 'blocked_destination', message: error.message };
  }

  return {
    reason: 'fetch_error',
    message: error instanceof Error ? error.message : 'Unknown fetch failure',
  };
}

function isSameHostname(left: string, right: string): boolean {
  return left.toLowerCase().replace(/\.$/, '') === right.toLowerCase().replace(/\.$/, '');
}

function domainOf(url: URL): string {
  return url.hostname.toLowerCase();
}

/**
 * Discovers and stores manufacturer sources for one product. Only pages on the
 * manufacturer's registered hostname are fetched. External candidates are
 * recorded but never requested.
 */
export function createResearchService(options: ResearchOptions): ResearchService {
  const { products, sources, productSources, fetcher } = options;
  const validateUrl = options.validateUrl ?? defaultValidateUrl;
  const now = options.now ?? (() => new Date());

  return {
    async research(productId) {
      const detail = await products.findDetailById(productId);
      if (!detail) {
        throw AppError.notFound('PRODUCT_NOT_FOUND', 'Product not found');
      }

      const { product, manufacturer } = detail;
      if (!manufacturer.website) {
        throw new AppError(
          422,
          'MANUFACTURER_WEBSITE_MISSING',
          'Manufacturer has no registered website, so research cannot start',
        );
      }

      let home: { url: URL; hostname: string };
      try {
        home = await validateUrl(manufacturer.website);
      } catch (error) {
        const reason = error instanceof UrlSafetyError ? error.code : 'INVALID_WEBSITE';
        throw new AppError(
          422,
          'UNSAFE_MANUFACTURER_WEBSITE',
          `Manufacturer website cannot be researched safely (${reason})`,
        );
      }

      const homepageUrl = new URL(home.url.href);
      homepageUrl.hash = '';
      const hostname = home.hostname.toLowerCase();
      const robots = await loadRobotsPolicy(homepageUrl, fetcher);

      const fetchedSources: StoredSourceResult[] = [];
      const failures: ResearchFailure[] = [];
      const review: ReviewItem[] = [];
      const externalCandidates: ExternalCandidate[] = [];
      const discovered = new Set<string>([homepageUrl.href]);
      let fetchedPageCount = 0;

      async function persistCandidate(link: RankedLink): Promise<ExternalCandidate> {
        let source = await sources.findByUrl(link.url);
        if (!source) {
          const candidateUrl = new URL(link.url);
          source = await sources.upsert({
            url: link.url,
            domain: domainOf(candidateUrl),
            title: null,
            description: null,
            contentType: null,
            contentText: null,
            httpStatus: null,
            contentHash: null,
            fetchedAt: null,
          });
        }

        await productSources.associate({
          productId,
          sourceId: source.id,
          relationshipType: 'discovered_candidate',
        });

        return {
          url: link.url,
          anchorText: link.anchorText || null,
          sourceId: source.id,
          reason: 'external_domain',
        };
      }

      async function fetchAndStore(
        url: string,
        relationshipType: SourceRelationshipType,
      ): Promise<ExtractedPage | null> {
        if (fetchedPageCount >= MAX_PAGES_PER_RESEARCH) {
          review.push({ url, reason: 'limit_reached' });
          return null;
        }

        const target = new URL(url);
        if (!robots.isAllowed(target)) {
          review.push({ url, reason: 'robots_disallowed' });
          return null;
        }

        let response;
        try {
          response = await fetcher.fetch(url);
        } catch (error) {
          failures.push({ url, ...describeFetchError(error) });
          return null;
        }

        if (response.status < 200 || response.status >= 300) {
          failures.push({
            url,
            reason: 'http_error',
            statusCode: response.status,
            message: `Page returned HTTP ${response.status}`,
          });
          return null;
        }

        const extracted = extractHtml(response.body, response.finalUrl);
        const existing = await sources.findByUrl(url);
        const unchanged = existing?.contentHash === extracted.contentHash;

        const stored = await sources.upsert({
          url,
          domain: domainOf(target),
          title: extracted.title,
          description: extracted.description,
          contentType: response.contentType,
          contentText: extracted.text,
          httpStatus: response.status,
          contentHash: extracted.contentHash,
          fetchedAt: response.fetchedAt,
        });

        await productSources.associate({ productId, sourceId: stored.id, relationshipType });
        fetchedPageCount += 1;

        fetchedSources.push({
          id: stored.id,
          url,
          domain: domainOf(target),
          title: extracted.title,
          description: extracted.description,
          canonicalUrl: extracted.canonicalUrl,
          httpStatus: response.status,
          contentHash: extracted.contentHash,
          fetchedAt: response.fetchedAt.toISOString(),
          relationshipType,
          unchanged,
        });

        return extracted;
      }

      const homepage = await fetchAndStore(homepageUrl.href, 'manufacturer_homepage');

      if (product.productUrl) {
        try {
          const validatedProductUrl = await validateUrl(product.productUrl);
          const productPageUrl = new URL(validatedProductUrl.url.href);
          productPageUrl.hash = '';

          if (!isSameHostname(validatedProductUrl.hostname, hostname)) {
            externalCandidates.push({
              url: productPageUrl.href,
              anchorText: null,
              sourceId: null,
              reason: 'external_domain',
            });
          } else if (productPageUrl.href !== homepageUrl.href) {
            discovered.add(productPageUrl.href);
            await fetchAndStore(productPageUrl.href, 'product_page');
          }
        } catch (error) {
          failures.push({
            url: product.productUrl,
            reason: 'blocked_destination',
            message:
              error instanceof UrlSafetyError
                ? error.message
                : 'Product URL is not a safe HTTP(S) destination',
          });
        }
      }

      if (homepage) {
        const discovery = discoverLinks(homepage.links, {
          pageUrl: homepageUrl.href,
          manufacturerHostname: hostname,
        });

        for (const link of [...discovery.relevant, ...discovery.external]) {
          discovered.add(link.url);
        }

        for (const link of discovery.relevant) {
          if (link.url === homepageUrl.href) continue;
          await fetchAndStore(link.url, link.relationshipType);
        }

        for (const link of discovery.external) {
          externalCandidates.push(await persistCandidate(link));
        }
      }

      return {
        productId,
        researchedAt: now().toISOString(),
        manufacturer: {
          id: manufacturer.id,
          name: manufacturer.name,
          website: manufacturer.website,
        },
        pagesDiscovered: discovered.size,
        pagesFetched: fetchedSources.length,
        pagesRequiringReview: review,
        externalCandidates,
        failures,
        sources: fetchedSources,
        storedSourceIds: fetchedSources.map((source) => source.id),
        limits: {
          maxPages: MAX_PAGES_PER_RESEARCH,
          maxDiscoveryDepth: MAX_DISCOVERY_DEPTH,
          maxBytes: DEFAULT_MAX_BYTES,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        },
      };
    },
  };
}

