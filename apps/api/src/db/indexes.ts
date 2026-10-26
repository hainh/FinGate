/**
 * Index tập trung (architecture §8.4) — apply bằng `pnpm db:indexes` và lúc boot.
 *
 * Trần 512 MB của Atlas M0: mỗi index mới phải có lý do + EXPLAIN đính kèm PR.
 */

import type { CreateIndexesOptions } from 'mongodb';
import { Models } from './models.ts';

type IndexDef = { key: Record<string, 1 | -1>; options?: CreateIndexesOptions };

export const INDEXES: Record<string, IndexDef[]> = {
  documents: [
    { key: { company_id: 1, kind: 1, status: 1, planned_date: -1 } },
    { key: { company_id: 1, created_at: -1 } },
    { key: { 'approval.steps.user_id': 1, 'approval.steps.state': 1 } },
    { key: { code: 1 }, options: { unique: true } },
    { key: { company_id: 1, 'contract.code': 1 } },
    { key: { status: 1, 'approval.steps.sla_deadline': 1 } },
    { key: { closed_at: 1, archived_at: 1 } },
    { key: { company_id: 1, 'target.company_id': 1 } },
    { key: { loan_id: 1, status: 1 } },
    // v2: tab "Phiếu thu/chi" của đối tác + lọc theo tag (v2 §5.3, §6.2)
    { key: { company_id: 1, partner_id: 1 } },
    { key: { company_id: 1, tag_ids: 1 } },
    // v2: người cho vay trên phiếu chi vay để chi (`options.loan.lender_partner_id`): chặn xoá đối tác và has_activity
    { key: { company_id: 1, 'options.loan.lender_partner_id': 1 } },
    // đối chiếu outbox sự kiện (domain/events reconcileTransitionEvents): phiếu đổi gần đây
    { key: { updated_at: -1 } },
  ],
  // ── v2 ──────────────────────────────────────────────────────────────
  /** Đối tác: tìm theo loại + tên; tìm theo STK (cảnh báo trùng); mã DT- unique toàn hệ thống. */
  partners: [
    { key: { company_id: 1, type: 1, name_key: 1 } },
    { key: { company_id: 1, account_number: 1 } },
    { key: { code: 1 }, options: { unique: true } },
  ],
  /** Tag chống trùng theo tên chuẩn hoá trong từng công ty (v2 §6.2). */
  tags: [{ key: { company_id: 1, name_key: 1 }, options: { unique: true } }],
  /**
   * Liên kết nghiệp vụ (v2 §14.2). Chỉ một liên kết HIỆU LỰC cho cùng cặp + quan hệ:
   * unique partial theo `status: 'active'` (gỡ rồi tạo lại được).
   */
  business_links: [
    { key: { from_type: 1, from_id: 1 } },
    { key: { to_type: 1, to_id: 1 } },
    { key: { from_id: 1, to_id: 1, relation: 1 }, options: { unique: true, partialFilterExpression: { status: 'active' } } },
  ],
  /**
   * Outbox sự kiện: tiến trình đọc `processed_at: null` theo `created_at`.
   * TTL 30 ngày trên `processed_at` (chỉ dọn bản ĐÃ xử lý; bản chưa xử lý có processed_at = null nên không bị xoá).
   */
  domain_events: [
    { key: { processed_at: 1, created_at: 1 } },
    { key: { processed_at: 1 }, options: { expireAfterSeconds: 30 * 86_400 } },
  ],
  /** Quy tắc: mã R1..R6 duy nhất. */
  automation_rules: [{ key: { code: 1 }, options: { unique: true } }],
  /** Lượt chạy: idem_key duy nhất (chống trùng khi retry / chạy song song); tra theo nguồn. */
  automation_runs: [
    { key: { idem_key: 1 }, options: { unique: true } },
    { key: { source_type: 1, source_id: 1 } },
    { key: { status: 1, claimed_at: 1 } }, // dọn lượt 'running' bị treo (sweepStaleRuns)
  ],
  /** Khoá chống ghi đúp theo request_id (đối tác). `_id` đã duy nhất; TTL 7 ngày dọn bản cũ. */
  request_claims: [{ key: { created_at: 1 }, options: { expireAfterSeconds: 7 * 86_400 } }],
  balances_daily: [{ key: { company_id: 1, account_id: 1, date: -1 }, options: { unique: true } }],
  cash_entries: [
    { key: { account_id: 1, date: 1 } },
    { key: { company_id: 1, date: 1 } },
    { key: { dedupe_key: 1 }, options: { unique: true } },
  ],
  bank_transactions: [{ key: { account_id: 1, value_date: 1, ref: 1 }, options: { unique: true } }],
  audit_log: [
    { key: { company_id: 1, at: -1 } },
    { key: { 'actor.user_id': 1, at: -1 } },
    { key: { 'subject.type': 1, 'subject.id': 1, at: -1 } },
  ],
  bank_debts: [
    { key: { company_id: 1, maturity_date: 1 } },
    { key: { company_id: 1, code: 1 }, options: { unique: true } },
    { key: { 'repayment_links.document_id': 1 } },
    { key: { auto_source_document_id: 1 } },
    { key: { company_id: 1, partner_id: 1 } }, // v2: tab "Nợ ngân hàng" của đối tác
  ],
  debt_vouchers: [
    { key: { company_id: 1, party_type: 1, side: 1, due_date: 1 } },
    { key: { company_id: 1, party_code: 1 } },
    { key: { 'document_links.document_id': 1 } },
    { key: { company_id: 1, partner_id: 1 } }, // v2: tab "Công nợ" của đối tác
  ],
  jobs: [
    { key: { state: 1, run_at: 1 } },
    { key: { dedupe_key: 1 }, options: { unique: true, partialFilterExpression: { dedupe_key: { $type: 'string' } } } },
  ],
  sessions: [
    { key: { user_id: 1 } },
    { key: { expires_at: 1 }, options: { expireAfterSeconds: 0 } },
    { key: { token_hash: 1 }, options: { unique: true } },
  ],
  notifications: [{ key: { user_id: 1, read_at: 1, created_at: -1 } }],
  assignments: [
    { key: { user_id: 1, status: 1 } },
    { key: { company_id: 1, role: 1 } },
  ],
  attachments: [
    { key: { document_id: 1, state: 1 } },
    { key: { company_id: 1, state: 1, created_at: 1 } },
    { key: { owner_type: 1, owner_id: 1, state: 1 } },
  ],
  alerts: [
    { key: { dedupe_key: 1 }, options: { unique: true, partialFilterExpression: { dedupe_key: { $type: 'string' } } } },
    { key: { type: 1, company_id: 1, enabled: 1 } },
    { key: { type: 1, created_at: -1 } },
  ],
  bank_accounts: [
    { key: { company_id: 1, status: 1 } },
    { key: { account_number: 1, company_id: 1 }, options: { unique: true } },
  ],
  approval_matrix: [{ key: { company_id: 1, doc_kind: 1, active: 1, effective_from: -1 } }],
  categories: [{ key: { doc_kind: 1, active: 1, order: 1 } }],
  budgets: [{ key: { company_id: 1, period: 1, period_start: -1 } }],
  delegations: [{ key: { to_user_id: 1, status: 1, valid_from: 1, valid_to: 1 } }],
  recurring_rules: [{ key: { company_id: 1, status: 1 } }],
  departments: [{ key: { company_id: 1, active: 1 } }],
  users: [{ key: { email: 1 }, options: { unique: true } }],
  settings: [{ key: { key: 1 }, options: { unique: true } }],
};

const COLLECTION_MODEL: Record<string, keyof typeof Models> = {
  documents: 'Document',
  balances_daily: 'BalanceDaily',
  cash_entries: 'CashEntry',
  bank_transactions: 'BankTransaction',
  audit_log: 'AuditLog',
  bank_debts: 'BankDebt',
  debt_vouchers: 'DebtVoucher',
  jobs: 'Job',
  sessions: 'Session',
  notifications: 'Notification',
  assignments: 'Assignment',
  attachments: 'Attachment',
  alerts: 'Alert',
  bank_accounts: 'BankAccount',
  approval_matrix: 'ApprovalMatrix',
  categories: 'Category',
  budgets: 'Budget',
  delegations: 'Delegation',
  recurring_rules: 'RecurringRule',
  departments: 'Department',
  users: 'User',
  settings: 'Setting',
  // v2
  partners: 'Partner',
  tags: 'Tag',
  business_links: 'BusinessLink',
  domain_events: 'DomainEvent',
  automation_rules: 'AutomationRule',
  automation_runs: 'AutomationRun',
  request_claims: 'RequestClaim',
};

/** Nhãn index cho log — đúng quy ước tên mặc định của MongoDB (`field_1_field2_-1`). */
function indexLabel(key: Record<string, 1 | -1>): string {
  return Object.entries(key)
    .map(([k, v]) => `${k}_${v}`)
    .join('_');
}

/**
 * Bảo đảm mọi index khai báo ở INDEXES có trong DB (idempotent: index đã có thì MongoDB bỏ qua).
 *
 * Gọi `collection.createIndex` của driver, KHÔNG gọi `Model.createIndexes(danhSách)`: Mongoose 9 bỏ qua
 * danh sách truyền vào và chỉ tạo index khai báo trong schema, nên trước đây mọi index ở đây bị bỏ qua
 * âm thầm (tag thiếu unique (company_id, name_key), documents thiếu index truy vấn, …).
 *
 * KHÔNG đặt `name` tuỳ ý: khi cùng khoá đã có index dưới tên khác (ví dụ index schema autoIndex tạo sẵn),
 * MongoDB từ chối với lỗi 85 (IndexOptionsConflict). Để tên mặc định thì hai bên trùng tên và không xung đột.
 *
 * Trả về số index đã bảo đảm có trong DB. Lỗi của từng index được ghi log và không ném ra (boot vẫn chạy).
 */
export async function applyIndexes(log: (msg: string) => void = console.log): Promise<number> {
  let applied = 0;
  for (const [collection, defs] of Object.entries(INDEXES)) {
    const modelName = COLLECTION_MODEL[collection];
    const model = modelName ? Models[modelName] : undefined;
    if (!model) {
      log(`  · bỏ qua ${collection} (không có model)`);
      continue;
    }
    let ok = 0;
    for (const def of defs) {
      try {
        await model.collection.createIndex(def.key, { background: true, ...def.options });
        ok++;
      } catch (err) {
        log(`  ! ${collection}.${indexLabel(def.key)}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    applied += ok;
    log(
      ok === defs.length
        ? `  ✓ ${collection} (${ok} index)`
        : `  ! ${collection}: ${ok}/${defs.length} index`,
    );
  }
  return applied;
}

/**
 * JSON Schema validator cho `documents.amount` — chặn dữ liệu rác từ import Excel (§8.4).
 * Chỉ áp cho amount vì ValidatorOptions làm chậm mọi insert ở M0.
 */
export async function applyValidators(log: (msg: string) => void = console.log): Promise<void> {
  const db = Models.Document.db;
  try {
  await db.createCollection('documents', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['code', 'kind', 'company_id', 'amount', 'status', 'version'],
        properties: {
          amount: {
            bsonType: 'object',
            required: ['minor', 'currency'],
            properties: {
              minor: { bsonType: ['long', 'int', 'decimal'] },
              currency: { bsonType: 'string', minLength: 3, maxLength: 3 },
              decimals: { bsonType: ['int', 'long'], minimum: 0, maximum: 4 },
            },
          },
          version: { bsonType: ['int', 'long'], minimum: 0 },
        },
      },
    },
    validationLevel: 'moderate',
    validationAction: 'error',
  });
  log('  ✓ validator cho documents.amount');
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 48) log('  · validator đã tồn tại');
    else throw err;
  }
}
