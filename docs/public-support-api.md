# SS Tool — Public Support Card & Lookup API Documentation

## Overview

The Public Support API delivers consumer-friendly, reviewed manufacturer security-support information for electronics products tracked in SS Tool. It translates reviewed evidence into a standardized public data contract consumable by public web pages, retailers, and embeddable widgets.

This endpoint is strictly read-only, deterministic, cached, and isolated from AI evaluation pipelines and web scraping.

---

## Public Endpoints

### 1. Get Public Support Card
`GET /api/v1/public/products/:id/support-card`

Retrieves the consumer-facing security support information and metadata for a specific product.

#### Path Parameters
- `id` (UUID, required): The internal unique identifier of the product.

#### Response Headers
- `Cache-Control: public, max-age=60, stale-while-revalidate=30`

#### Example Response (Illustrative: Information Available)
```json
{
  "data": {
    "product": {
      "id": "e7b0c360-6b6c-48c5-9c8e-32b0e77d33d9",
      "name": "Smart Hub Max 2",
      "manufacturer": {
        "id": "902dcb1e-7b7f-4c54-8c01-7fa918b965c4",
        "name": "Apex Electronics Corp",
        "website": "https://apex.example.com",
        "countryCode": "US"
      },
      "modelIdentifier": "SHM-200",
      "gtin": "00123456789012",
      "category": "Smart Home",
      "productUrl": "https://apex.example.com/products/shm-200"
    },
    "supportInformation": {
      "status": "INFORMATION_AVAILABLE",
      "summaryStatement": "Manufacturer-stated security-update support until December 31, 2030. Supporting statement reviewed by SS Tool.",
      "disclaimer": "This support card reflects manufacturer-published statements reviewed by SS Tool. It does not certify security, guarantee update delivery, or verify compliance.",
      "supportStart": {
        "value": "2023-01-15",
        "displayValue": "January 15, 2023",
        "precision": "day"
      },
      "supportEnd": {
        "value": "2030-12-31",
        "displayValue": "December 31, 2030",
        "precision": "day"
      },
      "operatingSystems": [
        "FreeRTOS 10.4"
      ],
      "policyStatements": [
        "Security patches are issued within 30 days of vulnerability discovery."
      ],
      "claims": [
        {
          "id": "23fae120-cf68-4560-aef2-bc32fa908754",
          "claimType": "support_end",
          "statement": "Guaranteed security updates until December 31, 2030.",
          "quotation": "Device security updates are guaranteed until December 31, 2030.",
          "dateText": "December 31, 2030",
          "datePrecision": "day",
          "normalizedDate": "2030-12-31",
          "source": {
            "url": "https://apex.example.com/support/lifecycle",
            "domain": "apex.example.com",
            "title": "Apex Product Security Lifecycle",
            "lastRetrieved": "2026-11-13T20:00:00.000Z"
          },
          "reviewStatus": "accepted"
        }
      ],
      "sources": [
        {
          "url": "https://apex.example.com/support/lifecycle",
          "domain": "apex.example.com",
          "title": "Apex Product Security Lifecycle",
          "lastRetrieved": "2026-11-13T20:00:00.000Z"
        }
      ]
    },
    "lastUpdated": "2026-11-13T21:45:00.000Z"
  }
}
```

---

### 2. Public Product Lookup
`GET /api/v1/public/products/lookup`

Resolves a product and retrieves its public support card URL using standard product identifiers without performing fuzzy searches or full catalogue scans.

#### Query Parameters
Provide at least one valid lookup method:

1. **By GTIN:**
   - `gtin` (string): GTIN-8, GTIN-12, GTIN-13, or GTIN-14 string with a valid check digit.
2. **By Manufacturer & Model:**
   - `manufacturer` or `manufacturerName` (string): Exact or normalized name of the manufacturer.
   - `modelIdentifier` or `model` (string): Exact or normalized model identifier.

#### Response Headers
- `Cache-Control: public, max-age=60, stale-while-revalidate=30`

#### Example Request
`GET /api/v1/public/products/lookup?gtin=00123456789012`

#### Example Response (Illustrative)
```json
{
  "data": {
    "product": {
      "id": "e7b0c360-6b6c-48c5-9c8e-32b0e77d33d9",
      "name": "Smart Hub Max 2",
      "manufacturer": {
        "id": "902dcb1e-7b7f-4c54-8c01-7fa918b965c4",
        "name": "Apex Electronics Corp",
        "website": "https://apex.example.com",
        "countryCode": "US"
      },
      "modelIdentifier": "SHM-200",
      "gtin": "00123456789012",
      "category": "Smart Home",
      "productUrl": "https://apex.example.com/products/shm-200"
    },
    "supportCardUrl": "/api/v1/public/products/e7b0c360-6b6c-48c5-9c8e-32b0e77d33d9/support-card"
  }
}
```

---

## Information Status Definitions

The `supportInformation.status` property classifies the availability and consistency of manufacturer commitments:

| Status | Meaning | Publication Action |
| :--- | :--- | :--- |
| `INFORMATION_AVAILABLE` | At least one valid manufacturer claim has been accepted by human review, and no contradictory commitments exist. | Published dates, policies, and supporting quotations are exposed. |
| `CONFLICTING_INFORMATION` | Contradictory support commitments have been identified across manufacturer sources (e.g., disjoint dates). | Neither date is arbitrarily selected. `supportEnd` is set to `null` to avoid misleading consumers. Contradiction is stated transparently. |
| `INSUFFICIENT_INFORMATION` | No accepted evidence exists for the product (e.g. only pending extraction, rejected evidence, or no discovered sources). | Support dates and claims remain `null` or empty. Consumer is informed that insufficient reviewed data is available. |

---

## Publication Rules

1. **Accepted Evidence Only**: Only evidence that has undergone deterministic assessment and explicit human review (`reviewStatus: 'accepted'`) is published as a manufacturer commitment.
2. **Pending Evidence Protection**: Evidence pending review is strictly excluded from public claims and cannot be presented as an accepted date.
3. **Rejected Evidence Protection**: Rejected evidence is never presented as a positive commitment.
4. **Deterministic Conflict Handling**: Reuses the core deterministic conflict detector. If contradictory support commitments exist (even if one is pending review against an accepted claim), `status` transitions to `CONFLICTING_INFORMATION`.
5. **No Arbitrary Date Selection**: If multiple contradictory dates exist, the system never guesses, averages, or arbitrarily selects one date. `supportEnd` is set to `null`.
6. **Corroborating Sources**: Multiple accepted sources stating the same commitment are aggregated and presented as corroborating sources.
7. **Date Precision Preservation**: Day, month, and year precisions are preserved verbatim. Month-only (e.g. "December 2030") and year-only (e.g. "2030") commitments are not converted into invented day dates (their `value` remains `null`, while `displayValue` retains the manufacturer statement).
8. **No Manufactured Dates**: Dates are never calculated or derived from warranty durations or product launch dates.
9. **Traceability**: Every published claim includes verbatim manufacturer quotations linking back to original manufacturer source URLs and retrieval dates.
10. **Responsible Language**: Prohibits claims of "Certified Secure", "Guaranteed Protection", "Independently Certified", or "CRA Compliant". An accepted statement represents a reviewed manufacturer claim, not independent proof of operational security.

---

## Privacy Boundaries & Data Exposure Guarantees

The public endpoints maintain strict confidentiality boundaries between internal curation systems and public consumers:

- **No Reviewer Notes**: Internal human reviewer notes and audit logs are never exposed in public responses.
- **No AI Provider Data**: Model names, provider names, prompt tokens, completion details, and raw AI outputs are omitted.
- **No Internal Metadata**: Internal database fields such as `claimFingerprint`, internal error states, or raw scraped HTML/content are excluded.
- **Safe Source Info Only**: Sources are represented by public URL, domain, title, and timestamp only.

---

## Error Responses

| Status Code | Error Code | Description |
| :--- | :--- | :--- |
| `400 Bad Request` | `VALIDATION_ERROR` | Invalid UUID format in path parameters. |
| `400 Bad Request` | `MISSING_LOOKUP_PARAMETERS` | Neither `gtin` nor (`manufacturer` + `modelIdentifier`) was supplied. |
| `400 Bad Request` | `INVALID_LOOKUP_PARAMETERS` | Partial manufacturer or model query without both required parameters. |
| `400 Bad Request` | `INVALID_GTIN` | Malformed GTIN string or invalid GS1 check digit. |
| `404 Not Found` | `PRODUCT_NOT_FOUND` | Product UUID or lookup parameters did not match any stored product. |
| `409 Conflict` | `AMBIGUOUS_PRODUCT_MATCH` | Multiple products matched the lookup criteria (e.g., duplicated GTINs). |

