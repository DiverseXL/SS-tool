import { z, ZodError } from 'zod';
import { AppError } from '../../src/lib/errors.js';
import { createManufacturerBodySchema } from '../../src/schemas/manufacturer.js';
import {
  createProductBodySchema,
  listProductsQuerySchema,
  productIdParamsSchema,
} from '../../src/schemas/product.js';
import {
  evidenceIdParamsSchema,
  listEvidenceQuerySchema,
  reviewEvidenceBodySchema,
} from '../../src/schemas/evidence.js';
import { evidenceQueueQuerySchema } from '../../src/schemas/review.js';
import { publicProductLookupQuerySchema } from '../../src/schemas/public.js';
import { importCatalogueFromBuffer } from '../../src/catalogue/import-service.js';
import {
  CsvStructureError,
  MissingRequiredHeadersError,
} from '../../src/catalogue/csv-parser.js';
import {
  closeDatabase,
  createPagesContext,
  type PagesAppContext,
} from '../pages/context.js';
import { isPrivateApiPath, requestIp } from '../pages/auth.js';
import type { PagesEnv } from '../pages/env.js';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

const loginBodySchema = z
  .object({
    email: z.email('must be a valid email address').max(320),
    password: z.string().min(1, 'is required').max(1024),
  })
  .strict();

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function errorJson(
  code: string,
  message: string,
  status: number,
  extra: object = {},
  headers: Record<string, string> = {},
): Response {
  return json({ error: { code, message, ...extra } }, status, headers);
}

function queryObject(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

function routeId(pathname: string, pattern: RegExp): string | null {
  const match = pattern.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function isPublicPath(pathname: string): boolean {
  return pathname.startsWith('/api/v1/public/') || pathname === '/api/v1/public';
}

async function handleCatalogueImport(request: Request, context: PagesAppContext): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorJson('INVALID_FORM_DATA', 'Expected multipart/form-data with a CSV file.', 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return errorJson(
      'NO_FILE',
      'No file was uploaded. Send a CSV file in the "file" form field.',
      400,
    );
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return errorJson('FILE_TOO_LARGE', 'Upload exceeds the maximum file size of 5 MB', 413);
  }

  const mime = file.type ?? '';
  const isTextOrCsv =
    mime.startsWith('text/') ||
    mime.includes('csv') ||
    mime === 'application/octet-stream' ||
    mime === 'application/vnd.ms-excel';
  if (!isTextOrCsv) {
    return errorJson(
      'UNSUPPORTED_MEDIA_TYPE',
      `Expected a CSV file; received "${mime}".`,
      415,
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await importCatalogueFromBuffer(
    context.manufacturerRepository,
    context.productRepository,
    buffer,
  );
  return json(result);
}

async function routeApi(
  request: Request,
  url: URL,
  context: PagesAppContext,
): Promise<Response> {
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  const session = isPrivateApiPath(pathname)
    ? await context.auth.authenticate(request)
    : null;

  if (isPrivateApiPath(pathname) && !session) {
    return errorJson('AUTH_REQUIRED', 'Authentication is required for this resource.', 401);
  }

  if (pathname === '/api/v1/auth/login' && method === 'POST') {
    if (!context.auth.isConfigured()) {
      return errorJson(
        'AUTH_NOT_CONFIGURED',
        context.auth.configurationError() ?? 'Authentication is not configured.',
        503,
      );
    }

    const body = loginBodySchema.parse(await readJson(request));
    const result = await context.auth.login(body.email, body.password, requestIp(request));
    if (!result.ok) {
      const headers: Record<string, string> = result.retryAfterSeconds
        ? { 'retry-after': String(result.retryAfterSeconds) }
        : {};
      return errorJson(result.code, result.message, result.status, {}, headers);
    }

    return json(
      {
        data: {
          email: result.session.email,
          expiresAt: result.session.expiresAt.toISOString(),
        },
      },
      200,
      { 'set-cookie': result.cookie },
    );
  }

  if (pathname === '/api/v1/auth/logout' && method === 'POST') {
    await context.auth.logout(request);
    return json(
      { data: { loggedOut: true } },
      200,
      { 'set-cookie': context.auth.clearCookie() },
    );
  }

  if (pathname === '/api/v1/auth/session' && method === 'GET') {
    if (!session) {
      return errorJson('AUTH_REQUIRED', 'Your session has expired.', 401);
    }
    return json({
      data: {
        email: session.email,
        expiresAt: session.expiresAt.toISOString(),
        workspace: { name: 'SS Tool workspace' },
      },
    });
  }

  if (pathname === '/api/v1/public/products/lookup' && method === 'GET') {
    const query = publicProductLookupQuerySchema.parse(queryObject(url));
    const result = await context.publicService.lookupProduct(query);
    return json({ data: result }, 200, {
      'cache-control': 'public, max-age=60, stale-while-revalidate=30',
    });
  }

  if (pathname === '/api/v1/public/demo/products' && method === 'GET') {
    const products = await context.judgeDemoService.listDemoProducts();
    return json({ data: products }, 200, {
      'cache-control': 'public, max-age=60, stale-while-revalidate=30',
    });
  }

  const supportCardId = routeId(
    pathname,
    /^\/api\/v1\/public\/products\/([^/]+)\/support-card$/,
  );
  if (supportCardId && method === 'GET') {
    const { id } = productIdParamsSchema.parse({ id: supportCardId });
    const card = await context.publicService.getSupportCard(id);
    return json({ data: card }, 200, {
      'cache-control': 'public, max-age=60, stale-while-revalidate=30',
    });
  }

  if (pathname === '/api/v1/manufacturers' && method === 'GET') {
    return json({ data: await context.manufacturerService.list() });
  }

  if (pathname === '/api/v1/manufacturers' && method === 'POST') {
    const body = createManufacturerBodySchema.parse(await readJson(request));
    return json({ data: await context.manufacturerService.create(body) }, 201);
  }

  const manufacturerId = routeId(pathname, /^\/api\/v1\/manufacturers\/([^/]+)$/);
  if (manufacturerId && method === 'GET') {
    const { id } = z.object({ id: z.uuid('must be a valid UUID') }).parse({ id: manufacturerId });
    return json({ data: await context.manufacturerService.getById(id) });
  }

  if (pathname === '/api/v1/products' && method === 'GET') {
    const query = listProductsQuerySchema.parse(queryObject(url));
    const result = await context.productService.list(query);
    return json({ data: result.items, pagination: result.pagination });
  }

  if (pathname === '/api/v1/products' && method === 'POST') {
    const body = createProductBodySchema.parse(await readJson(request));
    return json({ data: await context.productService.create(body) }, 201);
  }

  const productId = routeId(pathname, /^\/api\/v1\/products\/([^/]+)$/);
  if (productId && method === 'GET') {
    const { id } = productIdParamsSchema.parse({ id: productId });
    const detail = await context.productService.getById(id);
    return json({ data: { ...detail.product, manufacturer: detail.manufacturer } });
  }

  const researchProductId = routeId(
    pathname,
    /^\/api\/v1\/products\/([^/]+)\/research$/,
  );
  if (researchProductId && method === 'POST') {
    const { id } = productIdParamsSchema.parse({ id: researchProductId });
    return json({ data: await context.researchService.research(id) });
  }

  const extractProductId = routeId(
    pathname,
    /^\/api\/v1\/products\/([^/]+)\/extract-evidence$/,
  );
  if (extractProductId && method === 'POST') {
    const { id } = productIdParamsSchema.parse({ id: extractProductId });
    return json({ data: await context.extractionService.extract(id) });
  }

  const evidenceListProductId = routeId(
    pathname,
    /^\/api\/v1\/products\/([^/]+)\/evidence$/,
  );
  if (evidenceListProductId && method === 'GET') {
    const { id } = productIdParamsSchema.parse({ id: evidenceListProductId });
    const query = listEvidenceQuerySchema.parse(queryObject(url));
    const result = await context.verificationService.listEvidenceForProduct({
      productId: id,
      page: query.page,
      pageSize: query.pageSize,
      claimType: query.claimType,
      reviewStatus: query.reviewStatus,
    });
    return json({
      data: result.items.map((item) => ({ ...item.evidence, source: item.source })),
      pagination: result.pagination,
    });
  }

  const assessmentProductId = routeId(
    pathname,
    /^\/api\/v1\/products\/([^/]+)\/evidence\/assessment$/,
  );
  if (assessmentProductId && method === 'GET') {
    const { id } = productIdParamsSchema.parse({ id: assessmentProductId });
    return json({ data: await context.verificationService.assessProductEvidence(id) });
  }

  const sourcesProductId = routeId(pathname, /^\/api\/v1\/products\/([^/]+)\/sources$/);
  if (sourcesProductId && method === 'GET') {
    const { id } = productIdParamsSchema.parse({ id: sourcesProductId });
    return json({ data: await context.researchWorkbenchService.listSources(id) });
  }

  if (pathname === '/api/v1/catalogue/imports' && method === 'POST') {
    return handleCatalogueImport(request, context);
  }

  const evidenceId = routeId(pathname, /^\/api\/v1\/evidence\/([^/]+)$/);
  if (evidenceId && method === 'GET') {
    const { id } = evidenceIdParamsSchema.parse({ id: evidenceId });
    const record = await context.verificationService.getEvidenceDetail(id);
    return json({ data: { ...record.evidence, source: record.source, reviews: record.reviews } });
  }

  const reviewEvidenceId = routeId(
    pathname,
    /^\/api\/v1\/evidence\/([^/]+)\/review$/,
  );
  if (reviewEvidenceId && method === 'POST') {
    const { id } = evidenceIdParamsSchema.parse({ id: reviewEvidenceId });
    const body = reviewEvidenceBodySchema.parse(await readJson(request));
    const result = await context.verificationService.reviewEvidence({
      evidenceId: id,
      decision: body.decision,
      reviewNote: body.reviewNote,
    });
    return json({ data: { evidence: result.evidence, review: result.review } });
  }

  if (pathname === '/api/v1/dashboard/summary' && method === 'GET') {
    return json({ data: await context.dashboardRepository.getSummary() });
  }

  if (pathname === '/api/v1/dashboard/research/products' && method === 'GET') {
    const query = listProductsQuerySchema.parse(queryObject(url));
    const result = await context.researchWorkbenchService.listProducts({
      page: query.page,
      pageSize: query.pageSize,
      manufacturerId: query.manufacturerId,
    });
    return json({ data: result.items, pagination: result.pagination });
  }

  if (pathname === '/api/v1/dashboard/evidence-queue' && method === 'GET') {
    const query = evidenceQueueQuerySchema.parse(queryObject(url));
    const result = await context.reviewQueueService.list({
      page: query.page,
      pageSize: query.pageSize,
      status: query.reviewStatus,
      ...(query.search ? { search: query.search } : {}),
    });
    return json({
      data: result.items,
      pagination: result.pagination,
      counts: result.counts,
    });
  }

  if (isPublicPath(pathname)) {
    return errorJson('NOT_FOUND', `Route ${method} ${pathname} not found`, 404);
  }

  return errorJson('NOT_FOUND', `Route ${method} ${pathname} not found`, 404);
}

export async function handleApiRequest(request: Request, env: PagesEnv): Promise<Response> {
  const url = new URL(request.url);
  let context: PagesAppContext | null = null;

  try {
    context = createPagesContext(env);
    return await routeApi(request, url, context);
  } catch (error) {
    if (error instanceof ZodError) {
      return errorJson('VALIDATION_ERROR', 'Request validation failed', 400, {
        details: error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      });
    }

    if (error instanceof AppError) {
      return errorJson(error.code, error.message, error.statusCode);
    }

    if (error instanceof MissingRequiredHeadersError) {
      return errorJson('MISSING_REQUIRED_HEADERS', error.message, 422, {
        details: error.missingHeaders.map((header) => ({
          field: header,
          message: 'Header is required',
        })),
      });
    }

    if (error instanceof CsvStructureError) {
      return errorJson('INVALID_CSV', error.message, 422);
    }

    console.error('Pages API request failed', {
      name: error instanceof Error ? error.name : 'UnknownError',
      code: (error as { code?: string }).code ?? 'UNKNOWN',
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      path: url.pathname,
    });

    return errorJson('INTERNAL_SERVER_ERROR', 'Internal server error', 500);
  } finally {
    if (context) {
      try {
        await closeDatabase(context.database);
      } catch (closeError) {
        console.error('Pages database cleanup failed', {
          name: closeError instanceof Error ? closeError.name : 'UnknownError',
        });
      }
    }
  }
}
