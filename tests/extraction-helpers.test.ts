import { describe, expect, it } from 'vitest';
import { createClaimFingerprint } from '../src/extraction/claim-fingerprint.js';
import { isManufacturerDomain, validateClaimSemantics } from '../src/extraction/claim-guards.js';
import {
  analyzeDateText,
  dateTextSupportedByQuotation,
  parseDateText,
} from '../src/extraction/date-normalizer.js';
import { validateQuotation } from '../src/extraction/quotation-validator.js';

describe('date precision', () => {
  it('keeps day precision and normalizes a full date', () => {
    expect(analyzeDateText('15 December 2030')).toEqual({
      dateText: '15 December 2030',
      precision: 'day',
      normalizedDate: '2030-12-15',
    });
    expect(analyzeDateText('15th December, 2030').normalizedDate).toBe('2030-12-15');
    expect(analyzeDateText('December 15, 2030').normalizedDate).toBe('2030-12-15');
    expect(analyzeDateText('2030-12-15').normalizedDate).toBe('2030-12-15');
  });

  it('never invents a day for month-only or year-only dates', () => {
    expect(analyzeDateText('December 2030')).toEqual({
      dateText: 'December 2030',
      precision: 'month',
      normalizedDate: null,
    });
    expect(analyzeDateText('Dec. 2030')).toMatchObject({
      precision: 'month',
      normalizedDate: null,
    });
    expect(analyzeDateText('2030')).toEqual({
      dateText: '2030',
      precision: 'year',
      normalizedDate: null,
    });
  });

  it('leaves invalid calendar dates unnormalized', () => {
    expect(parseDateText('31 February 2030')).toBeNull();
    expect(analyzeDateText('31 February 2030')).toMatchObject({
      precision: null,
      normalizedDate: null,
    });
  });

  it('handles a policy duration with no explicit date', () => {
    expect(analyzeDateText(null)).toEqual({
      dateText: null,
      precision: null,
      normalizedDate: null,
    });
  });

  it('requires the date wording to appear in the quotation at the same precision', () => {
    expect(dateTextSupportedByQuotation('December 2030', 'Updates until Dec. 2030.')).toBe(true);
    expect(
      dateTextSupportedByQuotation('15 December 2030', 'Updates until December 2030.'),
    ).toBe(false);
    expect(dateTextSupportedByQuotation('2030', 'Updates until 15 December 2030.')).toBe(false);
  });
});

describe('quotation validation', () => {
  it('matches text after Unicode and whitespace normalization', () => {
    const source = 'We support the product\u2019s security updates.\n\nContact us for details.';
    expect(
      validateQuotation("We support the product's security updates.", source),
    ).toMatchObject({ matched: true, method: 'exact' });
  });

  it('matches ordered ellipsis fragments', () => {
    const source =
      'Security updates are provided until December 2030. The policy applies worldwide.';
    expect(
      validateQuotation(
        'Security updates are provided until December 2030. ... The policy applies worldwide.',
        source,
      ),
    ).toMatchObject({ matched: true, method: 'ellipsis' });
  });

  it('rejects reordered or fabricated fragments', () => {
    const source = 'Security updates are provided until December 2030. The policy applies.';
    expect(
      validateQuotation('The policy applies. ... Security updates are provided until 2031.', source),
    ).toMatchObject({ matched: false });

    expect(validateQuotation('This sentence is not on the page at all.', source)).toMatchObject({
      matched: false,
      reason: 'quotation_not_found_in_source',
    });
  });
});

describe('claim guards', () => {
  it('distinguishes support commitments from warranties and marketing', () => {
    expect(
      validateClaimSemantics(
        'support_end',
        'Security updates will be provided until December 2030.',
        'December 2030',
      ),
    ).toBeNull();
    expect(
      validateClaimSemantics(
        'support_end',
        'This device includes a two-year warranty until December 2027.',
        'December 2027',
      )?.code,
    ).toBe('warranty_not_support_commitment');
    expect(
      validateClaimSemantics(
        'support_end',
        'The software warranty is valid until December 2027.',
        'December 2027',
      )?.code,
    ).toBe('warranty_not_support_commitment');
    expect(
      validateClaimSemantics('policy', 'Designed to last for years.', null)?.code,
    ).toBe('not_support_commitment');
  });

  it('rejects latest-patch and launch dates as support-end dates', () => {
    expect(
      validateClaimSemantics(
        'support_end',
        'The latest security patch was released on 3 March 2026.',
        '3 March 2026',
      )?.code,
    ).toBe('latest_patch_date_not_support_end');

    expect(
      validateClaimSemantics(
        'support_end',
        'The product launched on 1 January 2025.',
        '1 January 2025',
      )?.code,
    ).toBe('launch_date_not_support_end');
  });

  it('matches manufacturer domains and their subdomains only', () => {
    expect(isManufacturerDomain('acme.com', 'https://www.acme.com')).toBe(true);
    expect(isManufacturerDomain('support.acme.com', 'https://acme.com')).toBe(true);
    expect(isManufacturerDomain('retailer.example', 'https://acme.com')).toBe(false);
  });
});

describe('claim fingerprints', () => {
  const base = {
    productId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    claimType: 'support_end',
  };

  it('is stable across whitespace and date-format differences', () => {
    const first = createClaimFingerprint({
      ...base,
      quotation: 'Security updates until December 2030.',
      dateText: 'December 2030',
    });
    const second = createClaimFingerprint({
      ...base,
      quotation: 'Security  updates until December 2030.',
      dateText: 'Dec. 2030',
    });

    expect(first).toBe(second);
  });

  it('changes when the claim or date changes', () => {
    const first = createClaimFingerprint({
      ...base,
      quotation: 'Security updates until December 2030.',
      dateText: 'December 2030',
    });
    const changedDate = createClaimFingerprint({
      ...base,
      quotation: 'Security updates until December 2030.',
      dateText: 'December 2031',
    });
    const changedType = createClaimFingerprint({
      ...base,
      claimType: 'policy',
      quotation: 'Security updates until December 2030.',
      dateText: 'December 2030',
    });

    expect(changedDate).not.toBe(first);
    expect(changedType).not.toBe(first);
  });
});
