/**
 * Trusted, server-side source data for the public live judge demonstration.
 *
 * The public endpoint never accepts URLs, source text or product records from a
 * client: it can only reference these fixed identifiers. The text below is
 * curated demonstration content and is never fetched or persisted by the demo.
 */
export interface DemoExtractionProduct {
  id: string;
  name: string;
  manufacturer: string;
  modelIdentifier: string;
  category: string;
  source: {
    url: string;
    title: string;
    contentText: string;
  };
}

export const DEMO_EXTRACTION_PRODUCTS: DemoExtractionProduct[] = [
  {
    id: 'demo-northline-halo-s1',
    name: 'Halo S1 Home Speaker',
    manufacturer: 'Northline Audio',
    modelIdentifier: 'NL-S1',
    category: 'Connected speaker',
    source: {
      url: 'https://support.northline.example/security/halo-s1',
      title: 'Northline Product Security Lifecycle Policy',
      contentText: `Northline Audio Security Lifecycle Commitment
Model: Halo S1 Home Speaker (NL-S1)
Published: 12 November 2026

Security Lifecycle Commitment:
Security updates for the Halo S1 will be provided until 31 December 2030.
Critical security vulnerabilities will be addressed via over-the-air firmware updates within 30 days of discovery.
Supported operating systems: Northline OS 3.0 and newer.
Standard limited hardware warranty covers manufacturing defects for 1 year from original purchase date.`,
    },
  },
  {
    id: 'demo-apex-hub-max',
    name: 'Apex Hub Max',
    manufacturer: 'Apex Electronics Corp',
    modelIdentifier: 'SHM-200',
    category: 'Smart Home Hub',
    source: {
      url: 'https://apex.example.com/support/lifecycle',
      title: 'Apex Product Security Lifecycle',
      contentText: `Apex Electronics Corp — Security Update Policy
Product Family: Apex Hub Max (Model SHM-200)

Apex guarantees device security updates and vulnerability patches for the Hub Max until December 31, 2030.
Patches are issued quarterly or within 14 days for high-severity CVEs.
Compatible with FreeRTOS 10.4 and Linux Kernel 5.15 LTS.
Hardware warranty covers parts and labor for 12 months after purchase date.`,
    },
  },
];

export function findDemoExtractionProduct(id: string): DemoExtractionProduct | undefined {
  return DEMO_EXTRACTION_PRODUCTS.find((product) => product.id === id);
}
