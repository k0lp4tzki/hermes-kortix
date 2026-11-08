import type { FastifyInstance } from 'fastify';
import authRoutes from './auth.js';
import userRoutes from './users.js';
import secretRoutes from './secrets.js';
import platformRoutes, { navCountsRoute } from './platform.js';

export const routeModules: Array<(app: FastifyInstance) => Promise<void>> = [
  authRoutes,
  userRoutes,
  secretRoutes,
  platformRoutes,
  navCountsRoute,
];
