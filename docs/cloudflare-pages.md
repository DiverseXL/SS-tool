# Cloudflare Pages deployment

SS Tool runs on Cloudflare Pages as a static site plus Pages Functions. The
browser pages are plain HTML/CSS/JS, the API is served by Functions, and
PostgreSQL is reached through a Hyperdrive binding.

## Runtime layout

```
dist/                         static build output (Pages assets)
functions/                    thin Pages Functions entrypoints
  _middleware.ts              dashboard/login page protection
  healthz.ts                  liveness
  readyz.ts                   PostgreSQL readiness
  api/v1/index.ts             /api/v1
  api/v1/[[path]].ts          /api/v1/*
server/
  api/handler.ts              shared API router and error handling
  pages/context.ts            per-request database and service wiring
  pages/auth.ts               PostgreSQL-backed admin sessions
  pages/edge-fetcher.ts       Workers-compatible research fetcher
  pages/middleware.ts         page auth and redirects
  pages/health.ts             health/readiness responses
wrangler.toml                 Pages project configuration
```

The existing Fastify app in `src/app.ts` is retained for local Node
development and the route/integration test suite. Both adapters call the same
repositories, services, Zod schemas and verification rules.

## Page routes

The build script creates directory copies of the dashboard shells so these
URLs work without an SPA fallback:

- `/`
- `/login`
- `/dashboard`
- `/dashboard/products`
- `/dashboard/import`
- `/dashboard/research`
- `/dashboard/review`
- `/demo`

Pages may answer `/dashboard` with a `308` to `/dashboard/` and then serve the
page. The middleware protects both forms and redirects unauthenticated visitors
to `/login?next=...`.

## Local Pages development

1. Start PostgreSQL and apply migrations:

   ```bash
   docker compose up -d
   npm run db:migrate
   ```

2. Copy `.dev.vars.example` to `.dev.vars` and set at least:

   ```dotenv
   NODE_ENV=development
   DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/ss_tool
   ADMIN_EMAIL=operator@example.com
   ADMIN_PASSWORD=a-strong-password
   SESSION_SECRET=a-random-secret-of-at-least-32-characters
   ```

   `.dev.vars` is ignored by Git. Values must not be quoted.

3. Build the static assets and start Wrangler:

   ```bash
   npm run build
   npm run dev:pages
   ```

   `dev:pages` runs `wrangler pages dev dist` with `nodejs_compat` enabled. Use
   `npx wrangler pages dev dist --port 8788 --ip 127.0.0.1` when a fixed local
   address is needed.

The Pages runtime uses `DATABASE_URL` locally. Production uses the `HYPERDRIVE`
binding instead; `server/pages/context.ts` prefers `env.HYPERDRIVE.connectionString`
and never falls back to a hard-coded production connection string.

## Production database with Hyperdrive

Create a Hyperdrive configuration for the production PostgreSQL database:

```bash
npx wrangler hyperdrive create ss-tool-db \
  --connection-string="postgresql://USER:PASSWORD@HOST:5432/DB"
```

Add the returned ID to `wrangler.toml` (or bind it in the Cloudflare dashboard
under **Workers & Pages → your project → Settings → Bindings**):

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<HYPERDRIVE_ID_FROM_CLOUDFLARE>"
```

Do not commit the connection string and do not invent an ID. The repository's
`wrangler.toml` intentionally leaves the binding commented out until a real
Hyperdrive configuration exists.

Each Pages request opens a short-lived `postgres.js` client (`prepare: false`)
and closes it in a `finally` block. Workers forbid reusing I/O objects across
requests; Hyperdrive provides the real connection pool in front of PostgreSQL.

## Secrets and environment variables

Set these as encrypted Cloudflare Pages variables, not build-time frontend
variables:

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `SESSION_SECRET` (at least 32 characters)
- `SERV_API_KEY` (optional, enables OpenServ SERV extraction)
- `SERV_MODEL`, `SERV_BASE_URL` (optional)
- `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` (optional alternative provider)
- `SESSION_TTL_HOURS` (optional)

Use `npx wrangler pages secret put NAME --project-name <project>` or the
dashboard. Never prefix secrets with `VITE_`, `NEXT_PUBLIC_` or any other
client-exposed prefix.

## Migrations

Apply migrations before deploying code that depends on them:

```bash
npm run db:migrate
```

Migration `0004_light_pete_wisdom.sql` adds the persistent session tables
(`admin_sessions`, `login_attempts`) used by the Pages adapter. The migration
is safe to run against an existing database and does not delete evidence or
catalogue data.

## Deploying

### Cloudflare Git integration

- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: repository root
- Compatibility flags: `nodejs_compat`
- Compatibility date: `2026-11-15` (or newer)

Cloudflare runs the build and deploys both `dist/` and the root `functions/`
directory.

### Direct Wrangler deployment

```bash
npm run build
npx wrangler pages deploy dist --project-name <project>
```

## Organizer workflow limitation

The HackOnVibe workflow at `.github/workflows/deploy.yml` packages only static
files and explicitly excludes `functions/`, `_worker.js`, `_routes.json` and
`wrangler.*`. It therefore cannot deploy the Pages Functions API or the
Hyperdrive binding. The workflow is intentionally left unchanged.

Use Cloudflare Pages Git integration or `wrangler pages deploy` for the full
application. The organizer workflow can still publish the static shell, but
API routes, authentication and database-backed pages require the Functions
runtime.

## Runtime differences from the Node fetcher

`server/pages/edge-fetcher.ts` replaces Node's `http`/`https` transport because
Workers does not implement it. It:

- resolves hostnames through DNS-over-HTTPS and applies the same public-address
  checks before each request;
- follows only same-host redirects, revalidating every hop;
- enforces HTML content-type, byte and timeout limits;
- supports `robots.txt` through the shared research service.

The Node fetcher's socket-level DNS pinning is not available in Workers; the
Pages path validates DNS separately before `fetch`.

## Verification commands

```bash
npm test
npm run typecheck
npm run build
npm run build:server
```

`npm run build` writes the static `dist/` output. `npm run build:server` writes
the Node compatibility build used by `npm start` and `npm run test:serv`.
