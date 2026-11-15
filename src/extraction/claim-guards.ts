import type { ClaimType } from '../db/schema.js';

/**
 * Semantic guards applied after quotation verification. These catch the
 * specific failure modes called out in the extraction rules: launch dates,
 * latest-patch dates, warranties, marketing language, and OS claims that do
 * not actually name an operating-system version.
 */

export interface ClaimGuardRejection {
  code: string;
  message: string;
}

const SUPPORT_TERMINOLOGY =
  /\b(security|updates?|patches?|patch(?:es)?|firmware|software|support(?:ed)?|end[- ]of[- ](?:life|support)|lifecycle|maintenance)\b/i;

const WARRANTY_TERMINOLOGY =
  /\b(warrant(?:y|ies)|guarantee[ds]?|garantie|gew[aä]hrleistung)\b/i;

// Deliberately narrower than SUPPORT_TERMINOLOGY: "software warranty" is still
// a warranty, so generic software/product language must not override the guard.
const WARRANTY_OVERRIDE_TERMINOLOGY =
  /\b(security|support(?:ed)?|updates?|patches?|firmware|lifecycle)\b/i;

const END_TERMINOLOGY =
  /\b(until|through|thru|end[- ]of[- ](?:security[- ])?(?:life|support)|support ends?|will end|end(?:s|ing)?\b|ends? (?:on|in|at)|expires?|expiry|expiration|no longer (?:supported|receiv\w*)|will (?:not|no longer) (?:be )?(?:supported|receiv\w*)|cease[sd]?|stop(?:s|ped)? receiving)\b/i;

const LATEST_PATCH_TERMINOLOGY =
  /\b(latest|most recent|newest|current)\b[^.]{0,60}\b(?:security\s+)?(?:patch|update|advisory|release)\b|\b(?:security\s+)?(?:patch|update|advisory)\b[^.]{0,60}\b(?:released|published|issued|available)\b/i;

const LAUNCH_TERMINOLOGY =
  /\b(launch(?:ed|es|ing)?|release date|released on|available since|on sale|first available|hit the market)\b/i;

const OS_VERSION_TERMINOLOGY =
  /\b(?:android|ios|ipados|macos|mac os|windows|linux|chromeos|chrome os|wearos|wear os|fire os|harmonyos|tizen|kaios|ubuntu)\s*(?:os\s*)?\d+(?:\.\d+)*\b/i;

const POLICY_TERMINOLOGY =
  /\b(polic(?:y|ies)|commit(?:s|ted|ment)?|minimum|at least|at minimum|provided for|support(?:ed)? for|updates? for|for (?:a )?(?:minimum of )?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) (?:years?|months?)|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) (?:years?|months?) of (?:security )?(?:updates?|support))\b/i;

/**
 * Returns a rejection when a claim is semantically unsupported, or null when
 * it passes the guards. Quotation matching is performed separately.
 */
export function validateClaimSemantics(
  claimType: ClaimType,
  quotation: string,
  dateText: string | null,
): ClaimGuardRejection | null {
  const hasSupportTerms = SUPPORT_TERMINOLOGY.test(quotation);
  const hasWarrantyTerms = WARRANTY_TERMINOLOGY.test(quotation);
  const hasWarrantyOverride = WARRANTY_OVERRIDE_TERMINOLOGY.test(quotation);

  // A warranty is not a security-support commitment. Only reject when the
  // passage has no security/support language at all, so a page that mentions
  // both is still allowed to contribute its support statement.
  if (hasWarrantyTerms && !hasWarrantyOverride) {
    return {
      code: 'warranty_not_support_commitment',
      message: 'The quoted passage describes a warranty, not security support',
    };
  }

  if (claimType === 'os_version') {
    if (!OS_VERSION_TERMINOLOGY.test(quotation)) {
      return {
        code: 'os_version_not_stated',
        message: 'The quotation does not name an operating-system version',
      };
    }
    return null;
  }

  // Check the specifically prohibited support-end substitutions before the
  // general commitment-language guard, so the rejection reason is precise.
  if (claimType === 'support_end') {
    if (LATEST_PATCH_TERMINOLOGY.test(quotation) && !END_TERMINOLOGY.test(quotation)) {
      return {
        code: 'latest_patch_date_not_support_end',
        message: 'The quotation reports a recent patch or advisory, not an end-of-support date',
      };
    }

    if (LAUNCH_TERMINOLOGY.test(quotation) && !END_TERMINOLOGY.test(quotation)) {
      return {
        code: 'launch_date_not_support_end',
        message: 'The quotation names a launch or release date, not an end-of-support date',
      };
    }
  }

  if (!hasSupportTerms) {
    return {
      code: 'not_support_commitment',
      message: 'The quotation contains no security or support commitment language',
    };
  }

  if (claimType === 'support_start') {
    if (!dateText) {
      return {
        code: 'support_start_without_date',
        message: 'A support-start claim must state the date support begins',
      };
    }
    return null;
  }

  if (claimType === 'support_end') {
    if (!dateText) {
      return {
        code: 'support_end_without_date',
        message: 'A support-end claim must state the end date explicitly',
      };
    }

    if (!END_TERMINOLOGY.test(quotation)) {
      return {
        code: 'not_support_end_commitment',
        message: 'The quotation does not state that support ends or expires',
      };
    }

    return null;
  }

  if (claimType === 'policy') {
    if (!POLICY_TERMINOLOGY.test(quotation)) {
      return {
        code: 'not_support_policy',
        message: 'The quotation does not describe a support policy or duration',
      };
    }
    return null;
  }

  return null;
}

/**
 * Compares a source hostname with the manufacturer's registered website.
 * Subdomains of the manufacturer host are accepted; unrelated hosts (for
 * example a retailer) are not.
 */
export function isManufacturerDomain(sourceDomain: string, website: string | null): boolean {
  if (!website) {
    // Without a registered website there is no basis for a third-party check.
    return true;
  }

  let websiteHost: string;
  try {
    websiteHost = new URL(website).hostname.toLowerCase();
  } catch {
    return true;
  }

  const normalize = (host: string): string => host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const source = normalize(sourceDomain);
  const manufacturer = normalize(websiteHost);

  return source === manufacturer || source.endsWith(`.${manufacturer}`);
}
