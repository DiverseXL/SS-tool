# SS Tool

**SS Tool helps electronics retailers discover, verify and communicate how long connected products receive manufacturer-published security updates.**

SS Tool is a Cloudflare Pages application: static HTML/CSS/JS in `dist/`, Pages
Functions in `functions/`, shared TypeScript handlers in `server/`, and
PostgreSQL through a Hyperdrive binding. It turns scattered manufacturer
support statements into traceable, human-reviewed support cards that a retailer
can show to a customer.

The Fastify app in `src/app.ts` remains available for local Node development and
the route/integration test suite. Both adapters use the same repositories,
services, Zod schemas and verification rules.

> This repository is the HackOnVibe team submission. The organizer-provided
> `.github/workflows/deploy.yml`, root `index.html` and `.wrangler/` files are
> kept unchanged. The organizer workflow strips `functions/`, so full Pages
> Functions deployment uses Cloudflare Git integration or Wrangler; see
> [Cloudflare Pages deployment](docs/cloudflare-pages.md).

## Contents

- [The problem](#the-problem)
- [How SS Tool works](#how-ss-tool-works)
- [Main capabilities](#main-capabilities)
- [Technology stack](#technology-stack)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Requirements](#requirements)
- [Installation and local setup](#installation-and-local-setup)
- [Dashboard setup](#dashboard-setup)
- [Environment variables](#environment-variables)
- [Database setup and migrations](#database-setup-and-migrations)
- [Running the application](#running-the-application)
- [Cloudflare Pages deployment](#cloudflare-pages-deployment)
- [Tests and checks](#tests-and-checks)
- [Public and authenticated API](#public-and-authenticated-api)
- [Manufacturer research](#manufacturer-research)
- [Evidence extraction](#evidence-extraction)
- [Verification and human review](#verification-and-human-review)
- [Catalogue import](#catalogue-import)
- [Public support API](#public-support-api)
- [Data model](#data-model)
- [Judge demo](#judge-demo)
- [Known limitations](#known-limitations)
- [Security notes](#security-notes)
- [HackOnVibe repository notes](#hackonvibe-repository-notes)
- [Documentation](#documentation)
- [Design credit](#design-credit)

## The problem

A connected product can stop receiving security updates long before it stops
working. The commitment is usually buried in a manufacturer support page,
security advisory or lifecycle policy, and different pages sometimes state
different dates or levels of precision.

Retailers are asked "how long will this be supported?" but have no reliable,
traceable answer. A marketing page is not evidence, an AI summary is not a
review, and a single scraped date is not a commitment.

SS Tool addresses that gap by keeping the original manufacturer quotation,
source URL and retrieval time next to every claim, and by requiring an explicit
human review before anything is published.

## How SS Tool works

1. **Catalogue the product.** Retailers add manufacturers and products, or
   import a CSV catalogue.
2. **Discover manufacturer sources.** A safe fetcher visits the manufacturer's
   registered website, follows a small number of same-host links and stores the
   extracted page text. External support links are recorded as unvisited
   candidates, never fetched automatically.
3. **Extract structured claims.** A configured OpenAI-compatible model reads
   the stored text and proposes claims such as `support_end`, `support_start`,
   `os_version` and `policy`. Every claim must include a verbatim quotation.
4. **Verify deterministically.** The application checks that the quotation
   exists in the stored source text, that any date appears in the quotation,
   that the claim is an actual support commitment, and that the source belongs
   to the manufacturer and the product.
5. **Review with a human.** Claims are stored as `pending`. A reviewer accepts
   or rejects each claim with a required note. Every decision is written to an
   append-only audit table.
6. **Publish a support card.** The public API publishes only accepted evidence,
   preserves the manufacturer's date precision and withholds dates when
   accepted evidence conflicts.

## Main capabilities

- Manufacturer and product catalogue with normalization, GTIN validation and
  duplicate protection.
- CSV catalogue import with per-row results, validation errors and duplicate
  detection (5 MB / 500 rows per request).
- Safe manufacturer research with SSRF protection, DNS pinning, redirect
  revalidation, `robots.txt` handling, page and byte limits.
- AI-assisted evidence extraction with strict schema validation and quotation
  verification; extraction never auto-accepts a claim.
- Evidence review queue with source, quotation, date and conflict inspection.
- Deterministic verification: source integrity, quotation integrity, claim
  semantics, date precision and conflict detection.
- Public product lookup and support-card API with cache headers and a stable,
  reviewed-only data contract.
- Password-protected retailer dashboard with overview, catalogue, import,
  research and evidence-review pages.
- Structured JSON logs, centralized error handling, health/readiness probes and
  graceful shutdown.

## Technology stack

| Layer | Choice |
| --- | --- |
| Production runtime | Cloudflare Pages + Pages Functions (Workers, `nodejs_compat`) |
| Local Node runtime | Node.js 22+ (developed on Node 26), Fastify 5 |
| Language | TypeScript (strict, NodeNext modules) |
| Database | PostgreSQL 16 through Cloudflare Hyperdrive in production |
| ORM / migrations | Drizzle ORM and drizzle-kit |
| Validation | Zod 4 |
| AI provider | OpenServ SERV Reasoning or any OpenAI-compatible `/chat/completions` endpoint |
| Frontend | Plain HTML, CSS and JavaScript built into `dist/` (no bundler) |
| Tests | Vitest 5 |
| Local database | Docker Compose |
| Auth | Single administrator, database-backed signed `HttpOnly` session cookie |
| Logging | Structured JSON with secrets and sensitive headers excluded |

## Architecture

```
Browser
  |
  |  /, /login, /dashboard/*
  v
Cloudflare Pages
  |-- dist/                 static HTML, CSS, JS and hero asset
  |-- functions/            thin Pages Functions entrypoints
  |     _middleware.ts      page auth, login redirects, no-store headers
  |     healthz.ts          liveness
  |     readyz.ts           PostgreSQL readiness
  |     api/v1/[[path]].ts  /api/v1 dispatcher
  v
server/api/handler.ts      shared API router, validation and error handling
  |-- server/pages/        per-request DB, auth, middleware and edge fetcher
  |-- routes/              Fastify route registration (local/test parity)
  |-- services/            business rules and duplicate checks
  |-- verification/        integrity checks, conflict detection and review audit
  |-- research/            URL safety, robots, discovery and HTML extraction
  |-- extraction/          provider adapter, prompt, schema, date and quote guards
  |-- repositories/        Drizzle queries; routes do not contain SQL
  |-- db/                  postgres.js client, schema and connectivity probe
  v
PostgreSQL 16  <-- Hyperdrive in production, Docker volume locally
```

Design decisions worth knowing:

- `src/app.ts` builds the Fastify app without starting a listener, so tests use
  `inject()` against the real route stack; the Pages adapter calls the same
  services directly.
- Each Pages request creates and closes its own PostgreSQL client because
  Workers forbid reusing I/O objects across requests. Hyperdrive handles
  connection pooling in production.
- Admin sessions and login-attempt counters live in PostgreSQL, so every isolate
  sees the same session and logout state.
- Research and AI dependencies are injectable. Tests use a mock HTTP layer and a
  deterministic fake provider, so the suite does not call the internet or a
  paid model.
- The public API is read-only and does not expose reviewer notes, AI provider
  details, prompts, raw HTML or internal fingerprints.
- The frontend has no bundler. `scripts/build-pages.mjs` copies `public/` into
  `dist/` and creates directory routes for the dashboard pages.

## Repository layout

```
src/
  app.ts                  Fastify app factory (local Node and tests)
  server.ts               Environment loading, listener and graceful shutdown
  config/env.ts           Zod-validated environment
server/
  api/handler.ts          Shared /api/v1 router for Pages Functions
  pages/                  Pages auth, middleware, health, context, edge fetcher
functions/                Root Cloudflare Pages Functions entrypoints
dist/                     Generated static Pages build (not committed)
wrangler.toml             Pages project and Hyperdrive binding template
  auth/                   Single-admin credential check, sessions and guard
  routes/                 Auth, dashboard, research, review, catalogue,
                          evidence, public, manufacturers, products, health
  services/               Manufacturer and product business rules
  repositories/           Database access, aggregates and source/evidence rows
  research/               Safe fetcher, URL safety, robots, HTML extraction,
                          discovery and research workbench service
  extraction/             OpenAI-compatible provider, prompt, schema, date
                          normalizer, quotation validator, guards and service
  verification/           Evidence assessment, conflict detection, review queue
  public/                 Public support-card and lookup service
  db/                     postgres.js + Drizzle client and schema
  lib/                    Errors, normalization, GTIN, pagination
  schemas/                Zod request schemas
  plugins/error-handler.ts Centralized JSON error and 404 handling
public/                   Landing page, dashboard, login, CSS, JS and hero asset
drizzle/                  Generated SQL migrations and snapshots
tests/                    Vitest route, integration and safety tests
docs/                     Pages deployment, catalogue import and public API docs
.agents/                  Project-local design skill (not required at runtime)
```

## Requirements

- Node.js 22 or newer (npm 11+ recommended)
- Docker Desktop for PostgreSQL 16, or any reachable PostgreSQL 16 instance
- Optional: an OpenAI-compatible AI endpoint and API key for evidence extraction

## Installation and local setup

```bash
# 1. Install dependencies
npm install

# 2. Create your local environment file (never commit .env)
cp .env.example .env

# 3. Start PostgreSQL 16 and wait until it is healthy
docker compose up -d
docker compose ps

# 4. Apply the migrations
npm run db:migrate

# 5. Build static Pages assets and start the Pages runtime
npm run build
npm run dev:pages

# Optional: run the Fastify server instead
# npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.
For Pages development, copy `.dev.vars.example` to `.dev.vars` as described in
[Cloudflare Pages deployment](docs/cloudflare-pages.md).

Verify the Pages runtime and database:

```bash
curl -i http://localhost:8788/healthz
curl -i http://localhost:8788/readyz
```

`/healthz` returns `200` while the process or Pages Function is alive. `/readyz`
returns `200` when PostgreSQL answers a `select 1` probe (3s timeout) and `503`
otherwise. With `npm run dev`, the default address is `http://localhost:3000`.

> If `localhost:5432` is already in use, change `POSTGRES_PORT` in `.env` and
> use the same port in `DATABASE_URL`.

## Dashboard setup

Add the administrator credentials and a signing secret to `.env`:

```bash
ADMIN_EMAIL=operator@example.com
ADMIN_PASSWORD=replace-with-a-strong-password   # at least 12 characters
SESSION_SECRET=replace-with-at-least-32-random-characters
SESSION_TTL_HOURS=8                              # optional, 1-168
```

Generate the secret with `openssl rand -base64 48` (or an equivalent password
manager). These values are optional at boot so the public site continues to
work before the dashboard is configured, but `POST /api/v1/auth/login` then
returns `503 AUTH_NOT_CONFIGURED` rather than accepting a default credential.

Open `http://localhost:8788/login` (Pages) or `http://localhost:3000/login`
(Fastify), sign in, and the overview is served at `/dashboard`. The single
administrator account is shared for this deployment. Sessions are stored in
PostgreSQL, expire after `SESSION_TTL_HOURS`, are invalidated on logout, and
are visible to every isolate. Login attempts are also stored in PostgreSQL and
limited to 5 per IP per 15 minutes.

> Never commit `.env` or `.dev.vars`, and do not use the example values above in
> a deployment.

## Environment variables

All configuration is supplied through environment variables and validated at
startup by `src/config/env.ts`. Invalid values fail fast with a message that
names the variable but never prints its value. See `.env.example` for the
complete template.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | No | `development`, `test` or `production` (default `development`) |
| `HOST` | No | Listen address (default `0.0.0.0`) |
| `PORT` | No | Listen port (default `3000`) |
| `LOG_LEVEL` | No | pino level (default `info`) |
| `DATABASE_URL` | Yes | PostgreSQL connection string, for example `postgresql://USER:PASSWORD@localhost:5432/ss_tool` |
| `POSTGRES_USER` | Compose only | Local database user |
| `POSTGRES_PASSWORD` | Compose only | Local database password |
| `POSTGRES_DB` | Compose only | Local database name |
| `POSTGRES_PORT` | Compose only | Host port mapped to PostgreSQL |
| `ADMIN_EMAIL` | Dashboard | Administrator email |
| `ADMIN_PASSWORD` | Dashboard | Administrator password, at least 12 characters |
| `SESSION_SECRET` | Dashboard | Cookie signing secret, at least 32 characters |
| `SESSION_TTL_HOURS` | No | Session lifetime, 1-168 (default `8`) |
| `SERV_API_KEY` | AI extraction | OpenServ SERV Reasoning API key; server-side only |
| `SERV_MODEL` | No | SERV model (default `gpt-5.4-mini`) |
| `SERV_BASE_URL` | No | SERV base URL (default `https://inference-api.openserv.ai/v1`) |
| `SERV_TIMEOUT_MS` | No | SERV timeout, 100-120000 ms (falls back to `AI_TIMEOUT_MS`) |
| `SERV_MAX_INPUT_TOKENS` | No | SERV input budget (falls back to `AI_MAX_INPUT_TOKENS`) |
| `SERV_MAX_OUTPUT_TOKENS` | No | SERV output budget (falls back to `AI_MAX_OUTPUT_TOKENS`) |
| `AI_BASE_URL` | AI extraction | OpenAI-compatible base URL |
| `AI_API_KEY` | AI extraction | Provider API key; never commit a real value |
| `AI_MODEL` | AI extraction | Model identifier |
| `AI_TIMEOUT_MS` | No | Provider timeout, 100-120000 ms (default `30000`) |
| `AI_MAX_INPUT_TOKENS` | No | Input budget (default `8000`) |
| `AI_MAX_OUTPUT_TOKENS` | No | Output budget (default `1500`) |

AI extraction is enabled by either:

- `SERV_API_KEY` (preferred), optionally with `SERV_MODEL` and `SERV_BASE_URL`.
  This selects the OpenServ SERV Reasoning provider; or
- all three of `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` for any other
  OpenAI-compatible endpoint.

When both are present, the `SERV_*` variables win. Without any complete
configuration, catalogue, product, research and review endpoints still work;
`POST /api/v1/products/:id/extract-evidence` returns `503 AI_NOT_CONFIGURED`.
Provider failures never create evidence, and there is no silent fallback from
SERV to another provider.

`.env.example` contains local Docker development credentials. They are not
production values, and they must not be reused for a shared or deployed
database.

## Database setup and migrations

Migrations live in `drizzle/` and are applied with:

```bash
npm run db:migrate
```

After changing `src/db/schema.ts`, generate a new migration and apply it:

```bash
npm run db:generate
npm run db:migrate
```

The migrations `0000_*.sql` through `0004_*.sql` create eight tables:
`manufacturers`, `products`, `sources`, `product_sources`, `evidence`,
`evidence_reviews`, `admin_sessions` and `login_attempts`. See
[Data model](#data-model) for their relationships. `0004` adds the persistent
session and login-attempt tables; it does not delete existing rows.

PostgreSQL data lives in the named Docker volume `ss_tool_pgdata`.
`docker compose down` keeps it; `docker compose down -v` deletes it.

## Running the application

### Cloudflare Pages runtime

```bash
npm run build
npm run dev:pages
```

`npm run build` writes the static site to `dist/`. `wrangler pages dev dist`
serves `dist/` together with the root `functions/` directory. The default
Wrangler port is `8788`; pass `--port` and `--ip` to change it. The landing page
is `/`, the dashboard is `/dashboard`, and sign-in is `/login`.

### Fastify Node runtime

```bash
npm run dev        # watch mode
npm run build:server
npm start          # build/server/server.js
```

The Fastify server is useful for local development and route tests. Serve it at
`http://localhost:3000/` after `npm run dev`.

### npm scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the server with watch mode (`tsx watch`) |
| `npm test` | Run Vitest once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run typecheck` | Strict TypeScript check, no emit |
| `npm run build` | Build static Pages assets into `dist/` |
| `npm run build:server` | Compile the Node compatibility server into `build/server/` |
| `npm run dev:pages` | Run `wrangler pages dev dist` |
| `npm start` | Run the compiled Node server |
| `npm run db:generate` | Generate SQL migrations from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run smoke:serv` | One live OpenServ SERV extraction against a fixed sample (needs `SERV_API_KEY`; builds the server first) |

## Cloudflare Pages deployment

The repository targets the official HackOnVibe Cloudflare Pages architecture:
static assets in `dist/`, Pages Functions at the repository root, reusable
handlers in `server/`, and PostgreSQL through a `HYPERDRIVE` binding.

Local Pages development:

```bash
npm run build
npm run dev:pages
```

Production setup requires a real Hyperdrive configuration and encrypted Pages
secrets (`ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, and optionally
`SERV_API_KEY`). The binding is intentionally not committed with a placeholder
ID. See [Cloudflare Pages deployment](docs/cloudflare-pages.md) for the binding,
secrets, migration and `wrangler pages deploy` commands.

> The organizer workflow excludes `functions/` and `wrangler.*` from its static
> artifact. It can publish the static shell but cannot run the API, auth or
> database-backed pages. Use Cloudflare Git integration or Wrangler for the
> complete application; the workflow itself is unchanged.

## Tests and checks

The suite uses Vitest and needs a reachable PostgreSQL database. The global
setup applies pending migrations once per run. Several suites are integration
tests against PostgreSQL and clean up their own rows; research tests use a
mock HTTP layer and extraction tests use a fake AI provider.

```bash
npm test
npm run typecheck
npm run build
```

Last verified locally on 2026-11-15:

- `npm run typecheck` — passed
- `npm run build` — passed
- `npm test` — 18 test files, 259 tests passed

The suite covers health routes, manufacturer/product validation, research URL
safety and fetch limits, robots handling, AI provider errors and timeouts,
OpenServ SERV configuration and mocked SERV responses, extraction guards,
landing-page static serving, the judge demo, authentication and dashboard
access, Pages adapter health/auth/public routes, PostgreSQL-backed session
persistence and rate limiting, research workbench data, catalogue import,
evidence review and the public support API. No test contacts the real SERV
endpoint; the live check is `npm run smoke:serv`.

That live smoke test passed on 2026-11-15 against the configured SERV endpoint
(`gpt-5.4-mini-2026-03-17`, HTTP 200, 735 prompt + 91 completion tokens, 6.7 s):
the quotation was found verbatim in the sample source, the date normalised to
`2030-12-31` at day precision, and the claim remained `pending`. SERV rejects
`max_tokens`, so the provider sends `max_completion_tokens` for SERV and
`max_tokens` for other OpenAI-compatible endpoints. SERV also varies field names
between calls (`claim_type`, `supported_claim`, `source_quote`, `verbatim_quote`,
and similar); the schema normalises those aliases and still requires a verbatim
source quotation.

## Public and authenticated API

All API responses are JSON. Successful responses normally wrap the resource in
`data` (list endpoints add `pagination`); errors use:

```json
{ "error": { "code": "ERROR_CODE", "message": "Human-readable message", "details": [] } }
```

The catalogue import endpoint returns its summary/result object directly, as
documented in `docs/catalogue-import.md`.

### Public endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | SS Tool marketing landing page (static HTML) |
| GET | `/healthz` | Liveness probe, always `200` while the process runs |
| GET | `/readyz` | Readiness probe, checks PostgreSQL (`200`/`503`) |
| GET | `/login` | Dashboard sign-in page |
| POST | `/api/v1/auth/login` | Sign in with the configured administrator (`200`, `401`, `429`, `503`) |
| POST | `/api/v1/auth/logout` | Destroy the current session and clear its cookie |
| GET | `/api/v1/public/products/lookup` | Resolve a product by GTIN or manufacturer + model |
| GET | `/api/v1/public/products/:id/support-card` | Reviewed public support card |
| GET | `/api/v1/public/demo/products` | Predefined judge-demo products and their fixed demo sources |
| POST | `/api/v1/public/demo/extract` | Live SERV extraction preview for one predefined demo product (`200`, `400`, `429`, `502`, `503`); never persists evidence |

### Authenticated endpoints

All routes below require a signed session cookie. Missing or expired sessions
return `401 AUTH_REQUIRED`; dashboard pages redirect to `/login?next=...`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/v1/auth/session` | Current session details |
| GET | `/dashboard` | Overview page |
| GET | `/dashboard/products` | Product catalogue page |
| GET | `/dashboard/import` | CSV import page |
| GET | `/dashboard/research` | Manufacturer research workbench |
| GET | `/dashboard/review` | Evidence review queue |
| GET | `/api/v1/dashboard/summary` | Live dashboard aggregates and five recent products |
| GET | `/api/v1/dashboard/research/products` | Paginated products with source/evidence counts |
| GET | `/api/v1/dashboard/evidence-queue` | Paginated review queue with status counts |
| POST | `/api/v1/manufacturers` | Create a manufacturer (`201`, `400`, `409`) |
| GET | `/api/v1/manufacturers` | List manufacturers ordered by name |
| GET | `/api/v1/manufacturers/:id` | Manufacturer by UUID (`404` when unknown) |
| POST | `/api/v1/products` | Create a product (`201`, `400`, `404`, `409`) |
| GET | `/api/v1/products` | Paginated list (`page`, `pageSize`, `manufacturerId`) |
| GET | `/api/v1/products/:id` | Product detail including its manufacturer |
| GET | `/api/v1/products/:id/sources` | Persisted source metadata for a product |
| POST | `/api/v1/products/:id/research` | Discover and store manufacturer sources |
| POST | `/api/v1/products/:id/extract-evidence` | AI-extract support claims from stored sources |
| GET | `/api/v1/products/:id/evidence` | Paginated evidence for a product |
| GET | `/api/v1/products/:id/evidence/assessment` | Integrity checks and conflicts for a product |
| POST | `/api/v1/catalogue/imports` | Import a CSV catalogue (multipart `file`) |
| GET | `/api/v1/evidence/:id` | Evidence detail with source and review audit |
| POST | `/api/v1/evidence/:id/review` | Accept or reject evidence with a required note |

Authentication notes:

- The browser never receives a password, password hash or signing secret. Only
  a random session identifier is stored, in a signed `HttpOnly`,
  `SameSite=Lax` cookie; `Secure` is added when `NODE_ENV=production`.
- Failed logins are limited to 5 per IP per 15 minutes in PostgreSQL, returning
  `429` with `Retry-After`. Login failures never log the submitted password.
- Sessions are rows in `admin_sessions`; logout deletes the row, so the cookie
  stops working on every isolate immediately.
- The public support API and public lookup are intentionally unauthenticated,
  read-only and cacheable.

Other normalizations:

- Manufacturer names are normalized (case and whitespace) for uniqueness; the
  original spelling is kept for display.
- `gtin` is stored as text so leading zeros survive, and is checksum-validated
  against GTIN-8/12/13/14 rules.
- Product model identifiers are unique per manufacturer, case-insensitively,
  and only when present.
- Pagination defaults to `page=1`, `pageSize=20` (maximum 100).

## Manufacturer research

`POST /api/v1/products/:id/research` fetches the manufacturer's registered
website, follows at most four further same-host pages (five fetches total), and
records what it finds. It returns the discovered/fetched/review/failure
breakdown along with stored source IDs. It does not create evidence or infer
support dates.

- With no manufacturer website the endpoint returns `422 MANUFACTURER_WEBSITE_MISSING`.
- Unsafe or non-public manufacturer/product URLs return `422 UNSAFE_MANUFACTURER_WEBSITE`
  or are reported as failures without being requested.
- Only HTTP(S) on ports 80/443 is allowed. Loopback, private, link-local and
  reserved addresses are refused, as are URLs with embedded credentials.
- DNS is resolved once per hop and every redirect hop is revalidated. In the
  Node fetcher the connection is pinned to the validated address; the Pages
  fetcher validates through DNS-over-HTTPS before `fetch`. Cross-host redirects
  are refused in both.
- `robots.txt` is honoured (fetched through the same safe fetcher and excluded
  from the page budget). A missing robots file allows access; explicit `401`/`403`
  forbids it.
- Limits: 5 pages per request, discovery depth 1, 2 MB per response, 10 s per
  request, sequential fetches. Successful responses over 2 MB, non-HTML bodies,
  timeouts and HTTP errors are reported per URL instead of aborting the run.
- External support links are stored as `discovered_candidate` sources and
  returned as unvisited candidates; they are never fetched.
- Only extracted page text is stored (never full HTML), together with the URL,
  domain, title, HTTP status, content hash and fetch time.

Response shape:

```json
{
  "data": {
    "productId": "…",
    "researchedAt": "2026-11-13T17:07:36.212Z",
    "manufacturer": { "id": "…", "name": "…", "website": "https://…" },
    "pagesDiscovered": 2,
    "pagesFetched": 2,
    "pagesRequiringReview": [{ "url": "…", "reason": "robots_disallowed" }],
    "externalCandidates": [{ "url": "…", "anchorText": "…", "sourceId": "…", "reason": "external_domain" }],
    "failures": [{ "url": "…", "reason": "timeout", "message": "…" }],
    "sources": [{ "id": "…", "url": "…", "title": "…", "httpStatus": 200, "contentHash": "…", "fetchedAt": "…", "relationshipType": "manufacturer_homepage", "unchanged": false }],
    "storedSourceIds": ["…"],
    "limits": { "maxPages": 5, "maxDiscoveryDepth": 1, "maxBytes": 2097152, "timeoutMs": 10000 }
  }
}
```

## Evidence extraction

`POST /api/v1/products/:id/extract-evidence` reads up to five already-fetched
sources associated with the product and asks the configured AI model for
structured claims. The provider is OpenServ SERV Reasoning when `SERV_API_KEY`
is set, otherwise any configured OpenAI-compatible endpoint. It never fetches a
webpage. Sources associated only as `discovered_candidate`, sources without
text, non-2xx fetches and third-party domains are skipped and reported.

Every model response is schema-validated with Zod. A claim is stored only when:

- its quotation can be found in the stored source text (whitespace/Unicode
  normalised; ellipsis-separated fragments must appear in order);
- any `dateText` appears in the quotation at the same precision;
- semantic guards confirm an explicit support commitment, not a launch date,
  latest-patch date, warranty, marketing line or unrelated statement.

`normalized_date` is populated only for an explicit, unambiguous full date
(`15 December 2030`). Month-only (`December 2030`) and year-only (`2030`)
commitments keep `dateText` and `datePrecision` but leave `normalizedDate` null.

Stored claims use `extraction_method = 'ai'` and `review_status = 'pending'`.
Repeated extraction is idempotent: quotes already recorded for the product,
source and claim type are reported as duplicates, and reviewed/manual evidence
is never updated.

Response shape:

```json
{
  "data": {
    "productId": "…",
    "extractedAt": "2026-11-13T18:00:00.000Z",
    "provider": "openai-compatible:model-name",
    "sourcesProcessed": 2,
    "sourcesSkipped": 1,
    "claimsExtracted": 2,
    "claimsStored": 2,
    "claimsRejected": 0,
    "duplicateClaims": 0,
    "extractionFailures": [],
    "sources": [{ "sourceId": "…", "url": "…", "relationshipType": "policy_page", "charactersSent": 1200 }],
    "skippedSources": [{ "sourceId": "…", "url": "…", "reason": "empty_content" }],
    "storedClaims": [{
      "evidenceId": "…",
      "sourceId": "…",
      "claimType": "support_end",
      "statement": "Security updates are provided until December 2030.",
      "quotation": "Security updates will be provided until December 2030.",
      "dateText": "December 2030",
      "datePrecision": "month",
      "normalizedDate": null,
      "reviewStatus": "pending",
      "confidence": 0.94,
      "explanation": "…"
    }],
    "rejectedClaims": [],
    "duplicates": [],
    "limits": { "maxSources": 5, "maxInputTokens": 8000, "maxOutputTokens": 1500 }
  }
}
```

A result with zero claims is successful. Provider problems return `503
AI_NOT_CONFIGURED`, `504 AI_PROVIDER_TIMEOUT`, `502 AI_PROVIDER_ERROR`,
`502 AI_PROVIDER_AUTH_FAILED`, or `429 AI_PROVIDER_RATE_LIMITED`; malformed
model JSON is reported per source in `extractionFailures` without storing
anything for that source.

## Verification and human review

`GET /api/v1/products/:id/evidence/assessment` runs deterministic checks over
every evidence record for a product:

- **Source integrity** — the source exists, was fetched with a 2xx status, is
  associated with the product, belongs to the manufacturer's domain and has
  stored text.
- **Quotation integrity** — the quotation appears in the stored source text and
  any date text appears in the quotation.
- **Claim integrity** — the claim passes semantic guards and any normalized
  date is consistent with the stated date text.
- **Conflict detection** — contradictory `support_start` or `support_end`
  commitments are grouped. Different precisions with overlapping spans are
  flagged for manual review rather than being treated as equal or conflicting.

`GET /api/v1/dashboard/evidence-queue` exposes the review queue with filters
for `pending`, `accepted`, `rejected`, `conflicting` and `all`, plus search and
pagination. `GET /api/v1/evidence/:id` returns the evidence, its source and its
review history.

`POST /api/v1/evidence/:id/review` accepts:

```json
{ "decision": "accepted", "reviewNote": "Quotation verified against the manufacturer lifecycle page." }
```

The note is required. Accepting evidence also re-checks source integrity and
returns `422 SOURCE_INTEGRITY_FAILED` when the source is not eligible. A
rejected-accepted cycle is recorded in `evidence_reviews`; the audit row is
append-only.The review UI is at `/dashboard/review`. The queue supports status filters,
search, and pagination over PostgreSQL records. Selecting a record shows the
product context, extracted claim, exact quotation, source metadata, backend
integrity results, product-level conflict comparisons, and review history.
Both decisions require a note and an explicit confirmation; the browser cannot
auto-accept or bulk-approve evidence, and it displays the backend error when a
review is refused.

Publication readiness is derived from the same assessment data: conflict
counts, pending records, accepted records, and whether an accepted claim is in
a conflict. The UI links to the public support-card endpoint only when it has an
accepted claim and no accepted conflict. Acceptance records that a human
reviewed a manufacturer statement; it is not a security score or CRA
certification.

## Catalogue import

`POST /api/v1/catalogue/imports` accepts a single multipart CSV file in the
`file` field (5 MB limit, 500 data rows). Required headers are
`manufacturer_name` and `product_name`; optional headers include
`manufacturer_website`, `manufacturer_country_code`, `model_identifier`,
`gtin`, `sku`, `category`, `product_url` and `market_region`.

Rows are validated independently. A malformed row does not block valid rows.
Manufacturers are resolved by normalized name and missing metadata is filled
in without overwriting existing non-empty values. Product duplicates are
matched by manufacturer + model identifier, then manufacturer + GTIN. The
response reports created, duplicate and rejected rows with row-level errors,
ignored columns and non-blocking warnings.

The full format, validation rules and limitations are documented in
[`docs/catalogue-import.md`](docs/catalogue-import.md). The synthetic fixture
is `tests/fixtures/catalogue-valid.csv`.

## Public support API

The public API is read-only, deterministic, cacheable and isolated from the AI
and research pipelines.

- `GET /api/v1/public/products/lookup?gtin=…` or
  `?manufacturer=…&modelIdentifier=…` resolves a product and returns its
  support-card URL.
- `GET /api/v1/public/products/:id/support-card` returns the product,
  manufacturer, reviewed support commitments, source metadata and a
  disclaimer.

Only accepted evidence is published. Pending and rejected evidence are never
presented as a commitment. If accepted evidence contradicts other active
evidence, the status becomes `CONFLICTING_INFORMATION` and the support dates
are withheld rather than guessed. If no accepted evidence exists, the status is
`INSUFFICIENT_INFORMATION`. Month-only and year-only commitments keep their
display text and precision instead of inventing a day.

The full contract, status definitions, publication rules and privacy
boundaries are documented in
[`docs/public-support-api.md`](docs/public-support-api.md).

## Data model

Migrations `drizzle/0000_*.sql` through `drizzle/0003_*.sql` create six tables:

- `manufacturers` — unique `normalized_name`, optional website and country code.
- `products` — references a manufacturer (`ON DELETE RESTRICT`), unique partial
  index on `(manufacturer_id, lower(model_identifier))`, GTIN format check.
- `sources` — unique `url`, optional HTTP status, content hash, fetch time and
  extracted `description` / `content_type` / `content_text` (never full HTML).
- `product_sources` — many-to-many association with a `relationship_type` enum
  (`manufacturer_homepage`, `product_page`, `support_page`, `security_advisory`,
  `policy_page`, `discovered_candidate`) and a unique
  `(product_id, source_id, relationship_type)` constraint. Rows cascade with
  their product or source.
- `evidence` — references products (`ON DELETE CASCADE`) and sources
  (`ON DELETE RESTRICT`); enum claim type, extraction method and review status;
  nullable SQL `date` for `normalized_date`; `date_text` and `date_precision`
  (`day`/`month`/`year`) preserving the manufacturer's wording; `explanation`;
  and a nullable `claim_fingerprint` with a partial unique index on
  `(product_id, claim_type, claim_fingerprint)` for idempotent AI extraction.
  `numeric(4,3)` confidence is constrained to 0-1; review status defaults to
  `pending`. There is no product "verified" flag: evidence never changes a
  product's state automatically.
- `evidence_reviews` — an append-only audit record for each human review
  decision, including the previous status, review note and timestamp.

## Judge demo

The repository does not ship a hosted demo mode. The application is a server +
PostgreSQL app; the organizer's static Cloudflare Pages pipeline cannot run it.
The landing page does include a live judge panel that calls this backend.

### Live SERV demonstration on the landing page

1. Put an OpenServ SERV key in `.env` as `SERV_API_KEY=...`. Keep it out of Git;
   only `.env.example` with placeholders is published.
2. Start the server with `npm run dev` and open `http://localhost:3000/`.
3. In **Live Judge Demonstration**, pick one of the two predefined demo products
   and press **Run Live SERV Extraction**.
4. The panel shows the provider, model, latency, request id and token usage,
   plus each claim's quotation and its validation results.

The demo only accepts the predefined product IDs: there is no URL field and no
arbitrary source input. Requests are capped at 10 per minute per IP, nothing is
written to the database, and every claim is returned as `pending`. If the
configured provider is not SERV, the endpoint refuses with
`503 SERV_NOT_CONFIGURED` rather than presenting another model as OpenServ SERV.

To verify the live integration from the command line after `npm run build`:

```bash
npm run smoke:serv
```

The script sends one controlled extraction to the configured SERV endpoint and
prints nothing sensitive. Without a key it reports `SERV SMOKE TEST UNVERIFIED`
instead of contacting the network.

### Local walkthrough

1. Follow [Installation and local setup](#installation-and-local-setup) and
   [Dashboard setup](#dashboard-setup).
2. Open `http://localhost:3000/` to see the landing page.
3. Sign in at `http://localhost:3000/login`.
4. Open **Import catalogue** (`/dashboard/import`) and upload
   `tests/fixtures/catalogue-valid.csv`. The fixture is deliberately synthetic;
   its `.example.com` manufacturers are not real websites.
5. Open **Research** (`/dashboard/research`), pick a product and inspect the
   stored source panel. To exercise live research, add or edit a manufacturer
   with a real public support website and run research against a product.
6. With `SERV_API_KEY` (or `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL`)
   configured, run **Extract evidence** on a product with fetched sources.
   Claims arrive as pending review.
7. Open **Evidence review** (`/dashboard/review`) to inspect quotations,
   conflicts and integrity checks, then accept or reject a claim with a note.
8. After accepting evidence, call the public API:

   ```bash
   curl http://localhost:3000/api/v1/public/products/<product-id>/support-card
   ```

   The response status is `INFORMATION_AVAILABLE` only when accepted evidence
   exists without an accepted conflict. Otherwise it explicitly reports
   `INSUFFICIENT_INFORMATION` or `CONFLICTING_INFORMATION`.

The automated suite is also a reliable demo of the implemented behaviour:
`npm test` exercises the routes against PostgreSQL and uses deterministic
stand-ins for the network and the AI provider.

## Known limitations

- **Organizer workflow:** the organizer-provided Cloudflare Pages workflow
  packages only static files and excludes `functions/`, `wrangler.*` and
  `_routes.json`. Deploy the full application through Cloudflare Git integration
  or `wrangler pages deploy`; the workflow is intentionally left untouched.
- **Hyperdrive binding:** production needs a real Hyperdrive configuration and
  the `HYPERDRIVE` binding. Local Pages development uses `DATABASE_URL` in
  `.dev.vars`; there is no committed production connection string or ID.
- **Single administrator:** one shared account and no multi-tenant retailer
  workspaces. Sessions are shared through PostgreSQL rather than process memory.
- **Synchronous research and extraction:** both run inside the HTTP request.
  Research is capped at 5 pages, depth 1, 2 MB per response and 10 s per
  request; extraction reads at most 5 sources. There is no background job queue
  and no persisted research-run history table.
- **No automatic acceptance:** evidence never becomes public without a human
  decision. A demo that skips review will correctly show insufficient
  information.
- **AI is optional and external:** without a configured provider, extraction
  returns `503`. There is no offline model and no bundled API key.
- **Catalogue API scope:** manufacturers and products support create, list and
  detail endpoints; there are no update or delete endpoints. Imports are capped
  at 5 MB / 500 rows, and rows without a model identifier or GTIN cannot be
  reliably deduplicated across imports.
- **Source storage:** only extracted text, not full HTML, is stored. Research
  does not fetch external candidate domains automatically.
- **Pages research transport:** Workers has no Node `http`/`https`, so the Pages
  adapter validates DNS through DNS-over-HTTPS before fetching. The Node
  fetcher's socket-level DNS pinning is not available in Workers.
- **Public identifier lookup:** a duplicated GTIN can produce
  `409 AMBIGUOUS_PRODUCT_MATCH`; the API does not guess which product is meant.
- **Public page is API-only:** the dashboard's publication-readiness link opens
  `/api/v1/public/products/:id/support-card`, the JSON support contract. The
  project does not include a rendered public HTML support page.
- **Queue conflict counts:** the review queue computes conflict flags and counts
  from active support-date claims on each request so the numbers match the
  existing conflict detector. This is suitable for the current single-tenant
  dataset, not a precomputed queue for very large evidence sets.
- **No uploads or private files:** catalogue CSV uploads are processed in
  memory and are not persisted to disk.

## Security notes

- `.env` is ignored by Git. Only `.env.example` with placeholders is published.
- No real API keys, administrator passwords, session secrets or database
  passwords are committed. The repository history was checked before
  publishing.
- Logs are structured JSON with authorization and cookie headers redacted.
  Internal error details are never returned to clients.
- Research refuses loopback, private, link-local and reserved addresses and
  revalidates every redirect. The Node fetcher pins validated DNS results to its
  socket; the Pages fetcher validates through DNS-over-HTTPS before `fetch`.
  Both honour `robots.txt` and enforce response size and time limits.
- The browser never receives a password, password hash or signing secret.
- The OpenServ SERV key is read only on the server. It is never sent to the
  browser, included in API responses, logged, or committed; the judge demo only
  receives a server-generated preview.
- If you fork or deploy this project, generate fresh credentials and never
  reuse the local Docker development values.

## HackOnVibe repository notes

The following organizer-provided files are retained unchanged:

- `.github/workflows/deploy.yml` — managed centrally by HackOnVibe. Do not edit
  it; the platform restores it.
- `index.html` — the organizer placeholder page at the repository root.
- `.wrangler/` — organizer-provided Cloudflare Pages cache metadata.

Organizer instructions, preserved for reference:

> Your team's project repo. Push here to Cloudflare Pages CI/CD builds and
> deploys; it goes live on your team's address.
>
> Test the pipeline first: edit `index.html` (a "Hello World" is enough), commit
> to `main` (or open a PR), and watch it appear on your live URL. That confirms
> the whole chain works.
>
> Then build your AI-assisted micro-product. Static site works out of the box;
> add a build step if you need one.
>
> Do not edit `.github/workflows/deploy.yml` — it is managed centrally; just
> push your app code.
>
> After you push to `main`, your static site goes live in about 2-5 minutes.
> Keep `.github/workflows/deploy.yml` and, if your app has one, `package.json`.

**Important for this project:** the workflow detects `package.json` at the
repository root, runs `npm run build` and looks for a static `index.html` in
`dist/`, `build/`, `out/`, `.output/public/` or `.next-export/`. SS Tool's build
now produces that static shell in `dist/`, so the organizer workflow can publish
the landing, login and dashboard pages. The workflow then excludes `functions/`,
`_worker.js`, `_routes.json` and `wrangler.*`, so it cannot deploy the API,
authentication or Hyperdrive binding. The workflow is intentionally not
modified; use Cloudflare Pages Git integration or Wrangler for the full
application. See [Cloudflare Pages deployment](docs/cloudflare-pages.md).

The `main` branch is the default branch. Direct pushes are possible with the
authenticated account; this submission preserves the organizer's existing
commits and adds the SS Tool implementation on top.

## Documentation

- [`docs/cloudflare-pages.md`](docs/cloudflare-pages.md) — Pages runtime layout,
  local Wrangler development, Hyperdrive, secrets, migrations and deployment.
- [`docs/catalogue-import.md`](docs/catalogue-import.md) — CSV format, upload
  endpoint, validation, manufacturer resolution and duplicate handling.
- [`docs/public-support-api.md`](docs/public-support-api.md) — public lookup and
  support-card contract, status definitions, publication rules and privacy
  boundaries.
- The sections above document research, extraction, verification, the data
  model and the authenticated API.

## Design credit

The landing page follows the design process and references from
[Unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky
([@heydamir](https://x.com/heydamir)), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The skill is
installed project-locally under `.agents/skills/unslop`; it is not required to
build or run SS Tool.
