import type { ClaimType, DatePrecision } from '../db/schema.js';

/**
 * Curated, genuine manufacturer records used by the public judge demo.
 *
 * The source text is a captured excerpt of Fairphone's published support
 * article, retrieved on 15 November 2026. Quotations stored below are copied
 * verbatim from that excerpt. Year-only commitments deliberately keep year
 * precision and never invent a calendar day.
 */
export const DEMO_DATASET_VERSION = 'fairphone-support-v1';

export const DEMO_MANUFACTURER = {
  id: 'a1111111-1111-4111-8111-111111111111',
  name: 'Fairphone',
  normalizedName: 'fairphone',
  website: 'https://www.fairphone.com',
  countryCode: 'NL',
} as const;

export const DEMO_SOURCE = {
  id: 'a3333333-3333-4333-8333-333333333301',
  url: 'https://support.fairphone.com/hc/en-us/articles/9979180437393-How-long-will-my-Fairphone-receive-software-and-security-updates',
  domain: 'support.fairphone.com',
  title: 'How long will my Fairphone receive software and security updates?',
  httpStatus: 200,
  fetchedAt: new Date('2026-11-15T09:00:00.000Z'),
  relationshipType: 'support_page',
} as const;

export const DEMO_SOURCE_CONTENT = `How long will my Fairphone receive software and security updates?
Every Fairphone smartphone comes with a specific Android version to keep your phone secure and running smoothly. This guide helps you find the current operating system version, future software upgrades, and support lifespans for your specific Fairphone model.

Software support for The Fairphone (Gen. 6)+
The Fairphone (Gen. 6+) launched with Android 16.
Future software timeline for The Fairphone (Gen. 6)
With a Snapdragon 7s Gen 3 chipset, the Fairphone guarantees smooth and reliable performance for many years. The phone is built to last, offering eight years of software support until 2033 and a five-year warranty.
This support timeline means Fairphone commits to going beyond the legal requirement to provide software support for more than five years after manufacturing ends.

Software support for Fairphone 5+
The Fairphone 5 launched with Android 13.
Future software timeline for Fairphone 5
Thanks to the unique Qualcomm® QCM6490 extended life chipset, Fairphone can provide software support for a longer time. For Fairphone 5, the planned support includes:
five Android version upgrades
At least eight years of security updates, with a goal to reach 10 years
Monthly security updates for about three years, switching to bi-monthly security updates from mid-2026 until software support ends

Software support for Fairphone 4+
The Fairphone 4 began shipping with Android 11.
Future software timeline for Fairphone 4
Fairphone aims to support Fairphone 4 with security updates and software upgrades for five years from the launch date in September 2021, with a goal to reach seven years. Fairphone guarantees software support until at least 2028.
Fairphone provided monthly security updates for about 2.5 years, and then switched to bi-monthly security updates in 2024. This bi-monthly schedule will continue until software support ends.`;

export const DEMO_SOURCE_CAPTURE_DATE = '2026-11-15';

export interface DemoClaimDefinition {
  id: string;
  claimType: ClaimType;
  rawText: string;
  quotedExcerpt: string;
  dateText: string | null;
  datePrecision: DatePrecision | null;
  normalizedDate: string | null;
  claimFingerprint: string;
}

export interface DemoProductDefinition {
  id: string;
  name: string;
  modelIdentifier: string | null;
  category: string;
  productUrl: string | null;
  marketRegion: string;
  displayOrder: number;
  summary: string;
  claims: DemoClaimDefinition[];
}

export const DEMO_PRODUCTS: DemoProductDefinition[] = [
  {
    id: 'a2222222-2222-4222-8222-222222222203',
    name: 'The Fairphone (Gen. 6)',
    modelIdentifier: null,
    category: 'Smartphone',
    productUrl: null,
    marketRegion: 'Europe',
    displayOrder: 1,
    summary: 'Fairphone states eight years of software support, through 2033.',
    claims: [
      {
        id: 'a4444444-4444-4444-8444-444444444403',
        claimType: 'support_end',
        rawText: 'Fairphone states eight years of software support, through 2033.',
        quotedExcerpt:
          'The phone is built to last, offering eight years of software support until 2033 and a five-year warranty.',
        dateText: '2033',
        datePrecision: 'year',
        normalizedDate: null,
        claimFingerprint: `${DEMO_DATASET_VERSION}:fairphone-gen-6:support-end`,
      },
    ],
  },
  {
    id: 'a2222222-2222-4222-8222-222222222202',
    name: 'Fairphone 5',
    modelIdentifier: 'FP5',
    category: 'Smartphone',
    productUrl: null,
    marketRegion: 'Europe',
    displayOrder: 2,
    summary: 'Fairphone plans at least eight years of security updates, with a goal of ten.',
    claims: [
      {
        id: 'a4444444-4444-4444-8444-444444444402',
        claimType: 'policy',
        rawText: 'Fairphone plans at least eight years of security updates, with a goal of ten years.',
        quotedExcerpt: 'At least eight years of security updates, with a goal to reach 10 years',
        dateText: null,
        datePrecision: null,
        normalizedDate: null,
        claimFingerprint: `${DEMO_DATASET_VERSION}:fairphone-5:policy`,
      },
    ],
  },
  {
    id: 'a2222222-2222-4222-8222-222222222201',
    name: 'Fairphone 4',
    modelIdentifier: 'FP4',
    category: 'Smartphone',
    productUrl: null,
    marketRegion: 'Europe',
    displayOrder: 3,
    summary: 'Fairphone guarantees software support until at least 2028.',
    claims: [
      {
        id: 'a4444444-4444-4444-8444-444444444401',
        claimType: 'support_end',
        rawText:
          'Fairphone aims to support Fairphone 4 with security updates and software upgrades for five years from launch, and guarantees software support until at least 2028.',
        quotedExcerpt:
          'Fairphone aims to support Fairphone 4 with security updates and software upgrades for five years from the launch date in September 2021, with a goal to reach seven years. Fairphone guarantees software support until at least 2028.',
        dateText: '2028',
        datePrecision: 'year',
        normalizedDate: null,
        claimFingerprint: `${DEMO_DATASET_VERSION}:fairphone-4:support-end`,
      },
    ],
  },
];

export const DEMO_PRODUCT_IDS = DEMO_PRODUCTS.map((product) => product.id);
