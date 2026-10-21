/**
 * FinGate v2 — hợp đồng Quy tắc tự động & Lượt chạy — v2/v2.md §11.2–11.3, §14.1–14.3.
 *
 * Quy tắc = cấu hình (trigger + điều kiện + chuỗi bước + tham số), bật/tắt theo công ty.
 * Lượt chạy = một lần quy tắc chạy cho một đối tượng nguồn; khoá idem = `rule:source:event`.
 */

import { z } from 'zod';
import { AUTOMATION_RULE_CODES, AUTOMATION_RUN_STATUSES, AUTOMATION_STEP_STATUSES } from '../status/index.js';
import { objectId, uuid } from './common.js';

const lit = <T extends string>(arr: readonly T[]) => arr as unknown as [T, ...T[]];

export const automationRuleCode = z.enum(lit(AUTOMATION_RULE_CODES));
export const automationRunStatus = z.enum(lit(AUTOMATION_RUN_STATUSES));
export const automationStepStatus = z.enum(lit(AUTOMATION_STEP_STATUSES));
export type AutomationRuleCodeValue = z.infer<typeof automationRuleCode>;
export type AutomationRunStatusValue = z.infer<typeof automationRunStatus>;
export type AutomationStepStatusValue = z.infer<typeof automationStepStatus>;

/** Ghi đè theo công ty: bật/tắt riêng và tham số riêng (VD kỳ hạn khác nhau). */
export const automationCompanyOverride = z.object({
  company_id: objectId,
  enabled: z.boolean().default(true),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type AutomationCompanyOverride = z.infer<typeof automationCompanyOverride>;

/** Một bước trong lượt chạy (đúng thứ tự khai báo). */
export const automationRunStep = z.object({
  name: z.string(),
  status: automationStepStatus,
  output_type: z.string().nullable(),
  output_id: z.string().nullable(),
  error: z.string().nullable(),
  at: z.string().nullable(),
});
export type AutomationRunStep = z.infer<typeof automationRunStep>;

/** GET /automation/rules — một quy tắc. `company_ids` rỗng = mọi công ty. */
export const automationRuleRow = z.object({
  _id: objectId,
  code: automationRuleCode,
  name: z.string(),
  trigger_event: z.string(),
  trigger_events: z.array(z.string()).default([]),
  condition: z.record(z.string(), z.unknown()),
  steps: z.array(z.string()),
  params: z.record(z.string(), z.unknown()),
  company_overrides: z.array(automationCompanyOverride),
  company_ids: z.array(objectId),
  enabled: z.boolean(),
  updated_at: z.string(),
});
export type AutomationRuleRow = z.infer<typeof automationRuleRow>;

/**
 * PATCH /automation/rules/:id — chỉ `automation:config` (Chủ tịch, Admin).
 * - `enabled`, `params`, `company_ids`: chỉ người có phạm vi toàn tập đoàn (server kiểm);
 * - `company_overrides`: ghi đè của các công ty TRONG PHẠM VI người gọi; ghi đè công ty ngoài phạm vi phải giữ nguyên;
 * - `if_updated_at`: thời điểm `updated_at` của quy tắc khi người dùng đọc (chống ghi đè khi hai người sửa cùng lúc).
 */
export const automationRuleUpdateBody = z
  .object({
    enabled: z.boolean().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    company_ids: z.array(objectId).max(500).optional(),
    company_overrides: z.array(automationCompanyOverride).max(500).optional(),
    if_updated_at: z.string().max(40).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'if_updated_at'), 'Không có trường nào để cập nhật');
export type AutomationRuleUpdateBody = z.infer<typeof automationRuleUpdateBody>;

/** Dòng lượt chạy (màn "Quy trình tự động" trên phiếu nguồn). */
export const automationRunRow = z.object({
  _id: objectId,
  rule_code: automationRuleCode,
  rule_name: z.string().optional(),
  company_id: objectId.nullable(),
  source_type: z.string(),
  source_id: objectId,
  event_type: z.string(),
  idem_key: z.string(),
  status: automationRunStatus,
  steps: z.array(automationRunStep),
  error: z.string().nullable(),
  attempts: z.number().int().min(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AutomationRunRow = z.infer<typeof automationRunRow>;

/** GET /automation/runs — lọc theo nguồn (phiếu / khoản vay) hoặc trạng thái. */
export const automationRunQuery = z.object({
  source_type: z.string().max(40).optional(),
  source_id: objectId.optional(),
  status: automationRunStatus.optional(),
  company_id: objectId.optional(),
  scope: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AutomationRunQuery = z.infer<typeof automationRunQuery>;

/** POST /automation/runs/:id/rerun — chỉ chạy các bước chưa xong (§11.2 (3)). */
export const automationRerunBody = z.object({
  request_id: uuid.optional(),
});
export type AutomationRerunBody = z.infer<typeof automationRerunBody>;
