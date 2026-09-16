/**
 * JSON Schema cho OpenAPI — sinh từ Zod (một nguồn schema, ADR-08).
 *
 * Fastify chạy với `noValidator` (lib/serialize.ts): JSON Schema CHỈ để tài liệu hoá,
 * validation nghiệp vụ thật do `validate(zodSchema, body)` trong handler đảm nhận
 * để còn chạy `superRefine` (ràng buộc cross-field mà JSON Schema không diễn đạt được).
 */

import {
  activateBody,
  alertRuleUpsertBody,
  attachmentConfirmBody,
  attachmentPrepareBody,
  balancesBulkBody,
  bankAccountUpsertBody,
  budgetUpsertBody,
  categoryUpsertBody,
  changePasswordBody,
  companyUpsertBody,
  debtListQuery,
  debtUpsertBody,
  delegationBody,
  documentCreateBody,
  documentListQuery,
  documentUpdateBody,
  exportRequestBody,
  forgotPasswordBody,
  forecastQuery,
  internalTransferBody,
  loanUpsertBody,
  loginBody,
  matrixUpsertBody,
  notificationListQuery,
  opinionBody,
  personnelDeactivateBody,
  personnelInviteBody,
  personnelTransferBody,
  prefsUpdateBody,
  recurringUpsertBody,
  resetPasswordBody,
  rolloverListQuery,
  rolloverResultBody,
  scenarioBody,
  searchQuery,
  settingUpsertBody,
  statementImportBody,
  transitionBody,
  twoFactorBody,
  departmentUpsertBody,
  auditLogQuery,
  reportQuery,
  newsletterQuery,
  dashboardQuery,
} from '@fingate/shared';
import { toJsonSchema } from '@fingate/shared';

const j = toJsonSchema;

// auth & phiên
export const loginBodySchema = j(loginBody);
export const twoFactorBodySchema = j(twoFactorBody);
export const forgotBodySchema = j(forgotPasswordBody);
export const resetBodySchema = j(resetPasswordBody);
export const activateBodySchema = j(activateBody);
export const prefsBodySchema = j(prefsUpdateBody);
export const changePasswordBodySchema = j(changePasswordBody);

// hồ sơ
export const documentCreateBodySchema = j(documentCreateBody);
export const documentUpdateBodySchema = j(documentUpdateBody);
export const documentListQuerySchema = j(documentListQuery);
export const transitionBodySchema = j(transitionBody);
export const opinionBodySchema = j(opinionBody);
export const attachmentPrepareBodySchema = j(attachmentPrepareBody);
export const attachmentConfirmBodySchema = j(attachmentConfirmBody);

// matrix & admin
export const matrixUpsertBodySchema = j(matrixUpsertBody);
export const companyUpsertBodySchema = j(companyUpsertBody);
export const departmentUpsertBodySchema = j(departmentUpsertBody);
export const categoryUpsertBodySchema = j(categoryUpsertBody);
export const settingUpsertBodySchema = j(settingUpsertBody);
export const alertRuleUpsertBodySchema = j(alertRuleUpsertBody);
export const auditLogQuerySchema = j(auditLogQuery);

// nhân sự
export const personnelInviteBodySchema = j(personnelInviteBody);
export const personnelDeactivateBodySchema = j(personnelDeactivateBody);
export const personnelTransferBodySchema = j(personnelTransferBody);
export const delegationBodySchema = j(delegationBody);

// tài chính
export const bankAccountUpsertBodySchema = j(bankAccountUpsertBody);
export const balancesBulkBodySchema = j(balancesBulkBody);
export const statementImportBodySchema = j(statementImportBody);
export const loanUpsertBodySchema = j(loanUpsertBody);
export const rolloverListQuerySchema = j(rolloverListQuery);
export const rolloverResultBodySchema = j(rolloverResultBody);
export const debtUpsertBodySchema = j(debtUpsertBody);
export const debtListQuerySchema = j(debtListQuery);
export const internalTransferBodySchema = j(internalTransferBody);
export const budgetUpsertBodySchema = j(budgetUpsertBody);
export const scenarioBodySchema = j(scenarioBody);
export const recurringUpsertBodySchema = j(recurringUpsertBody);

// đọc
export const dashboardQuerySchema = j(dashboardQuery);
export const newsletterQuerySchema = j(newsletterQuery);
export const reportQuerySchema = j(reportQuery);
export const exportRequestBodySchema = j(exportRequestBody);
export const forecastQuerySchema = j(forecastQuery);
export const notificationListQuerySchema = j(notificationListQuery);
export const searchQuerySchema = j(searchQuery);
