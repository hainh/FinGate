#!/usr/bin/env node
/**
 * `pnpm check:tie` — đối chiếu Σ sao kê vs Σ chứng từ đã trả vs biến động số dư (§8.5).
 * Lệch → tạo alert danger + KHOÁ EXPORT + báo KTT.Script KHÔNG tự sửa số.
 * Exit code 1 khi lệch để CI/block deploy có tín hiệu.
 *
 * `pnpm check:tie -- --v2` (v2 §15, chỉ đọc): thêm kiểm tra toàn vẹn dữ liệu v2 —
 *   · phủ đối tác (phiếu, công nợ KH/NCC, khoản vay NH, khoản chi định kỳ) và đúng công ty/loại;
 *   · hướng công nợ (trừ nhân viên 334);
 *   · liên kết nghiệp vụ đang hiệu lực: đầu cuối tồn tại, số tiền > 0, tách khớp, cùng công ty
 *     (trừ chuyển nội bộ), đối tác hai đầu khớp (cảnh báo).
 * Lỗi cứng của kiểm tra v2 ⇒ exit code 1. Không có cờ --v2 thì hành vi như cũ.
 */
import { withDb } from './_common.js';

const withV2 = process.argv.includes('--v2');

/** Kiểm tra toàn vẹn dữ liệu v2 (chỉ đọc). Trả về { hard: [], warn: [], stats: {} }. */
async function checkV2Integrity() {
  const { Models } = await import('../apps/api/dist/db/models.js');
  const hard = [];
  const warn = [];
  const stats = {};
  const idOf = (v) => (v === null || v === undefined ? '' : String(v));

  const partners = new Map();
  for (const p of await Models.Partner.find({}, { company_id: 1, type: 1 }).lean()) {
    partners.set(idOf(p._id), { company: idOf(p.company_id), type: p.type });
  }
  /** đối tác hợp lệ cho một thực thể: tồn tại, cùng công ty; trả về loại hoặc null. */
  const partnerTypeFor = (partnerId, companyId) => {
    if (!partnerId) return undefined;
    const p = partners.get(idOf(partnerId));
    if (!p || p.company !== idOf(companyId)) return null;
    return p.type;
  };

  // 1–4 phủ đối tác & hướng công nợ
  const docs = await Models.Document.find({}, { company_id: 1, partner_id: 1, kind: 1, status: 1 }).lean();
  stats.documents = docs.length;
  const docNoPartner = docs.filter((d) => !d.partner_id).length;
  const docBadPartner = docs.filter((d) => d.partner_id && partnerTypeFor(d.partner_id, d.company_id) === null).length;
  if (docNoPartner) hard.push(`phiếu chưa có đối tác: ${docNoPartner}`);
  if (docBadPartner) hard.push(`phiếu có đối tác khác công ty / không tồn tại: ${docBadPartner}`);

  const debts = await Models.DebtVoucher.find({}, { company_id: 1, partner_id: 1, direction: 1, party_type: 1, side: 1 }).lean();
  stats.debt_vouchers = debts.length;
  const outside = debts.filter((d) => d.party_type !== 'employee');
  const debtNoPartner = outside.filter((d) => !d.partner_id).length;
  const debtNoDirection = outside.filter((d) => !d.direction).length;
  const debtTypeBad = outside.filter((d) => d.partner_id && partnerTypeFor(d.partner_id, d.company_id) !== d.party_type).length;
  if (debtNoPartner) hard.push(`công nợ KH/NCC chưa có đối tác: ${debtNoPartner}`);
  if (debtNoDirection) hard.push(`công nợ KH/NCC chưa có hướng (phải thu/phải trả): ${debtNoDirection}`);
  if (debtTypeBad) hard.push(`công nợ có đối tác sai loại (KH/NCC): ${debtTypeBad}`);
  const employeeTouched = debts.filter((d) => d.party_type === 'employee' && (d.partner_id || d.direction)).length;
  if (employeeTouched) warn.push(`công nợ nhân viên (334) đã có đối tác/hướng (v2 không sinh đối tác cho nhân viên): ${employeeTouched}`);

  const loans = await Models.BankDebt.find({}, { company_id: 1, partner_id: 1, status: 1 }).lean();
  stats.bank_debts = loans.length;
  const loanNoPartner = loans.filter((l) => !l.partner_id).length;
  const loanTypeBad = loans.filter((l) => l.partner_id && partnerTypeFor(l.partner_id, l.company_id) !== 'bank').length;
  if (loanNoPartner) hard.push(`khoản nợ NH chưa có ngân hàng (đối tác): ${loanNoPartner}`);
  if (loanTypeBad) hard.push(`khoản nợ NH có đối tác không phải loại Ngân hàng: ${loanTypeBad}`);

  const recurring = await Models.RecurringRule.find({}, { company_id: 1, partner_id: 1 }).lean();
  stats.recurring_rules = recurring.length;
  const recNoPartner = recurring.filter((r) => !r.partner_id).length;
  if (recNoPartner) hard.push(`khoản chi định kỳ chưa có người nhận (đối tác): ${recNoPartner}`);

  // 5–7 liên kết đang hiệu lực
  const links = await Models.BusinessLink.find({ status: 'active' }).lean();
  stats.business_links_active = links.length;
  const ids = {
    document: new Set(docs.map((d) => idOf(d._id))),
    debt_voucher: new Set(debts.map((d) => idOf(d._id))),
    bank_debt: new Set(loans.map((l) => idOf(l._id))),
  };
  const docById = new Map(docs.map((d) => [idOf(d._id), d]));
  const debtById = new Map(debts.map((d) => [idOf(d._id), d]));
  const loanById = new Map(loans.map((l) => [idOf(l._id), l]));
  const partnerOfEnd = (type, id) => {
    if (type === 'document') return docById.get(idOf(id))?.partner_id;
    if (type === 'debt_voucher') return debtById.get(idOf(id))?.partner_id;
    return loanById.get(idOf(id))?.partner_id;
  };
  const companyOfEnd = (type, id) => {
    if (type === 'document') return docById.get(idOf(id))?.company_id;
    if (type === 'debt_voucher') return debtById.get(idOf(id))?.company_id;
    return loanById.get(idOf(id))?.company_id;
  };
  let orphan = 0;
  let badAmount = 0;
  let badSplit = 0;
  let companyBad = 0;
  let partnerMismatch = 0;
  for (const l of links) {
    if (!ids[l.from_type]?.has(idOf(l.from_id)) || !ids[l.to_type]?.has(idOf(l.to_id))) {
      orphan++;
      continue;
    }
    if (l.amount_minor !== null && l.amount_minor !== undefined && BigInt(l.amount_minor) <= 0n) badAmount++;
    if (l.split) {
      const sum = BigInt(l.split.principal ?? 0) + BigInt(l.split.interest ?? 0) + BigInt(l.split.fee ?? 0);
      if (l.amount_minor === null || l.amount_minor === undefined || sum !== BigInt(l.amount_minor)) badSplit++;
    }
    if (l.relation !== 'internal_transfer' && idOf(companyOfEnd(l.from_type, l.from_id)) !== idOf(companyOfEnd(l.to_type, l.to_id))) {
      companyBad++;
    }
    if (['offset', 'repayment', 'disbursement'].includes(l.relation)) {
      const a = partnerOfEnd(l.from_type, l.from_id);
      const b = partnerOfEnd(l.to_type, l.to_id);
      if (!a || !b || idOf(a) !== idOf(b)) partnerMismatch++;
    }
  }
  if (orphan) hard.push(`liên kết đang hiệu lực trỏ tới đối tượng không tồn tại: ${orphan}`);
  if (badAmount) hard.push(`liên kết có số tiền không dương: ${badAmount}`);
  if (badSplit) hard.push(`liên kết tách gốc/lãi/phí không khớp số tiền: ${badSplit}`);
  if (companyBad) hard.push(`liên kết khác công ty (trừ chuyển nội bộ): ${companyBad}`);
  if (partnerMismatch) warn.push(`liên kết cấn trừ/trả nợ/giải ngân có đối tác hai đầu không khớp (rà soát): ${partnerMismatch}`);

  return { hard, warn, stats };
}

try {
  const result = await withDb(async () => {
    const { checkTie } = await import('../apps/api/dist/domain/tie/index.js');
    const tie = await checkTie();
    const v2 = withV2 ? await checkV2Integrity() : null;
    return { tie, v2 };
  });
  const tie = result?.tie;
  if (tie && tie.ok === false) {
    console.error(`✗ đối chiếu LỆCH ở ${tie.mismatches.length} tài khoản — export đang bị khoá`);
    for (const m of tie.mismatches.slice(0, 10)) console.error(`  · ${m.account_id}: sao_kê=${m.statement} chứng_từ=${m.documents} số_dư=${m.balance}`);
    process.exitCode = 1;
  }
  const v2 = result?.v2;
  if (v2) {
    for (const w of v2.warn) console.warn(`! v2 (cảnh báo): ${w}`);
    if (v2.hard.length) {
      console.error(`✗ kiểm tra toàn vẹn v2 LỖI (${v2.hard.length} mục):`);
      for (const h of v2.hard) console.error(`  · ${h}`);
      process.exitCode = 1;
    } else {
      console.log(`✓ kiểm tra toàn vẹn v2 đạt (${JSON.stringify(v2.stats)})`);
    }
  }
} catch (err) {
  console.error('✗ check:tie lỗi:', err.message);
  process.exitCode = 1;
}
