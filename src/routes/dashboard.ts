import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { AuthService } from '../auth/auth-service.js';
import type { DashboardRepository } from '../repositories/dashboard-repository.js';

interface DashboardRoutesOptions {
  authService: AuthService;
  dashboardRepository: DashboardRepository;
}

export const dashboardRoutes: FastifyPluginAsync<DashboardRoutesOptions> = async (app, options) => {
  const { authService, dashboardRepository } = options;

  const sendDashboard = (reply: FastifyReply) => {
    void reply.header('Cache-Control', 'no-store');
    return reply.sendFile('dashboard.html');
  };

  app.get('/login', async (request, reply) => {
    if (authService.authenticateRequest(request)) {
      return reply.redirect('/dashboard');
    }

    void reply.header('Cache-Control', 'no-store');
    return reply.sendFile('login.html');
  });

  app.get('/login.html', async (_request, reply) => reply.redirect('/login'));
  app.get('/dashboard.html', async (_request, reply) => reply.redirect('/dashboard'));
  app.get('/dashboard/', async (_request, reply) => reply.redirect('/dashboard'));

  app.get('/dashboard', async (_request, reply) => sendDashboard(reply));
  app.get('/dashboard/products', async (_request, reply) => sendDashboard(reply));
  app.get('/dashboard/import', async (_request, reply) => sendDashboard(reply));
  app.get('/dashboard/research', async (_request, reply) => sendDashboard(reply));
  app.get('/dashboard/review', async (_request, reply) => sendDashboard(reply));

  app.get('/api/v1/dashboard/summary', async () => {
    const summary = await dashboardRepository.getSummary();
    return { data: summary };
  });
};
