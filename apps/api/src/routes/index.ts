/** Nhóm route API nghiệp vụ — đăng ký dưới /api/v1 (architecture §10). */

import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.ts';
import { documentRoutes } from './documents.ts';
import { dashboardRoutes } from './dashboard.ts';
import { financeRoutes } from './finance.ts';
import { adminRoutes } from './admin.ts';

export function apiRoutes(app: FastifyInstance): void {
  authRoutes(app);
  documentRoutes(app);
  dashboardRoutes(app);
  financeRoutes(app);
  adminRoutes(app);
}
