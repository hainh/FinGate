/** Nhóm route API nghiệp vụ — đăng ký dưới /api/v1 (architecture §10). */

import type { FastifyInstance } from 'fastify';
import { authRoutes } from './auth.ts';
import { documentRoutes } from './documents.ts';
import { dashboardRoutes } from './dashboard.ts';
import { financeRoutes } from './finance.ts';
import { debtRoutes } from './debt.ts';
import { bankDebtRoutes } from './bank-debt.ts';
import { partnerRoutes } from './partners.ts';
import { adminRoutes } from './admin.ts';
import { backupRoutes } from './backup.ts';
import { tagRoutes } from './tags.ts';
import { automationRoutes } from './automation.ts';

export function apiRoutes(app: FastifyInstance): void {
  authRoutes(app);
  documentRoutes(app);
  dashboardRoutes(app);
  financeRoutes(app);
  debtRoutes(app);
  bankDebtRoutes(app);
  partnerRoutes(app);
  adminRoutes(app);
  backupRoutes(app);
  tagRoutes(app);
  automationRoutes(app);
}
