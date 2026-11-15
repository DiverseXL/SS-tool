# Catalogue Import Specification & Guide

This document describes the CSV catalogue ingestion endpoint and pipeline implemented in SS Tool.

---

## 1. Supported CSV Format

- **Character Encoding:** UTF-8 (with or without UTF-8 BOM `0xEF, 0xBB, 0xBF`).
- **CSV Quoting:** Standard RFC 4180 CSV quoting (quotes escaping with `""`, comma support inside quoted fields).
- **Header Normalization:** Headers are trimmed, lowercased, and converted by replacing spaces or hyphens with underscores (`_`). Unknown headers are ignored and returned in `ignoredColumns`.

### Canonical CSV Headers

```csv
manufacturer_name,manufacturer_website,manufacturer_country_code,product_name,model_identifier,gtin,sku,category,product_url,market_region
```

### Required Columns
- `manufacturer_name` — cannot be empty / whitespace-only.
- `product_name` — cannot be empty / whitespace-only.

### Optional Columns
- `manufacturer_website` — valid HTTP or HTTPS URL (treated as null when empty).
- `manufacturer_country_code` — two-letter ISO 3166-1 alpha-2 code (case-insensitive, normalized to uppercase, e.g. `US`, `DE`).
- `model_identifier` — trimmed string, case-insensitive duplicate matching within the manufacturer.
- `gtin` — GTIN-8, GTIN-12, GTIN-13, or GTIN-14 string (leading zeros preserved, validated with GS1 check digit algorithm).
- `sku` — trimmed string identifier.
- `category` — trimmed string.
- `product_url` — valid HTTP or HTTPS URL.
- `market_region` — trimmed string (e.g. `EMEA`, `APAC`, `NA`).

---

## 2. Upload Endpoint

- **Method:** `POST`
- **Path:** `/api/v1/catalogue/imports`
- **Content-Type:** `multipart/form-data`
- **Form Field Name:** `file`
- **File Size Limit:** 5 MB
- **Data Rows Limit:** Maximum 500 rows (excluding header)

### Example Request

```bash
curl -X POST http://localhost:3000/api/v1/catalogue/imports \
  -F "file=@catalogue.csv;type=text/csv"
```

---

## 3. Response Structure

The endpoint returns HTTP 200 when a structurally valid file has been parsed and processed (even if individual rows were rejected or marked as duplicates).

### Response Schema

```json
{
  "summary": {
    "totalRows": 4,
    "created": 2,
    "duplicates": 1,
    "failed": 1
  },
  "results": [
    {
      "row": 2,
      "status": "created",
      "productId": "6121ae9f-d58b-4397-bccb-7f6f41638686"
    },
    {
      "row": 3,
      "status": "created",
      "productId": "56a1e606-09fc-430d-84f8-dff9f88614f0"
    },
    {
      "row": 4,
      "status": "duplicate",
      "reason": "Product already exists (matched by manufacturer + model identifier \"STV-55-mwf74a60\")"
    },
    {
      "row": 5,
      "status": "rejected",
      "errors": [
        {
          "field": "gtin",
          "message": "GTIN must be 8, 12, 13, or 14 digits"
        },
        {
          "field": "gtin",
          "message": "Invalid GTIN check digit"
        }
      ]
    }
  ],
  "ignoredColumns": [
    "legacy_tag"
  ],
  "warnings": []
}
```

Row indexing references the 1-based original row number in the CSV file (header is Row 1, data starts at Row 2).

---

## 4. Validation Rules

- **Row Independence:** Each row is validated independently with Zod. A malformed row will not prevent valid rows from importing.
- **Header Rejection:** If required headers (`manufacturer_name` or `product_name`) are missing, or if the CSV is syntactically malformed, the request is rejected with HTTP 422 `MISSING_REQUIRED_HEADERS` or `INVALID_CSV`.
- **GTIN Format:** Enforces length of 8, 12, 13, or 14 digits, verifies check digit using GS1 modulo 10 algorithm with alternating 3/1 weights, and preserves leading zeros.
- **URLs:** Must be valid `http://` or `https://` URLs.
- **Country Code:** Must be a 2-letter alpha-2 format.

---

## 5. Manufacturer Resolution & Duplicate Handling

### Manufacturer Resolution
1. Normalize incoming manufacturer name using `normalizeName(name)` (trimming, NFKC normalisation, case-folding).
2. Look up existing manufacturer by `normalized_name`.
3. If not found, create new manufacturer record.
4. If found:
   - Fill in missing `website` or `country_code` if provided in the row.
   - Do NOT overwrite existing non-empty values.
   - Emit a non-blocking warning if conflicting non-empty metadata is provided.

### Product Duplicate Detection
Duplicate detection occurs within the resolved manufacturer in the following priority order:
1. **Manufacturer + Model Identifier:** Compared case-insensitively (`lower(model_identifier)`).
2. **Manufacturer + GTIN:** Checked when model identifier is not provided.

If a duplicate is found:
- Do not create another record.
- Do not silently overwrite existing record data.
- Return status `"duplicate"` with reason explanation.

---

## 6. Known Limitations

1. **Absence of Stable Identifiers:**
   When neither a `model_identifier` nor a `gtin` is provided in a row, reliable cross-import duplicate detection is not possible. The product will be created as a new record on each import.
2. **Synchronous Upload Limit:**
   Uploads are limited to 5 MB and 500 rows per request. Larger catalogues must be batched across multiple requests.
3. **No Automatic Research / Evidence Generation:**
   In accordance with Step 3 specifications, this ingestion pipeline strictly registers product catalogue records. It does not extract support dates, crawl websites, generate evidence claims, or mark products as verified.

---

## 7. Synthetic CSV Fixture

Located at `tests/fixtures/catalogue-valid.csv`:

```csv
manufacturer_name,manufacturer_website,manufacturer_country_code,product_name,model_identifier,gtin,sku,category,product_url,market_region
Acme Electronics,https://acme.example.com,US,Widget Pro 3000,WP-3000,00614141453245,WP3K-SKU,Consumer Electronics,https://acme.example.com/widget-pro-3000,EMEA
Acme Electronics,https://acme.example.com,US,Widget Lite 1000,WL-1000,,WL1K-SKU,Consumer Electronics,https://acme.example.com/widget-lite-1000,
"Beta, Corp.",https://beta.example.com,DE,"Gadget, Deluxe","GDX-""1""",09506000134376,GDLX-SKU,Gadgets,https://beta.example.com/gadget-deluxe,APAC
Gamma Tech,,JP,Sensor Node Alpha,SNA-100,,,,,
```

