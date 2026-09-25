/**
 * Index tập trung (architecture §8.4) — apply bằng `pnpm db:indexes` và lúc boot.
 *
 * Trần 512 MB của Atlas M0: mỗi index mới phải có lý do + EXPLAIN đính kèm PR.
 */

import { Models } from './models.ts';

type IndexDef = { key: Record<string, 1 | -1>; options?: Record<string, unknown> };

const INDEXES: Record<string, IndexDef[]> = {
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
  ],
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
  loans: [
    { key: { company_id: 1, next_due_date: 1 } },
    { key: { company_id: 1, contract_code: 1 }, options: { unique: true } },
  ],
  debt_items: [{ key: { company_id: 1, kind: 1, due_date: 1 } }],
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
  loans: 'Loan',
  debt_items: 'DebtItem',
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
};

export async function applyIndexes(log: (msg: string) => void = console.log): Promise<number> {
  let applied = 0;
  for (const [collection, defs] of Object.entries(INDEXES)) {
    const modelName = COLLECTION_MODEL[collection];
    const model = modelName ? Models[modelName] : undefined;
    if (!model) {
      log(`  · bỏ qua ${collection} (không có model)`);
      continue;
    }
    for (const def of defs) {
      const name = Object.entries(def.key)
        .map(([k, v]) => `${k.replace(/\./g, '_')}_${v}`)
        .join('__');
      try {
        await (model as unknown as {
          createIndexes: (i: { key: Record<string, unknown>; name: string; background: boolean }[]) => Promise<unknown>;
        }).createIndexes([{ key: def.key, name, background: true, ...def.options }]);
        applied++;
      } catch (err) {
        log(`  ! ${collection}.${name}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    log(`  ✓ ${collection}`);
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
