/**
 * Tạo PHIẾU NHÁP (thu / chi) cho nghiệp vụ "Trả nợ" của đối tác (v2/v2.md §5.2–5.3).
 *
 * Lưu ý: route `POST /documents` hiện đặt toàn bộ logic tạo phiếu NGAY TRONG handler
 * (routes/documents.ts), chưa có hàm domain dùng chung. Hàm này sao chép đúng các bước
 * PERSIST của route đó (mã nháp `DRAFT-…` để workflow cấp mã khi gửi duyệt, lịch sử `create`,
 * nhật ký `document.create`, sự kiện `voucher.created`, chứng từ bắt buộc, xoá cache) — không ghi
 * trường nào khác. Khi tách được hàm dùng chung từ route, thay thế ở đây.
 *
 * Không chuyển trạng thái: phiếu luôn `draft`; mọi bước duyệt đi qua workflow như bình thường.
 */

import { randomBytes } from 'node:crypto';
import { currencyDecimals, normalizePlannedDate, type DocKind } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { buildHistoryEntry, mirrorAudit } from '../audit/index.ts';
import { emitVoucherEvent, type VoucherEventSubject } from '../events/index.ts';
import { invalidateFor, requiredEvidenceFor } from '../side-effects.ts';

export interface DraftActor {
  user_id: string;
  name?: string | null;
  role?: string | null;
  department_id?: string | null;
}

export interface DraftVoucherInput {
  kind: 'income' | 'spend';
  company_id: string;
  /** đối tác theo ID — nguồn sự thật; KHÔNG sao chép tên / NH / STK vào phiếu (v2 §5.1) */
  partner_id: string;
  title: string;
  purpose: string;
  amount_minor: bigint;
  /** tài khoản tiền của công ty (đã kiểm tra thuộc công ty trước khi gọi) hoặc null */
  account_id: string | null;
  /** ngày nghiệp vụ YYYY-MM-DD */
  business_date: string;
  /** thời hạn YYYY-MM-DD hoặc YYYY-MM-DDTHH:mm */
  planned_date: string;
  note?: string | null;
  request_id?: string | null;
  ip?: string | null;
  actor: DraftActor;
  /** nguồn khởi tạo, ghi vào lịch sử (VD `partner_settle`) */
  via: string;
}

export interface CreatedDraft {
  _id: string;
  code: string;
  kind: 'income' | 'spend';
  company_id: string;
  partner_id: string;
  amount_minor: bigint;
  status: 'draft';
}

/** Mã nháp: tiền tố `DRAFT-` (workflow thay bằng mã thật khi gửi duyệt) + thời gian + ngẫu nhiên, tránh trùng khi tạo nhiều phiếu cùng lúc. */
export function draftCodeFor(now: Date = new Date()): string {
  return `DRAFT-${now.getTime().toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`;
}

export async function createDraftVoucher(input: DraftVoucherInput): Promise<CreatedDraft> {
  const now = new Date();
  const actor = { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null };
  const required = await requiredEvidenceFor({ kind: input.kind as DocKind, category_id: null, company_id: input.company_id });

  const created = await Models.Document.create({
    code: draftCodeFor(now),
    kind: input.kind,
    company_id: input.company_id,
    department_id: input.actor.department_id ?? null,
    created_by: input.actor.user_id,
    status: 'draft',
    version: 1,
    title: input.title,
    purpose: input.purpose,
    category_id: null,
    // [v2] không ghi payee.* — tên đối tác đọc qua partner_id (route POST /documents cũng không ghi)
    amount: { minor: input.amount_minor, currency: 'VND', decimals: currencyDecimals('VND') },
    fx: null,
    source: { fund: 'bank', account_id: input.account_id, group_account_id: null, group_managed: false },
    target: null,
    planned_date: normalizePlannedDate(input.planned_date),
    business_date: input.business_date,
    priority: 'normal',
    contract: { code: null, value: null, signed_at: null },
    loan_id: null,
    debt_code: null,
    partner_id: input.partner_id,
    tag_ids: [],
    options: { loan: null },
    transfer_target: null,
    origin: { kind: 'manual', run_id: null, rule_code: null },
    budget: { budget_id: null, line_id: null, in_plan: true },
    note: input.note ?? null,
    evidence: { required, present: [], missing: required },
    approval: { matrix_id: null, matrix_version: 0, matrix_label: null, steps: [] },
    processed_requests: input.request_id ? [input.request_id] : [],
    history: [
      buildHistoryEntry({
        action: 'create',
        actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
        to: 'draft',
        request_id: input.request_id ?? null,
        ip: input.ip ?? null,
        fields: { via: input.via },
        at: now,
      }),
    ],
    created_at: now,
    updated_at: now,
  } as never);

  const id = String(created._id);
  const code = String(created.code);
  await mirrorAudit({
    at: now,
    actor,
    action: 'document.create',
    subject: { type: input.kind, id, code },
    company_id: input.company_id,
    document_id: id,
    request_id: input.request_id ?? null,
    ip: input.ip ?? null,
  });
  await emitVoucherEvent(
    'voucher.created',
    created as unknown as VoucherEventSubject,
    { user_id: actor.user_id, name: actor.name, role: actor.role },
    { from: null, to: 'draft', action: 'create', via: input.via },
  );
  invalidateFor(input.company_id, input.actor.user_id);

  return {
    _id: id,
    code,
    kind: input.kind,
    company_id: input.company_id,
    partner_id: input.partner_id,
    amount_minor: input.amount_minor,
    status: 'draft',
  };
}
