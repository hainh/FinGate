/**
 * 0004 — chuyển đổi dữ liệu v1 → v2 (v2/v2.md §15: M1–M6) + đối chiếu M6.
 *
 * Phạm vi:
 *  M1  partners theo công ty từ công nợ KH/NCC, khoản vay (→ NH), phiếu thu/chi, khoản chi định kỳ;
 *      gộp theo (công ty, loại, tên chuẩn hoá) + STK. Loại suy ra (phiếu) → "cần rà soát".
 *  M2  gán partner_id: documents, debt_vouchers, bank_debts, recurring_rules. Không khớp (phiếu nội bộ,
 *      không có tên) → đối tác "Chưa xác định" của công ty + danh sách rà soát.
 *      Phiếu đã có liên kết được gán theo ĐỐI TÁC CỦA LIÊN KẾT (partnerMatch, §5.1/§11.2).
 *  M3  document_links → business_links(offset); repayment_links → (repayment);
 *      phiếu thu tự sinh từ chuyển nội bộ (auto_source_document_id, R1) → (internal_transfer,
 *      hoặc generated nếu cùng công ty: quan hệ generated bắt buộc cùng công ty, §11.2);
 *      khoản vay tự động (R2) → (disbursement) + origin {automation, R2}.
 *  M3b công nợ: direction = receivable nếu side = debit, payable nếu side = credit (chỉ KH/NCC).
 *  M4  khoản vay giữ trạng thái như cũ; không sinh pending_disbursement; bổ sung origin/disbursed_at.
 *  M5  công nợ employee (TK 334): không đụng, không sinh đối tác, không tạo liên kết.
 *  M6  đối chiếu: dư nợ/đã cấn trừ/đã trả theo từng khoản, tổng theo công ty, số dư tài khoản
 *      (Σ cash_entries) trước = sau, phủ đối tác, không đổi trạng thái khoản vay. Lệch ⇒ lỗi.
 *
 * Nguyên tắc:
 *  - Tương thích lùi (docs/04_architecture.md §12.4, "thêm trước, bỏ sau"): KHÔNG xoá trường v1
 *    (payee.*, party_*, bank_name/branch, document_links, repayment_links, auto_source_document_id,
 *    create_bank_debt, target, recurring.payee). Bỏ trường là migration 0005, sau khi M6 xanh trên
 *    production và code v1 không còn đọc (v2 §10).
 *  - Idempotent: chạy lại an toàn. Đối tác có `migration.key` (công ty|loại|tên chuẩn hoá|STK) và
 *    được tái sử dụng; liên kết không tạo lại nếu cặp (từ, đến, quan hệ) đã có ở bất kỳ trạng thái
 *    (không làm sống lại liên kết người dùng đã gỡ); trường đã có giá trị không bị ghi đè.
 *  - Không transaction (ADR-03). M6 lệch ⇒ ném lỗi ⇒ runner không ghi "đã áp dụng"; chạy lại được.
 *  - `--dry-run`: tính kế hoạch và đối chiếu trên trạng thái MÔ PHỎNG trong bộ nhớ; không ghi DB.
 *
 * Cách dùng:
 *   node db/migrations/0004-v2-data.js --dry-run   xem báo cáo (không ghi DB; ghi JSON vào data/migrations/)
 *   pnpm db:migrate                                 áp dụng thật (runner ghi nhận migration)
 *
 * Quy tắc chuẩn hoá (normalizeNameKey, bỏ khoảng trắng STK) hard-code như 0001 để migration là ảnh
 * chụp bất biến; khớp với packages/shared/src/contracts/common.ts tại thời điểm viết.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIGRATION_ID = '0004';
export const SUMMARY_SETTING_KEY = 'migration.0004.summary';
export const REVIEW_COLLECTION = 'migration_reviews';
export const UNASSIGNED_PARTNER_NAME = 'Chưa xác định';
const UNASSIGNED_PARTNER_TYPE = 'supplier';
const PARTNER_CODE_PREFIX = 'DT';
const LINKABLE_DOC_KINDS = ['spend', 'income'];
const NON_OUTSTANDING_LOAN_STATUSES = ['pending_disbursement', 'cancelled'];

/* ------------------------------------------------------------------ *
 * Tiện ích thuần
 * ------------------------------------------------------------------ */

/** Gộp khoảng trắng, NFC, trim (không đổi hoa/thường). */
export function cleanName(v) {
  return String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Khoá chống trùng tên — giống `normalizeNameKey` ở @fingate/shared. */
export function normalizeNameKey(v) {
  return cleanName(v).toLowerCase();
}

/** STK chuẩn hoá: bỏ khoảng trắng, dấu chấm, gạch ngang; viết hoa. Rỗng ⇒ null. */
export function normalizeAccount(v) {
  const s = cleanName(v).replace(/[\s.\-]/g, '').toUpperCase();
  return s.length ? s : null;
}

/** Số tiền từ BSON (BigInt / Long / number / chuỗi) → BigInt. Không hợp lệ ⇒ 0n. */
export function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (v === null || v === undefined || v === '') return 0n;
  if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
  if (typeof v === 'string') return /^-?\d+$/.test(v.trim()) ? BigInt(v.trim()) : 0n;
  if (typeof v === 'object') {
    const s = String(v);
    if (/^-?\d+$/.test(s)) return BigInt(s);
  }
  return 0n;
}

const BANK_NAME_RE =
  /ngân hàng|bidv|vietcombank|vietinbank|techcombank|agribank|sacombank|vpbank|tpbank|hdbank|eximbank|seabank|lienviet|oceanbank|pvcombank|namabank|mb bank|\bvcb\b|\bctg\b|\btcb\b|\bacb\b|\bshb\b|\bocb\b|\bmsb\b|\bscb\b|\bvib\b/i;

/** Tên có vẻ là ngân hàng (chỉ dùng khi suy loại từ phiếu — đánh dấu cần rà soát). */
export function looksLikeBank(name) {
  return BANK_NAME_RE.test(cleanName(name));
}

/** Nhãn "Mã công ty - Tên NH/quỹ - STK" trỏ tới công ty trong hệ thống ⇒ chuyển nội bộ (R1 v1). */
export function isInternalLabel(label, companyCodes) {
  const parts = cleanName(label).split(' - ');
  if (parts.length !== 3 || parts.some((p) => !p.trim())) return false;
  return companyCodes.has(parts[0].trim().toUpperCase());
}

export function dirFromSide(side) {
  return side === 'debit' ? 'receivable' : 'payable';
}

const allocationOf = (l) => (l.split ? l.split.principal + l.split.interest + l.split.fee : (l.amount ?? 0n));
const principalPartOf = (l) => (l.split ? l.split.principal : (l.amount ?? 0n));
const positive = (x) => (x > 0n ? x : 0n);
const linkKeyOf = (l) => `${l.from}|${l.to}|${l.relation}`;

/* ------------------------------------------------------------------ *
 * Nạp dữ liệu (chuẩn hoá về cấu trúc gọn; giữ `raw` để ghi lại)
 * ------------------------------------------------------------------ */

const str = (v) => (v === null || v === undefined ? null : String(v));

export async function loadSnapshot(conn) {
  const col = (name) => conn.collection(name);
  const [companies, counterparties, partners, docs, debts, loans, recurring, links, cash] = await Promise.all([
    col('companies').find({}).toArray(),
    col('counterparties').find({}).toArray(),
    col('partners').find({}).toArray(),
    col('documents').find({}).toArray(),
    col('debt_vouchers').find({}).toArray(),
    col('bank_debts').find({}).toArray(),
    col('recurring_rules').find({}).toArray(),
    col('business_links').find({}).toArray(),
    col('cash_entries').find({}).toArray(),
  ]);

  const S = {
    companies: new Map(),
    counterparties: new Map(),
    partners: new Map(),
    docs: new Map(),
    debts: new Map(),
    loans: new Map(),
    recurring: new Map(),
    links: [],
    cash: new Map(),
  };

  for (const r of companies) {
    S.companies.set(str(r._id), { id: str(r._id), code: cleanName(r.code).toUpperCase(), name: cleanName(r.name) });
  }
  for (const r of counterparties) {
    S.counterparties.set(str(r._id), {
      id: str(r._id),
      name: cleanName(r.name),
      banks: (r.banks ?? []).map((b) => ({ bank_name: cleanName(b.bank_name), account: normalizeAccount(b.account_number) })),
    });
  }
  for (const r of partners) {
    S.partners.set(str(r._id), {
      id: str(r._id),
      raw: r._id,
      company: str(r.company_id),
      type: r.type,
      name: cleanName(r.name),
      nk: r.name_key ?? normalizeNameKey(r.name),
      account: normalizeAccount(r.account_number),
      code: r.code ?? null,
      migKey: r.migration?.key ?? null,
    });
  }
  for (const r of docs) {
    S.docs.set(str(r._id), {
      id: str(r._id),
      raw: r._id,
      company: str(r.company_id),
      companyRaw: r.company_id,
      kind: r.kind,
      status: r.status,
      payeeName: cleanName(r.payee?.name),
      payeeTax: r.payee?.tax_code ?? null,
      payeeCp: str(r.payee?.counterparty_id),
      payeeIsInternal: r.payee?.is_internal === true,
      payeeBankName: cleanName(r.payee?.bank_name),
      payeeBankAccount: normalizeAccount(r.payee?.bank_account),
      amount: toBig(r.amount?.minor),
      partner: str(r.partner_id),
      loan: str(r.loan_id),
      createBankDebt: r.create_bank_debt === true,
      autoSrc: str(r.auto_source_document_id),
      autoCreated: r.auto_created === true,
      origin: r.origin ?? null,
    });
  }
  for (const r of debts) {
    S.debts.set(str(r._id), {
      id: str(r._id),
      raw: r._id,
      company: str(r.company_id),
      companyRaw: r.company_id,
      party_type: r.party_type,
      party_name: cleanName(r.party_name),
      party_tax: r.party_tax_code ?? null,
      party_bank_name: cleanName(r.party_bank_name),
      party_bank_account: normalizeAccount(r.party_bank_account),
      cp: str(r.counterparty_id),
      partner: str(r.partner_id),
      direction: r.direction ?? null,
      side: r.side,
      value: toBig(r.value_minor),
      links: (r.document_links ?? []).map((l) => ({
        doc: str(l.document_id),
        amount: toBig(l.amount_minor),
        raw_linked_by: l.linked_by ?? null,
        linked_at: l.linked_at ?? null,
        note: l.note ?? null,
      })),
    });
  }
  for (const r of loans) {
    S.loans.set(str(r._id), {
      id: str(r._id),
      raw: r._id,
      company: str(r.company_id),
      companyRaw: r.company_id,
      bank_name: cleanName(r.bank_name),
      branch: cleanName(r.branch),
      principal: toBig(r.principal_minor),
      status: r.status ?? null,
      partner: str(r.partner_id),
      origin: r.origin ?? null,
      disbursed_at: r.disbursed_at ?? null,
      created_at: r.created_at ?? null,
      autoSrc: str(r.auto_source_document_id),
      repayments: (r.repayment_links ?? []).map((l) => ({ doc: str(l.document_id), amount: toBig(l.amount_minor), raw_linked_by: l.linked_by ?? null, linked_at: l.linked_at ?? null, note: l.note ?? null })),
    });
  }
  for (const r of recurring) {
    S.recurring.set(str(r._id), {
      id: str(r._id),
      raw: r._id,
      company: str(r.company_id),
      companyRaw: r.company_id,
      payee_name: cleanName(r.payee?.name),
      payee_tax: r.payee?.tax_code ?? null,
      partner: str(r.partner_id),
    });
  }
  S.links = links.map((r) => ({
    id: str(r._id),
    company: str(r.company_id),
    relation: r.relation,
    from_type: r.from_type,
    from: str(r.from_id),
    to_type: r.to_type,
    to: str(r.to_id),
    amount: r.amount_minor === null || r.amount_minor === undefined ? null : toBig(r.amount_minor),
    split: r.split ? { principal: toBig(r.split.principal), interest: toBig(r.split.interest), fee: toBig(r.split.fee) } : null,
    status: r.status ?? 'active',
  }));
  for (const e of cash) {
    const acc = str(e.account_id);
    const cur = S.cash.get(acc) ?? { in: 0n, out: 0n };
    const amt = toBig(e.amount_minor);
    if (e.direction === 'in') cur.in += amt;
    else cur.out += amt;
    S.cash.set(acc, cur);
  }
  return S;
}

/* ------------------------------------------------------------------ *
 * Chỉ tiêu (giống domain/links: chỉ tính phiếu đã paid; khoản chờ/huỷ dư nợ = 0)
 * ------------------------------------------------------------------ */

/** Số đã cấn trừ / đã trả / dư nợ / tổng theo công ty từ một tập liên kết (chỉ active). */
export function metricsOf(S, links) {
  const paid = (docId) => S.docs.get(docId)?.status === 'paid';
  const applied = new Map();
  const repaid = new Map();
  for (const l of links) {
    if (l.status !== 'active' || !paid(l.from)) continue;
    if (l.relation === 'offset' && l.to_type === 'debt_voucher') {
      applied.set(l.to, (applied.get(l.to) ?? 0n) + allocationOf(l));
    } else if (l.relation === 'repayment' && l.to_type === 'bank_debt') {
      repaid.set(l.to, (repaid.get(l.to) ?? 0n) + principalPartOf(l));
    }
  }
  const debt = new Map();
  const remaining = new Map();
  for (const d of S.debts.values()) {
    if (d.party_type === 'employee') continue;
    const a = applied.get(d.id) ?? 0n;
    const rem = positive(d.value - a);
    const dir = d.direction ?? dirFromSide(d.side);
    debt.set(d.id, { applied: a, rem });
    const k = `${d.company}|${dir}`;
    remaining.set(k, (remaining.get(k) ?? 0n) + rem);
  }
  const loans = new Map();
  const outstandingByCompany = new Map();
  for (const l of S.loans.values()) {
    const r = repaid.get(l.id) ?? 0n;
    const out = NON_OUTSTANDING_LOAN_STATUSES.includes(l.status) ? 0n : positive(l.principal - r);
    loans.set(l.id, { repaid: r, outstanding: out });
    outstandingByCompany.set(l.company, (outstandingByCompany.get(l.company) ?? 0n) + out);
  }
  return { debt, loans, remaining, outstandingByCompany };
}

const sumBig = (m) => [...m.values()].reduce((a, b) => a + b, 0n);

/* ------------------------------------------------------------------ *
 * Lập kế hoạch (thuần — không chạm DB)
 * ------------------------------------------------------------------ */

export function buildPlan(S, { OID, now }) {
  const codeSet = new Set([...S.companies.values()].map((c) => c.code).filter(Boolean));
  const buckets = new Map();
  const reviews = new Map();
  const exceptions = [];
  const counts = { existingLinks: 0, duplicateLinks: 0 };

  const addReview = (collection, refId, company, reason, label) => {
    const key = `${collection}|${refId}|${reason}`;
    if (!reviews.has(key)) reviews.set(key, { collection, ref_id: refId, company, reason, label });
  };
  const addException = (reason, relation, collection, refId, amount) => exceptions.push({ reason, relation, collection, ref_id: refId, amount });

  /* ---- M1: ứng viên đối tác ------------------------------------- */
  const addCand = (c) => {
    const nk = normalizeNameKey(c.name);
    const bkey = `${c.company}|${c.type}|${nk}`;
    let b = buckets.get(bkey);
    if (!b) {
      b = {
        company: c.company,
        companyRaw: c.companyRaw,
        type: c.type,
        nk,
        display: c.name,
        prio: c.prio,
        bank_name: null,
        tax_code: null,
        accounts: new Set(),
        explicit: false,
        cands: [],
      };
      buckets.set(bkey, b);
    }
    if (c.prio < b.prio) {
      b.display = c.name;
      b.prio = c.prio;
    }
    if (c.account) b.accounts.add(c.account);
    if (c.bank_name && !b.bank_name) b.bank_name = c.bank_name;
    if (c.tax_code && !b.tax_code) b.tax_code = c.tax_code;
    if (c.explicit) b.explicit = true;
    const cand = { bucket: b, account: c.account ?? null, ref: c.ref, collection: c.collection, unassigned: c.unassigned === true, reason: c.reason ?? null };
    b.cands.push(cand);
    return cand;
  };

  const UNASSIGNED = (company, companyRaw) => ({
    company,
    companyRaw,
    type: UNASSIGNED_PARTNER_TYPE,
    name: UNASSIGNED_PARTNER_NAME,
    prio: 9,
    account: null,
    explicit: false,
    unassigned: true,
  });

  const debtCand = new Map();
  const loanCand = new Map();
  const recCand = new Map();
  const docCand = new Map();

  for (const d of S.debts.values()) {
    if (d.party_type === 'employee') continue; // M5: không sinh đối tác
    const cp = d.cp ? S.counterparties.get(d.cp) : null;
    const name = d.party_name || cleanName(cp?.name) || UNASSIGNED_PARTNER_NAME;
    const bank0 = cp?.banks?.[0];
    debtCand.set(
      d.id,
      addCand({
        company: d.company,
        companyRaw: d.companyRaw,
        type: d.party_type,
        name,
        prio: 0,
        account: d.party_bank_account ?? bank0?.account ?? null,
        bank_name: d.party_bank_name || bank0?.bank_name || null,
        tax_code: d.party_tax,
        explicit: true,
        collection: 'debt_vouchers',
        ref: d.id,
      }),
    );
  }
  for (const l of S.loans.values()) {
    const name = l.branch ? `${l.bank_name} – ${l.branch}` : l.bank_name || UNASSIGNED_PARTNER_NAME;
    loanCand.set(
      l.id,
      addCand({
        company: l.company,
        companyRaw: l.companyRaw,
        type: 'bank',
        name,
        prio: 1,
        account: null,
        bank_name: l.bank_name || null,
        explicit: true,
        collection: 'bank_debts',
        ref: l.id,
      }),
    );
  }

  /* ---- M3: liên kết v1 → v2 (xác định đối tác "theo liên kết" trước) ---- */
  const overrides = new Map(); // docId → {via, cand}
  const setOverride = (docId, via, cand) => {
    if (cand && !overrides.has(docId)) overrides.set(docId, { via, cand });
  };
  const derived = []; // mọi liên kết suy ra từ v1 (kể cả đã có) — để đối chiếu M6
  const newLinks = [];
  const seenKeys = new Set();
  const preKeys = new Set(S.links.map(linkKeyOf));
  const autoDocOrigin = new Map(); // docId → origin R1
  const autoLoanOrigin = new Map(); // loanId → {origin, disbursed_at}

  const pushLink = (spec) => {
    const key = `${spec.from}|${spec.to}|${spec.relation}`;
    if (seenKeys.has(key)) {
      counts.duplicateLinks++;
      return;
    }
    seenKeys.add(key);
    const shape = {
      relation: spec.relation,
      from_type: spec.fromType,
      from: spec.from,
      to_type: spec.toType,
      to: spec.to,
      amount: spec.amount ?? null,
      split: null,
      status: 'active',
    };
    derived.push(shape);
    if (preKeys.has(key)) {
      counts.existingLinks++;
      return;
    }
    newLinks.push({
      ...shape,
      company_raw: spec.companyRaw,
      from_raw: spec.fromRaw,
      to_raw: spec.toRaw,
      origin: spec.origin ?? 'manual',
      rule_code: spec.rule ?? null,
      note: spec.note ?? null,
      created_by: spec.createdBy ?? null,
      created_at: spec.createdAt ?? now,
    });
  };

  // v1 links are only migrated from documents that exist and belong to the same company.
  const v1Raw = []; // mọi liên kết v1 offset/repayment (kể cả ngoại lệ) — để báo cáo "trước"

  // repayment: phiếu chi → khoản vay NH (partnerMatch: phải cùng đối tác NH)
  for (const l of S.loans.values()) {
    for (const r of l.repayments) {
      v1Raw.push({ relation: 'repayment', from: r.doc, to: l.id, amount: r.amount, to_type: 'bank_debt', from_type: 'document', status: 'active', split: null });
      const doc = r.doc ? S.docs.get(r.doc) : null;
      if (!doc) {
        addException('missing_document', 'repayment', 'bank_debts', l.id, r.amount);
        continue;
      }
      if (doc.company !== l.company || doc.kind !== 'spend' || r.amount <= 0n) {
        addException('invalid_repayment', 'repayment', 'bank_debts', l.id, r.amount);
        continue;
      }
      pushLink({ relation: 'repayment', from: doc.id, fromType: 'document', to: l.id, toType: 'bank_debt', amount: r.amount, companyRaw: l.companyRaw, fromRaw: doc.raw, toRaw: l.raw, createdBy: r.raw_linked_by, createdAt: r.linked_at });
      setOverride(doc.id, 'repayment', loanCand.get(l.id));
    }
  }

  // disbursement (R2 v1): phiếu thu đi vay → khoản vay tự động; origin = automation/R2.
  // Phiếu thu có cờ create_bank_debt bị TẮT khi migrate: v1 có thể đã tự tạo khoản vay từ cờ đó, nên không
  // sinh liên kết giải ngân hay nhãn tự động R2 nữa — khoản vay giữ nguyên như dữ liệu v1 thường.
  for (const l of S.loans.values()) {
    if (!l.autoSrc) continue;
    const src = S.docs.get(l.autoSrc);
    if (!src) {
      addException('missing_source_document', 'disbursement', 'bank_debts', l.id, l.principal);
      continue;
    }
    if (src.createBankDebt) continue;
    if (src.company !== l.company || src.kind !== 'income' || l.principal <= 0n) {
      addException('invalid_disbursement', 'disbursement', 'bank_debts', l.id, l.principal);
      continue;
    }
    const amount = l.principal < src.amount ? l.principal : src.amount;
    pushLink({ relation: 'disbursement', from: src.id, fromType: 'document', to: l.id, toType: 'bank_debt', amount, companyRaw: l.companyRaw, fromRaw: src.raw, toRaw: l.raw, origin: 'automation', rule: 'R2', createdAt: l.created_at });
    setOverride(src.id, 'disbursement', loanCand.get(l.id));
    autoLoanOrigin.set(l.id, { origin: { kind: 'automation', run_id: null, rule_code: 'R2' }, disbursed_at: l.created_at });
  }

  // internal (R1 v1): phiếu thu nội bộ tự sinh từ phiếu chi (auto_source_document_id)
  for (const d of S.docs.values()) {
    if (!d.autoSrc) continue;
    const src = S.docs.get(d.autoSrc);
    if (!src) {
      addException('missing_source_document', 'internal_transfer', 'documents', d.id, d.amount);
      continue;
    }
    const sameCompany = src.company === d.company;
    const relation = sameCompany ? 'generated' : 'internal_transfer';
    if (src.kind !== 'spend' || (!sameCompany && d.kind !== 'income') || d.amount <= 0n) {
      addException('invalid_internal_transfer', relation, 'documents', d.id, d.amount);
      continue;
    }
    pushLink({ relation, from: src.id, fromType: 'document', to: d.id, toType: 'document', amount: null, companyRaw: d.companyRaw, fromRaw: src.raw, toRaw: d.raw, origin: 'automation', rule: 'R1' });
    if (!d.origin || d.origin.kind !== 'automation') autoDocOrigin.set(d.id, { kind: 'automation', run_id: null, rule_code: 'R1' });
  }

  // offset: công nợ KH/NCC ← phiếu thu/chi đã cấn trừ (M3); employee: không đụng (M5)
  for (const d of S.debts.values()) {
    for (const l of d.links) {
      v1Raw.push({ relation: 'offset', from: l.doc, to: d.id, amount: l.amount, to_type: 'debt_voucher', from_type: 'document', status: 'active', split: null });
      if (d.party_type === 'employee') {
        addException('employee_debt_untouched', 'offset', 'debt_vouchers', d.id, l.amount);
        continue;
      }
      const doc = l.doc ? S.docs.get(l.doc) : null;
      if (!doc) {
        addException('missing_document', 'offset', 'debt_vouchers', d.id, l.amount);
        continue;
      }
      if (doc.company !== d.company || !LINKABLE_DOC_KINDS.includes(doc.kind) || l.amount <= 0n) {
        addException('invalid_offset', 'offset', 'debt_vouchers', d.id, l.amount);
        continue;
      }
      pushLink({ relation: 'offset', from: doc.id, fromType: 'document', to: d.id, toType: 'debt_voucher', amount: l.amount, companyRaw: d.companyRaw, fromRaw: doc.raw, toRaw: d.raw, createdBy: l.raw_linked_by, createdAt: l.linked_at, note: l.note });
      setOverride(doc.id, 'offset', debtCand.get(d.id));
    }
  }
  // phiếu gắn khoản vay (rollover/đảo hạn…) ⇒ đối tác = ngân hàng của khoản vay (ưu tiên thấp nhất)
  for (const d of S.docs.values()) {
    const loan = d.loan ? S.loans.get(d.loan) : null;
    // chỉ theo khoản vay cùng công ty (đối tác phải cùng công ty với phiếu)
    if (loan && loan.company === d.company) setOverride(d.id, 'loan_ref', loanCand.get(loan.id));
  }

  /* ---- M1/M2: ứng viên từ phiếu, khoản chi định kỳ ------------- */
  const codes = codeSet;
  const docSpec = (d) => {
    if (d.kind === 'internal' || d.payeeIsInternal || d.autoCreated || d.autoSrc || isInternalLabel(d.payeeName, codes)) {
      return { unassigned: true, reason: 'internal_transfer' };
    }
    const cp = d.payeeCp ? S.counterparties.get(d.payeeCp) : null;
    const name = d.payeeName || cleanName(cp?.name);
    if (!name) return { unassigned: true, reason: 'no_payee' };
    const bank0 = cp?.banks?.[0];
    let type = 'supplier';
    // Cờ v1 create_bank_debt KHÔNG suy loại đối tác: người trả tiền trên phiếu thu là KH/NCC, không phải NH.
    if (d.kind === 'rollover' || looksLikeBank(name)) type = 'bank';
    else if (d.kind === 'income') type = 'customer';
    return {
      unassigned: false,
      type,
      name,
      account: d.payeeBankAccount ?? bank0?.account ?? null,
      bank_name: d.payeeBankName || bank0?.bank_name || null,
      tax_code: d.payeeTax ?? null,
    };
  };

  for (const d of S.docs.values()) {
    if (d.partner || overrides.has(d.id)) continue; // đã có đối tác hoặc sẽ theo liên kết
    const spec = docSpec(d);
    if (spec.unassigned) {
      docCand.set(d.id, addCand({ ...UNASSIGNED(d.company, d.companyRaw), collection: 'documents', ref: d.id, unassigned: true, reason: spec.reason }));
      addReview('documents', d.id, d.company, `unassigned_${spec.reason}`, d.payeeName || '(không tên)');
    } else {
      docCand.set(
        d.id,
        addCand({
          company: d.company,
          companyRaw: d.companyRaw,
          type: spec.type,
          name: spec.name,
          prio: 2,
          account: spec.account,
          bank_name: spec.bank_name,
          tax_code: spec.tax_code,
          explicit: false,
          collection: 'documents',
          ref: d.id,
        }),
      );
    }
  }
  for (const r of S.recurring.values()) {
    if (r.partner) continue;
    if (!r.payee_name) {
      recCand.set(r.id, addCand({ ...UNASSIGNED(r.company, r.companyRaw), collection: 'recurring_rules', ref: r.id, reason: 'no_payee' }));
      addReview('recurring_rules', r.id, r.company, 'unassigned_no_payee', r.id);
    } else {
      recCand.set(
        r.id,
        addCand({
          company: r.company,
          companyRaw: r.companyRaw,
          type: looksLikeBank(r.payee_name) ? 'bank' : 'supplier',
          name: r.payee_name,
          prio: 3,
          account: null,
          tax_code: r.payee_tax,
          explicit: false,
          collection: 'recurring_rules',
          ref: r.id,
        }),
      );
    }
  }

  /* ---- Phân giải khoá đối tác từng ứng viên ---------------------- */
  const entries = new Map(); // key → entry
  for (const b of buckets.values()) {
    const accs = [...b.accounts].sort();
    for (const c of b.cands) {
      let account = null;
      let ambiguous = false;
      if (accs.length) {
        if (c.account && b.accounts.has(c.account)) account = c.account;
        else {
          account = accs[0];
          ambiguous = accs.length > 1;
        }
      }
      c.key = `${b.company}|${b.type}|${b.nk}|${account ?? ''}`;
      c.resolvedAccount = account;
      if (ambiguous && c.collection) addReview(c.collection, c.ref, b.company, 'account_ambiguous', b.display);
      let e = entries.get(c.key);
      if (!e) {
        e = {
          key: c.key,
          company: b.company,
          companyRaw: b.companyRaw,
          type: b.type,
          nk: b.nk,
          name: b.display,
          account,
          bank_name: b.bank_name,
          tax_code: b.tax_code,
          singleAccount: accs.length <= 1,
          inferred: !b.explicit,
          unassigned: c.unassigned,
          refs: 0,
        };
        entries.set(c.key, e);
      }
      e.refs++;
      if (!b.explicit) e.inferred = true;
      else e.inferred = false;
    }
  }

  /* ---- Khớp đối tác đã có (chạy lại / đối tác tạo tay) ----------- */
  const existingByMig = new Map();
  const existingByKey = new Map();
  const existingByBase = new Map();
  for (const p of S.partners.values()) {
    if (p.migKey) existingByMig.set(p.migKey, p);
    existingByKey.set(`${p.company}|${p.type}|${p.nk}|${p.account ?? ''}`, p);
    const base = `${p.company}|${p.type}|${p.nk}`;
    existingByBase.set(base, [...(existingByBase.get(base) ?? []), p]);
  }
  const partnerNew = [];
  for (const e of entries.values()) {
    const base = `${e.company}|${e.type}|${e.nk}`;
    let ex = existingByMig.get(e.key) ?? existingByKey.get(e.key) ?? null;
    if (!ex && e.account && e.singleAccount) {
      ex = (existingByBase.get(base) ?? []).find((p) => !p.account) ?? null;
    }
    e.existing = ex;
    e.raw = ex ? ex.raw : new OID();
    e.id = String(e.raw);
    if (!ex) partnerNew.push(e);
    if (e.inferred) addReview('partners', e.id, e.company, 'inferred_type', e.name);
  }

  const entryOf = (cand) => (cand ? entries.get(cand.key) : null);

  /* ---- M2: gán partner_id ------------------------------------- */
  const docAssign = [];
  let overridePartnerChanged = 0;
  for (const d of S.docs.values()) {
    if (d.partner) continue;
    const ov = overrides.get(d.id);
    const cand = ov ? ov.cand : docCand.get(d.id);
    const e = entryOf(cand);
    if (!e) continue;
    docAssign.push({ id: d.id, raw: d.raw, partnerRaw: e.raw, partnerId: e.id, partnerName: e.name, via: ov ? ov.via : null });
    if (ov) {
      if (normalizeNameKey(d.payeeName) && normalizeNameKey(d.payeeName) !== e.nk) {
        overridePartnerChanged++;
        addReview('documents', d.id, d.company, `link_partner_${ov.via}`, `Đổi đối tác theo liên kết (${ov.via}); tên v1: ${d.payeeName}`);
      }
    } else if (cand?.unassigned) {
      // đã ghi nhận ở bước ứng viên
    }
  }
  const debtAssign = [];
  for (const d of S.debts.values()) {
    if (d.party_type === 'employee') continue;
    const e = entryOf(debtCand.get(d.id));
    const change = {};
    if (!d.partner && e) change.partner = e;
    if (!d.direction) change.direction = dirFromSide(d.side);
    if (Object.keys(change).length) debtAssign.push({ id: d.id, raw: d.raw, partnerRaw: change.partner?.raw ?? null, partnerId: change.partner?.id ?? null, direction: change.direction ?? null });
  }
  const loanAssign = [];
  for (const l of S.loans.values()) {
    const e = entryOf(loanCand.get(l.id));
    const change = {};
    if (!l.partner && e) change.partner = e;
    const auto = autoLoanOrigin.get(l.id);
    if (auto && (!l.origin || l.origin.kind !== 'automation')) change.origin = auto.origin;
    if (auto && !l.disbursed_at && auto.disbursed_at) change.disbursed_at = auto.disbursed_at;
    if (!l.status) change.status = 'active';
    if (!l.origin && !auto) change.origin = { kind: 'manual', run_id: null, rule_code: null };
    if (Object.keys(change).length) {
      loanAssign.push({ id: l.id, raw: l.raw, partnerRaw: change.partner?.raw ?? null, partnerId: change.partner?.id ?? null, origin: change.origin ?? null, disbursed_at: change.disbursed_at ?? null, status: change.status ?? null });
    }
  }
  const recAssign = [];
  for (const r of S.recurring.values()) {
    if (r.partner) continue;
    const e = entryOf(recCand.get(r.id));
    if (e) recAssign.push({ id: r.id, raw: r.raw, partnerRaw: e.raw, partnerId: e.id });
  }
  const originAssign = [];
  for (const [id, origin] of autoDocOrigin) {
    const d = S.docs.get(id);
    originAssign.push({ id, raw: d.raw, origin });
  }

  /* ---- Ghi nhận ngoại lệ & báo cáo M1 -------------------------- */
  const partnerByType = { bank: 0, customer: 0, supplier: 0 };
  for (const e of partnerNew) partnerByType[e.type] = (partnerByType[e.type] ?? 0) + 1;
  const unassignedNew = partnerNew.filter((e) => e.nk === normalizeNameKey(UNASSIGNED_PARTNER_NAME)).length;

  return {
    S,
    partnerEntries: entries,
    partnerNew,
    partnerByType,
    unassignedNew,
    docAssign,
    debtAssign,
    loanAssign,
    recAssign,
    originAssign,
    newLinks,
    derived,
    v1Raw,
    reviews: [...reviews.values()],
    exceptions,
    counts: { ...counts, overridePartnerChanged },
  };
}

/* ------------------------------------------------------------------ *
 * Trạng thái sau (mô phỏng cho dry-run)
 * ------------------------------------------------------------------ */

export function simulatePost(pre, plan) {
  const post = {
    ...pre,
    companies: pre.companies,
    counterparties: pre.counterparties,
    partners: new Map(pre.partners),
    docs: new Map(pre.docs),
    debts: new Map(pre.debts),
    loans: new Map(pre.loans),
    recurring: new Map(pre.recurring),
    links: [...pre.links],
    cash: pre.cash,
  };
  for (const e of plan.partnerNew) {
    post.partners.set(e.id, { id: e.id, raw: e.raw, company: e.company, type: e.type, name: e.name, nk: e.nk, account: e.account, code: e.code ?? null, migKey: e.key });
  }
  for (const a of plan.docAssign) post.docs.set(a.id, { ...post.docs.get(a.id), partner: a.partnerId });
  for (const a of plan.originAssign) post.docs.set(a.id, { ...post.docs.get(a.id), origin: a.origin });
  for (const a of plan.debtAssign) post.debts.set(a.id, { ...post.debts.get(a.id), partner: a.partnerId ?? post.debts.get(a.id).partner, direction: a.direction ?? post.debts.get(a.id).direction });
  for (const a of plan.loanAssign) post.loans.set(a.id, { ...post.loans.get(a.id), partner: a.partnerId ?? post.loans.get(a.id).partner, status: a.status ?? post.loans.get(a.id).status, origin: a.origin ?? post.loans.get(a.id).origin });
  for (const a of plan.recAssign) post.recurring.set(a.id, { ...post.recurring.get(a.id), partner: a.partnerId });
  for (const l of plan.newLinks) {
    post.links.push({ id: null, company: null, relation: l.relation, from_type: l.from_type, from: l.from, to_type: l.to_type, to: l.to, amount: l.amount, split: null, status: 'active' });
  }
  return post;
}

/* ------------------------------------------------------------------ *
 * M6 — đối chiếu
 * ------------------------------------------------------------------ */

export function verify(pre, post, plan) {
  const checks = [];
  const mismatches = [];
  const check = (name, expected, actual, detail = '') => {
    const ok = String(expected) === String(actual);
    checks.push({ name, expected: String(expected), actual: String(actual), ok });
    if (!ok) mismatches.push(`${name}: kỳ vọng ${expected}, thực tế ${actual}${detail ? ` (${detail})` : ''}`);
  };
  const validPartner = (state, partnerId, companyId) => {
    if (!partnerId) return false;
    const p = state.partners.get(partnerId);
    return Boolean(p) && p.company === companyId;
  };

  // M2 — phủ đối tác
  let docsNoPartner = 0;
  for (const d of post.docs.values()) if (!validPartner(post, d.partner, d.company)) docsNoPartner++;
  check('documents_partner_coverage', 0, docsNoPartner);

  let debtMissing = 0;
  let debtTypeBad = 0;
  let debtDirBad = 0;
  let employeeTouched = 0;
  for (const d of post.debts.values()) {
    const p0 = pre.debts.get(d.id);
    if (d.party_type === 'employee') {
      if (p0 && (p0.partner !== d.partner || p0.direction !== d.direction)) employeeTouched++;
      continue;
    }
    if (!validPartner(post, d.partner, d.company)) debtMissing++;
    else if (post.partners.get(d.partner).type !== d.party_type) debtTypeBad++;
    // M3b chỉ áp cho khoản chưa có hướng; hướng người dùng đã chọn ở v2 không bị coi là lệch
    if (!p0?.direction && d.direction !== dirFromSide(d.side)) debtDirBad++;
  }
  check('debts_partner_coverage', 0, debtMissing);
  check('debts_partner_type_match', 0, debtTypeBad);
  check('debts_direction_m3b', 0, debtDirBad);
  check('employee_debts_untouched_m5', 0, employeeTouched);

  let loanMissing = 0;
  let loanTypeBad = 0;
  let loanNewPending = 0;
  let loanStatusInvalid = 0;
  let loanStatusChanged = 0;
  for (const l of post.loans.values()) {
    if (!validPartner(post, l.partner, l.company)) loanMissing++;
    else if (post.partners.get(l.partner).type !== 'bank') loanTypeBad++;
    const p0 = pre.loans.get(l.id);
    // M4: không sinh pending_disbursement từ dữ liệu v1
    if (l.status === 'pending_disbursement' && p0?.status !== 'pending_disbursement') loanNewPending++;
    // migration chỉ đổi trạng thái thiếu (null) thành active; trạng thái khác giữ nguyên, không tính lỗi
    if (l.status === null || l.status === undefined) loanStatusInvalid++;
    if (p0 && p0.status && p0.status !== l.status) loanStatusChanged++;
  }
  check('loans_partner_coverage', 0, loanMissing);
  check('loans_partner_type_bank', 0, loanTypeBad);
  check('loans_no_new_pending_m4', 0, loanNewPending);
  check('loans_status_valid_m4', 0, loanStatusInvalid);
  check('loans_status_unchanged_m4', 0, loanStatusChanged);

  let recMissing = 0;
  for (const r of post.recurring.values()) if (!validPartner(post, r.partner, r.company)) recMissing++;
  check('recurring_partner_coverage', 0, recMissing);

  // M3 — liên kết: mọi liên kết v1 chưa có phải đang hiệu lực ở v2
  const postActiveKeys = new Set(post.links.filter((l) => l.status === 'active').map(linkKeyOf));
  const preKeys = new Set(pre.links.map(linkKeyOf));
  const newDerived = plan.derived.filter((l) => !preKeys.has(linkKeyOf(l)));
  check('derived_links_present', 0, newDerived.filter((l) => !postActiveKeys.has(linkKeyOf(l))).length);

  // M3/M6 — chỉ tiêu: đã cấn trừ, đã trả, dư nợ (kỳ vọng suy từ v1 + liên kết sẵn có)
  const expectedLinks = [...pre.links, ...newDerived.map((l) => ({ ...l, company: null }))];
  const mE = metricsOf(pre, expectedLinks);
  const mA = metricsOf(post, post.links);
  let debtBad = 0;
  for (const [id, e] of mE.debt) {
    const a = mA.debt.get(id);
    if (!a || a.applied !== e.applied || a.rem !== e.rem) debtBad++;
  }
  check('debt_applied_and_remaining', 0, debtBad);
  let loanBad = 0;
  for (const [id, e] of mE.loans) {
    const a = mA.loans.get(id);
    if (!a || a.repaid !== e.repaid || a.outstanding !== e.outstanding) loanBad++;
  }
  check('loan_repaid_and_outstanding', 0, loanBad);
  let remBad = 0;
  for (const k of new Set([...mE.remaining.keys(), ...mA.remaining.keys()])) {
    if ((mE.remaining.get(k) ?? 0n) !== (mA.remaining.get(k) ?? 0n)) remBad++;
  }
  check('remaining_by_company_direction', 0, remBad);
  let outBad = 0;
  for (const k of new Set([...mE.outstandingByCompany.keys(), ...mA.outstandingByCompany.keys()])) {
    if ((mE.outstandingByCompany.get(k) ?? 0n) !== (mA.outstandingByCompany.get(k) ?? 0n)) outBad++;
  }
  check('outstanding_by_company', 0, outBad);

  // số dư tài khoản: Σ sổ cái (cash_entries) trước = sau
  let balBad = 0;
  for (const acc of new Set([...pre.cash.keys(), ...post.cash.keys()])) {
    const p = pre.cash.get(acc);
    const q = post.cash.get(acc);
    if ((p?.in ?? 0n) !== (q?.in ?? 0n) || (p?.out ?? 0n) !== (q?.out ?? 0n)) balBad++;
  }
  check('account_balances_unchanged', 0, balBad);

  const expectedActive = pre.links.filter((l) => l.status === 'active').length + newDerived.length;
  check('active_links_count', expectedActive, post.links.filter((l) => l.status === 'active').length);

  return {
    ok: mismatches.length === 0,
    checks,
    mismatches,
    mE,
    mA,
  };
}

/* ------------------------------------------------------------------ *
 * Ghi dữ liệu (chỉ khi apply)
 * ------------------------------------------------------------------ */

/** Mã đối tác `DT-YYYY-NNNNN` — cùng bộ đếm `counters` với nextPartnerCode (apps/api). */
async function nextPartnerCodeRaw(conn, at) {
  const year = at.getUTCFullYear();
  const res = await conn.collection('counters').findOneAndUpdate(
    { _id: `${PARTNER_CODE_PREFIX}-${year}` },
    { $inc: { seq: 1 }, $set: { updated_at: new Date() } },
    { upsert: true, returnDocument: 'after' },
  );
  const doc = res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res;
  const seq = Number(doc?.seq ?? 1);
  return `${PARTNER_CODE_PREFIX}-${year}-${String(seq).padStart(5, '0')}`;
}

const migrationHistory = (now, fields) => ({
  at: now,
  actor: { user_id: null, role: null, name: `Migration ${MIGRATION_ID}` },
  action: 'migrate_v2',
  from: null,
  to: null,
  reason: null,
  request_id: `migration-${MIGRATION_ID}`,
  fields,
});

async function applyWrites(conn, plan, now) {
  const col = (name) => conn.collection(name);

  for (const e of plan.partnerNew) e.code = await nextPartnerCodeRaw(conn, now);
  if (plan.partnerNew.length) {
    await col('partners').insertMany(
      plan.partnerNew.map((e) => ({
        _id: e.raw,
        company_id: e.companyRaw,
        code: e.code,
        type: e.type,
        status: 'active',
        name: e.name,
        name_key: e.nk,
        bank_name: e.bank_name ?? null,
        account_number: e.account ?? null,
        tax_code: e.tax_code ?? null,
        note: e.unassigned ? 'Đối tác tạm — phiếu chưa xác định đối tác khi chuyển đổi v2 (migration 0004). Rà soát và gán đối tác đúng.' : 'Tạo tự động khi chuyển đổi dữ liệu v1 → v2 (migration 0004). Rà soát loại và thông tin.',
        history: [migrationHistory(now, { created: { from: null, to: 'migrate_v1' } })],
        created_by: null,
        created_at: now,
        updated_at: now,
        migration: { source: 'v1', migration: MIGRATION_ID, key: e.key, inferred_type: e.inferred === true },
      })),
      { ordered: false },
    );
  }

  for (const a of plan.docAssign) {
    await col('documents').updateOne({ _id: a.raw }, { $set: { partner_id: a.partnerRaw }, $push: { history: migrationHistory(now, { partner_id: { from: null, to: a.partnerId } }) } });
  }
  for (const a of plan.originAssign) {
    await col('documents').updateOne({ _id: a.raw }, { $set: { origin: a.origin } });
  }
  for (const a of plan.debtAssign) {
    const $set = {};
    if (a.partnerRaw) $set.partner_id = a.partnerRaw;
    if (a.direction) $set.direction = a.direction;
    await col('debt_vouchers').updateOne({ _id: a.raw }, { $set, $push: { history: migrationHistory(now, { partner_id: { from: null, to: a.partnerId }, direction: { from: null, to: a.direction } }) } });
  }
  for (const a of plan.loanAssign) {
    const $set = {};
    if (a.partnerRaw) $set.partner_id = a.partnerRaw;
    if (a.origin) $set.origin = a.origin;
    if (a.disbursed_at) $set.disbursed_at = a.disbursed_at;
    if (a.status) $set.status = a.status;
    await col('bank_debts').updateOne({ _id: a.raw }, { $set, $push: { history: migrationHistory(now, { partner_id: { from: null, to: a.partnerId } }) } });
  }
  for (const a of plan.recAssign) {
    await col('recurring_rules').updateOne({ _id: a.raw }, { $set: { partner_id: a.partnerRaw } });
  }

  const linkDocs = plan.newLinks.map((l) => ({
    company_id: l.company_raw,
    from_type: l.from_type,
    from_id: l.from_raw,
    to_type: l.to_type,
    to_id: l.to_raw,
    relation: l.relation,
    amount_minor: l.amount,
    split: null,
    origin: l.origin,
    run_id: null,
    rule_code: l.rule_code,
    status: 'active',
    note: l.note,
    created_by: l.created_by,
    created_at: l.created_at,
    removed_by: null,
    removed_at: null,
    removed_reason: null,
  }));
  for (let i = 0; i < linkDocs.length; i += 500) {
    try {
      await col('business_links').insertMany(linkDocs.slice(i, i + 500), { ordered: false });
    } catch (err) {
      // trùng cặp (chạy song song/ chạy lại) — bỏ qua bản trùng, giữ bản đã có
      if (!(err && (err.code === 11000 || err.writeErrors))) throw err;
    }
  }

  for (const r of plan.reviews) {
    await col(REVIEW_COLLECTION).updateOne(
      { migration: MIGRATION_ID, collection: r.collection, ref_id: r.ref_id, reason: r.reason },
      { $setOnInsert: { company_id: r.company, label: r.label, created_at: now, resolved: false } },
      { upsert: true },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Báo cáo
 * ------------------------------------------------------------------ */

const sumBigOf = (m) => sumBig(m);

function buildSummary({ pre, plan, post, v, mode, now }) {
  const before = metricsOf(pre, plan.v1Raw);
  const after = v.mA;
  const reasonCounts = (items, key) => items.reduce((acc, it) => {
    acc[it[key]] = (acc[it[key]] ?? 0) + 1;
    return acc;
  }, {});
  const exceptionTotals = {};
  for (const x of plan.exceptions) {
    const cur = exceptionTotals[x.reason] ?? { count: 0, amount_minor: 0n };
    cur.count++;
    cur.amount_minor += x.amount ?? 0n;
    exceptionTotals[x.reason] = cur;
  }
  const exceptionsOut = Object.fromEntries(Object.entries(exceptionTotals).map(([k, v2]) => [k, { count: v2.count, amount_minor: v2.amount_minor.toString() }]));
  const ss = (m) => sumBigOf(m).toString();
  const debtKinds = { customer: 0, supplier: 0, employee: 0 };
  for (const d of pre.debts.values()) debtKinds[d.party_type] = (debtKinds[d.party_type] ?? 0) + 1;
  const loanStatus = (S) => {
    const out = {};
    for (const l of S.loans.values()) out[l.status ?? 'null'] = (out[l.status ?? 'null'] ?? 0) + 1;
    return out;
  };
  const remainingOf = (m) => Object.fromEntries([...m.remaining.entries()].map(([k, val]) => [k, val.toString()]));
  const outstandingOf = (m) => Object.fromEntries([...m.outstandingByCompany.entries()].map(([k, val]) => [k, val.toString()]));
  const count = (planned) => planned.reduce((acc, l) => {
    acc[l.relation] = (acc[l.relation] ?? 0) + 1;
    return acc;
  }, {});
  const plannedLinks = count(plan.newLinks);
  const planned = {
    total: plan.newLinks.length,
    by_relation: plannedLinks,
    existing_skipped: plan.counts.existingLinks,
    duplicate_in_v1_skipped: plan.counts.duplicateLinks,
  };
  // số dư tài khoản trước / sau (Σ cash_entries theo chiều; id tài khoản, không có tên)
  const balances = [...new Set([...pre.cash.keys(), ...post.cash.keys()])].sort().map((acc) => {
    const p = pre.cash.get(acc) ?? { in: 0n, out: 0n };
    const q = post.cash.get(acc) ?? { in: 0n, out: 0n };
    return { account: acc, before: (p.in - p.out).toString(), after: (q.in - q.out).toString() };
  });

  return {
    migration: MIGRATION_ID,
    mode,
    at: now.toISOString(),
    balances,
    companies: pre.companies.size,
    before: {
      documents: pre.docs.size,
      debts: debtKinds,
      loans: pre.loans.size,
      recurring_rules: pre.recurring.size,
      counterparties: pre.counterparties.size,
      v1_links: plan.v1Raw.length,
      applied_total: ss(new Map([...before.debt.entries()].map(([k, x]) => [k, x.applied]))),
      repaid_total: ss(new Map([...before.loans.entries()].map(([k, x]) => [k, x.repaid]))),
      remaining_by_company_direction: remainingOf(before),
      outstanding_by_company: outstandingOf(before),
      loan_status: loanStatus(pre),
    },
    partners: {
      existing: pre.partners.size,
      planned_new: plan.partnerNew.length,
      reused: plan.partnerEntries.size - plan.partnerNew.length,
      by_type_new: plan.partnerByType,
      unassigned_new: plan.unassignedNew,
      inferred: [...plan.partnerEntries.values()].filter((e) => e.inferred).length,
    },
    assignments: {
      documents: plan.docAssign.length,
      documents_via_link: plan.docAssign.filter((a) => a.via).length,
      documents_origin_auto: plan.originAssign.length,
      debts: plan.debtAssign.length,
      loans: plan.loanAssign.length,
      recurring_rules: plan.recAssign.length,
      debts_employee_untouched: [...pre.debts.values()].filter((d) => d.party_type === 'employee').length,
    },
    links: {
      planned,
      exceptions: exceptionsOut,
      partner_changed_by_link_name_mismatch: plan.counts.overridePartnerChanged,
    },
    loan_status_after: loanStatus(post),
    review: {
      total: plan.reviews.length,
      by_reason: reasonCounts(plan.reviews, 'reason'),
    },
    after: {
      applied_total: ss(new Map([...after.debt.entries()].map(([k, x]) => [k, x.applied]))),
      repaid_total: ss(new Map([...after.loans.entries()].map(([k, x]) => [k, x.repaid]))),
      remaining_by_company_direction: remainingOf(after),
      outstanding_by_company: outstandingOf(after),
      accounts: pre.cash.size,
    },
    verify: {
      ok: v.ok,
      checks: v.checks,
      mismatches: v.mismatches,
    },
  };
}

function jsonSafe(obj) {
  return JSON.parse(JSON.stringify(obj, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)));
}

/* ------------------------------------------------------------------ *
 * Chạy
 * ------------------------------------------------------------------ */

/**
 * Chạy M1–M6. `dryRun`: không ghi DB; kiểm tra trên trạng thái mô phỏng.
 * Trả về { ok, mismatches, summary }. (Không throw khi lệch — để gọi quyết định.)
 */
export async function run(conn, { dryRun = false } = {}) {
  const OID = conn.base?.Types?.ObjectId;
  if (typeof OID !== 'function') throw new Error('[0004] không lấy được ObjectId từ kết nối (conn.base.Types)');
  const now = new Date();
  const pre = await loadSnapshot(conn);
  const plan = buildPlan(pre, { OID, now });
  if (dryRun) {
    plan.partnerNew.forEach((e, i) => {
      e.code = `DT-DRY-${String(i + 1).padStart(5, '0')}`;
    });
  } else {
    await applyWrites(conn, plan, now);
  }
  const post = dryRun ? simulatePost(pre, plan) : await loadSnapshot(conn);
  const v = verify(pre, post, plan);
  const summary = buildSummary({ pre, plan, post, v, mode: dryRun ? 'dry-run' : 'apply', now });
  if (!dryRun) {
    await conn.collection('settings').updateOne(
      { key: SUMMARY_SETTING_KEY },
      { $set: { key: SUMMARY_SETTING_KEY, value: jsonSafe(summary), description: 'Tóm tắt migration 0004 (v1 → v2, M1–M6)', updated_at: now } },
      { upsert: true },
    );
  }
  return { ok: v.ok, mismatches: v.mismatches, summary: jsonSafe(summary) };
}

/** Hàm migration của runner (`pnpm db:migrate`): áp dụng thật; M6 lệch ⇒ ném lỗi. */
export async function up(conn, opts = {}) {
  const dryRun = opts.dryRun === true;
  const res = await run(conn, { dryRun });
  if (!res.ok && !dryRun) {
    throw new Error(`[0004] M6 đối chiếu LỆCH — chưa ghi nhận migration, chạy lại sau khi xử lý: ${res.mismatches.slice(0, 5).join(' | ')}`);
  }
  const s = res.summary;
  console.log(
    `· 0004 ${dryRun ? '(dry-run, không ghi)' : ''}: đối tác mới ${s.partners.planned_new} (chưa xác định ${s.partners.unassigned_new}), ` +
      `liên kết mới ${s.links.planned.total}, rà soát ${s.review.total}, đối chiếu ${res.ok ? 'KHỚP' : 'LỆCH'}`,
  );
  console.log(`  · đã cấn trừ: ${s.before.applied_total} → ${s.after.applied_total} · đã trả gốc: ${s.before.repaid_total} → ${s.after.repaid_total}`);
  console.log(`  · dư nợ theo công ty|hướng (trước → sau): ${JSON.stringify(s.before.outstanding_by_company)} → ${JSON.stringify(s.after.outstanding_by_company)}`);
  const moved = s.balances.filter((b) => b.before !== b.after).length;
  console.log(`  · số dư ${s.balances.length} tài khoản (trước → sau): ${moved ? `${moved} tài khoản LỆCH` : 'không đổi'}`);
  return res;
}

/* ------------------------------------------------------------------ *
 * CLI: node db/migrations/0004-v2-data.js --dry-run
 * ------------------------------------------------------------------ */

async function cli() {
  if (!process.argv.includes('--dry-run')) {
    console.error('Migration 0004 chỉ có chế độ xem trước:  node db/migrations/0004-v2-data.js --dry-run');
    console.error('Áp dụng thật chạy qua runner:            pnpm db:migrate');
    process.exitCode = 2;
    return;
  }
  const { withDb } = await import('../_common.js');
  await withDb(async () => {
    const { connectDb } = await import('../../apps/api/dist/lib/mongo.js');
    const mongoose = await connectDb();
    const res = await run(mongoose.connection, { dryRun: true });
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = join(here, '..', '..', 'data', 'migrations');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `0004-dry-run-${stamp}.json`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(res.summary, null, 2), 'utf8');
    console.log(JSON.stringify(res.summary, null, 2));
    console.log(`· báo cáo đã lưu: ${file}`);
    if (!res.ok) {
      console.error(`✗ đối chiếu M6 LỆCH (${res.mismatches.length} mục):`);
      for (const m of res.mismatches.slice(0, 20)) console.error(`  · ${m}`);
      process.exitCode = 1;
    }
    return { ok: res.ok, partners_new: res.summary.partners.planned_new, links_new: res.summary.links.planned.total };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli();
}
