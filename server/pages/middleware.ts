import { createPagesAuthService } from './auth.js';
import type { PagesContext, PagesEnv } from './env.js';
import { closeDatabase, getDatabase } from './context.js';

function isDashboardPath(pathname: string): boolean {
  return (
    pathname === '/dashboard' ||
    pathname === '/dashboard/' ||
    pathname === '/dashboard.html' ||
    pathname.startsWith('/dashboard/')
  );
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Backend page protection for Pages-hosted dashboard routes. API protection is
 * enforced independently inside the API handler, so a static asset mistake can
 * never expose private data.
 */
export async function handlePagesMiddleware(context: PagesContext): Promise<Response> {
  const url = new URL(context.request.url);
  const pathname = url.pathname;
  const env: PagesEnv = context.env;

  if (pathname.startsWith('/api/') || pathname === '/healthz' || pathname === '/readyz') {
    return context.next();
  }

  if (pathname === '/login.html') {
    return Response.redirect(new URL('/login', url).toString(), 302);
  }

  if (pathname === '/dashboard.html') {
    return Response.redirect(new URL('/dashboard', url).toString(), 302);
  }

  if (!isDashboardPath(pathname) && pathname !== '/login') {
    return context.next();
  }

  let database;
  try {
    database = getDatabase(env);
    const auth = createPagesAuthService(database, env);

    if (pathname === '/login') {
      const session = await auth.authenticate(context.request);
      if (session) {
        return Response.redirect(new URL('/dashboard', url).toString(), 302);
      }
      return noStore(await context.next());
    }

    const session = await auth.authenticate(context.request);
    if (!session) {
      const next = pathname === '/dashboard/' ? '/dashboard' : `${pathname}${url.search}`;
      const login = new URL('/login', url);
      login.searchParams.set('next', next);
      return Response.redirect(login.toString(), 302);
    }

    return noStore(await context.next());
  } catch (error) {
    console.error('Pages auth middleware could not initialise', {
      name: error instanceof Error ? error.name : 'UnknownError',
    });
    return new Response('Authentication is temporarily unavailable.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  } finally {
    if (database) {
      await closeDatabase(database).catch(() => {});
    }
  }
}
