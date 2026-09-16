/** Kiểu dùng chung trong domain — tránh import vòng giữa các module. */

import type { DocKind, Role, StatusKey, Tone } from '@fingate/shared';

export interface ScopeLike {
  /** null = toàn tập đoàn. */
  companyIds: string[] | null;
}

export interface ActorInfo {
  user_id: string;
  name: string;
  email: string;
  role: Role;
  role_label: string;
  company_id: string | null;
  department_id: string | null;
  amount_limit_minor: bigint;
  scope_all: boolean;
  permissions: string[];
  totp_enabled: boolean;
  session_id: string;
}

export interface DocAmount {
  minor: bigint;
  currency: string;
  decimals: number;
}

export interface ApprovalStepDoc {
  order: number;
  role: Role;
  user_id: string | null;
  delegated_from?: string | null;
  state: 'waiting' | 'current' | 'done' | 'skipped' | 'rejected';
  action?: string | null;
  decided_at?: Date | null;
  opinion?: string | null;
  reason?: string | null;
  sla_deadline?: Date | null;
  amount_at_decision?: string | null;
  fast_tracked?: boolean;
}

export interface DocView {
  _id: string;
  code: string;
  kind: DocKind;
  company_id: string;
  department_id: string | null;
  created_by: string;
  status: string;
  version: number;
  title: string;
  purpose: string | null;
  category_id: string | null;
  payee: { name: string; tax_code?: string | null; is_internal?: boolean; bank_name?: string | null; bank_account?: string | null };
  amount: DocAmount;
  source: { fund: 'bank' | 'cash'; account_id?: string | null; group_account_id?: string | null; group_managed?: boolean };
  target?: { company_id?: string | null; account_id?: string | null } | null;
  planned_date: string;
  business_date: string;
  priority: string;
  contract?: { code?: string | null; value?: DocAmount | null } | null;
  loan_id: string | null;
  budget?: { budget_id?: string | null; line_id?: string | null; in_plan?: boolean } | null;
  approval: { matrix_id?: string | null; matrix_version?: number; matrix_label?: string | null; steps: ApprovalStepDoc[] };
  evidence: { required: string[]; present: string[]; missing: string[] };
  rollover?: Record<string, unknown> | null;
  execution?: { paid_at?: string | null; bank_ref?: string | null; executed_by?: string | null; actual_amount_minor?: bigint | null } | null;
  sla_deadline?: Date | null;
  overdue?: boolean;
  closed_at?: Date | null;
  archived_at?: Date | null;
}


/** Bản hồ sơ ở tầng domain (BigInt đã chuẩn hoá) — workflow + side-effects cùng dùng. */
export interface DomainDoc {
  _id: string;
  code: string;
  kind: DocKind;
  company_id: string;
  target?: { company_id?: string | null; account_id?: string | null } | null;
  department_id: string | null;
  created_by: string;
  status: StatusKey;
  version: number;
  title: string;
  purpose?: string | null;
  category_id?: string | null;
  payee: { name: string; tax_code?: string | null; is_internal?: boolean; bank_name?: string | null; bank_account?: string | null };
  amount: { minor: bigint; currency: string; decimals: number };
  source: { fund: 'bank' | 'cash'; account_id?: string | null; group_account_id?: string | null; group_managed?: boolean };
  planned_date: string;
  business_date: string;
  priority: string;
  contract?: { code?: string | null; value?: { minor: bigint } | null } | null;
  loan_id?: string | null;
  budget?: { budget_id?: string | null; line_id?: string | null; in_plan?: boolean } | null;
  rollover?: Record<string, unknown> | null;
  approval: { matrix_id?: string | null; matrix_version?: number; matrix_label?: string | null; steps: StepRow[] };
  evidence: { required: string[]; present: string[]; missing: string[] };
  attachments?: { id: string; type: string; referenced_by?: string[] }[];
  execution?: { paid_at?: string | null; bank_ref?: string | null; executed_by?: string | null; actual_amount_minor?: bigint | null } | null;
  override?: { fast_tracked?: boolean; reason?: string | null } | null;
  history?: unknown[];
  processed_requests?: string[];
  sla_deadline?: Date | null;
  archived_at?: Date | null;
}


export interface StepRow {
  order: number;
  role: Role;
  user_id: string | null;
  state: 'waiting' | 'current' | 'done' | 'skipped' | 'rejected';
  delegated_from?: string | null;
  action?: string | null;
  decided_at?: Date | null;
  opinion?: string | null;
  reason?: string | null;
  sla_deadline?: Date | null;
  amount_at_decision?: string | null;
  fast_tracked?: boolean;
}


export interface ToneMap {
  text: string;
  bg: string;
  border: string;
}

export type { Role, Tone, DocKind, StatusKey };
