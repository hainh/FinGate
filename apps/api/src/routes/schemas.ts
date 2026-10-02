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
  approvalThresholdUpsertBody,
  attachmentConfirmBody,
  attachmentPrepareBody,
  attachmentRemoveBody,
  ownerAttachmentConfirmBody,
  ownerAttachmentPrepareBody,
  ownerAttachmentRemoveBody,
  bankAccountUpdateBody,
  bankAccountUpsertBody,
  budgetUpsertBody,
  categoryUpsertBody,
  changePasswordBody,
  cashflowHistoryQuery,
  companyUpsertBody,
  debtListQuery,
  debtLinkBody,
  debtVoucherUpsertBody,
  bankDebtRepayBody,
  bankDebtUpsertBody,
  delegationBody,
  documentCreateBody,
  documentDeleteBody,
  documentListQuery,
  documentUpdateBody,
  exportRequestBody,
  forgotPasswordBody,
  internalTransferBody,
  loginBody,
  matrixUpsertBody,
  notificationListQuery,
  opinionBody,
  personnelDeactivateBody,
  personnelInviteBody,
  inviteRegenerateBody,
  personnelUpdateBody,
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
export const documentDeleteBodySchema = j(documentDeleteBody);
export const opinionBodySchema = j(opinionBody);
export const attachmentPrepareBodySchema = j(attachmentPrepareBody);
export const attachmentConfirmBodySchema = j(attachmentConfirmBody);
export const attachmentRemoveBodySchema = j(attachmentRemoveBody);
export const ownerAttachmentPrepareBodySchema = j(ownerAttachmentPrepareBody);
export const ownerAttachmentConfirmBodySchema = j(ownerAttachmentConfirmBody);
export const ownerAttachmentRemoveBodySchema = j(ownerAttachmentRemoveBody);

// matrix & admin
export const matrixUpsertBodySchema = j(matrixUpsertBody);
export const companyUpsertBodySchema = j(companyUpsertBody);
export const departmentUpsertBodySchema = j(departmentUpsertBody);
export const categoryUpsertBodySchema = j(categoryUpsertBody);
export const settingUpsertBodySchema = j(settingUpsertBody);
export const approvalThresholdUpsertBodySchema = j(approvalThresholdUpsertBody);
export const alertRuleUpsertBodySchema = j(alertRuleUpsertBody);
export const auditLogQuerySchema = j(auditLogQuery);

// nhân sự
export const personnelInviteBodySchema = j(personnelInviteBody);
export const inviteRegenerateBodySchema = j(inviteRegenerateBody);
export const personnelDeactivateBodySchema = j(personnelDeactivateBody);
export const personnelUpdateBodySchema = j(personnelUpdateBody);
export const personnelTransferBodySchema = j(personnelTransferBody);
export const delegationBodySchema = j(delegationBody);

// tài chính
export const bankAccountUpsertBodySchema = j(bankAccountUpsertBody);
export const bankAccountUpdateBodySchema = j(bankAccountUpdateBody);
export const statementImportBodySchema = j(statementImportBody);
export const bankDebtUpsertBodySchema = j(bankDebtUpsertBody);
export const bankDebtRepayBodySchema = j(bankDebtRepayBody);
export const rolloverListQuerySchema = j(rolloverListQuery);
export const rolloverResultBodySchema = j(rolloverResultBody);
export const debtVoucherUpsertBodySchema = j(debtVoucherUpsertBody);
export const debtLinkBodySchema = j(debtLinkBody);
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
export const cashflowHistoryQuerySchema = j(cashflowHistoryQuery);
export const notificationListQuerySchema = j(notificationListQuery);
export const searchQuerySchema = j(searchQuery);
