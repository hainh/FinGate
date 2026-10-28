/**
 * Kiểm thử migration 0004 (v1 → v2) bằng bộ nhớ giả lập tập lệnh Mongo mà migration dùng.
 * Chạy: node --test db/migrations/0004-v2-data.test.mjs
 * Không cần MongoDB: kiểm tra logic M1–M6, dry-run không ghi, chạy lại idempotent, M6 bắt lệch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { up, run, normalizeNameKey, normalizeAccount, looksLikeBank, isInternalLabel, toBig } from './0004-v2-data.js';

let seq = 0;
class FakeOID {
  constructor(hex) {
    seq += 1;
    this.hex = hex ?? seq.toString(16).padStart(24, '0');
  }
  toString() {
    return this.hex;
  }
}

const isOID = (v) => v instanceof FakeOID;
const same = (a, b) => (isOID(a) || isOID(b) ? String(a) === String(b) : a === b);

function clone(v) {
  if (v === null || v === undefined) return v;
  if (isOID(v)) return new FakeOID(v.hex);
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

function matches(doc, filter) {
  return Object.entries(filter).every(([k, want]) => {
    const have = doc[k];
    if (want === null) return have === null || have === undefined;
    return same(have, want);
  });
}

function applyUpdate(doc, update, { inserting = false } = {}) {
  for (const [op, fields] of Object.entries(update)) {
    if (op === '$set') Object.assign(doc, clone(fields));
    else if (op === '$setOnInsert' && inserting) Object.assign(doc, clone(fields));
    else if (op === '$push') for (const [k, val] of Object.entries(fields)) doc[k] = [...(doc[k] ?? []), clone(val)];
    else if (op === '$inc') for (const [k, val] of Object.entries(fields)) doc[k] = (doc[k] ?? 0) + val;
  }
}

/** Bộ nhớ giả lập: chỉ các thao tác migration dùng (find, insertMany, updateOne, findOneAndUpdate). */
function makeConn(seed = {}) {
  const store = new Map();
  const writes = { count: 0 };
  const list = (name) => {
    if (!store.has(name)) store.set(name, []);
    return store.get(name);
  };
  for (const [name, docs] of Object.entries(seed)) list(name).push(...clone(docs));

  const collection = (name) => ({
    find: (filter = {}) => ({ toArray: async () => clone(list(name).filter((d) => matches(d, filter))) }),
    insertMany: async (docs, opts = {}) => {
      writes.count += docs.length;
      for (const d of docs) list(name).push(clone(d));
      return { insertedCount: docs.length, ordered: opts.ordered };
    },
    updateOne: async (filter, update, opts = {}) => {
      writes.count += 1;
      const arr = list(name);
      let doc = arr.find((d) => matches(d, filter));
      if (!doc && opts.upsert) {
        doc = { ...clone(filter) };
        arr.push(doc);
        applyUpdate(doc, update, { inserting: true });
      } else if (doc) {
        applyUpdate(doc, update);
      }
      return { matchedCount: doc ? 1 : 0 };
    },
    findOneAndUpdate: async (filter, update, opts = {}) => {
      writes.count += 1;
      const arr = list(name);
      let doc = arr.find((d) => matches(d, filter));
      if (!doc && opts.upsert) {
        doc = { ...clone(filter) };
        arr.push(doc);
        applyUpdate(doc, update, { inserting: true });
      } else if (doc) applyUpdate(doc, update);
      return clone(doc);
    },
    countDocuments: async (filter = {}) => list(name).filter((d) => matches(d, filter)).length,
  });

  const conn = { base: { Types: { ObjectId: FakeOID } }, collection };
  return { conn, store, writes, list };
}

/* ------------------------------------------------------------------ *
 * Dữ liệu v1 mẫu — phủ các nhánh M1–M6
 * ------------------------------------------------------------------ */
const C1 = new FakeOID('c1000000000000000000001'); // MP
const C2 = new FakeOID('c2000000000000000000002'); // AP
const CP1 = new FakeOID('cc10000000000000000001');
const D1 = new FakeOID('d1000000000000000000001'); // phiếu chi
const D2 = new FakeOID('d2000000000000000000002'); // phiếu thu (offset KH)
const D3 = new FakeOID('d3000000000000000000003'); // rollover (loan_ref)
const D4 = new FakeOID('d4000000000000000000004'); // phiếu chi trả nợ NH
const D5 = new FakeOID('d5000000000000000000005'); // phiếu thu có cờ v1 create_bank_debt (tắt khi migrate)
const D6 = new FakeOID('d6000000000000000000006'); // phiếu chi, đối tác đã có
const D7 = new FakeOID('d7000000000000000000007'); // chi nội bộ (label AP)
const D8 = new FakeOID('d8000000000000000000008'); // thu nội bộ tự sinh (R1) ở C2
const D9 = new FakeOID('d9000000000000000000009'); // chi C1 cấn trừ công nợ của C2 (lệch công ty)
const D10 = new FakeOID('da00000000000000000000a'); // chi không có tên
const DEBT_SUP = new FakeOID('de1000000000000000000001'); // NCC (credit)
const DEBT_CUS = new FakeOID('de2000000000000000000002'); // KH (debit)
const DEBT_EMP = new FakeOID('de3000000000000000000003'); // NV (employee)
const DEBT_C2 = new FakeOID('de4000000000000000000004'); // công nợ C2 bị cấn trừ chéo
const DEBT_NONAME = new FakeOID('de5000000000000000000005'); // không có tên đối tác
const LOAN1 = new FakeOID('1a1000000000000000000001');
const LOAN2 = new FakeOID('1a2000000000000000000002');
const LOAN3 = new FakeOID('1a3000000000000000000003');
const REC1 = new FakeOID('e10000000000000000000001');
const REC2 = new FakeOID('e20000000000000000000002');
const REC3 = new FakeOID('e30000000000000000000003');
const EXISTING_PARTNER = new FakeOID('fa0000000000000000000001');
const ACC_A = 'acc-a'; // tài khoản MP
const ACC_B = 'acc-b'; // tài khoản AP

function seedV1() {
  const money = (x) => BigInt(x);
  return {
    companies: [
      { _id: C1, code: 'MP', name: 'Công ty MP', is_group: false },
      { _id: C2, code: 'AP', name: 'Công ty AP', is_group: false },
    ],
    counterparties: [
      { _id: CP1, name: 'Công ty CP Đầu tư Nhà Xanh', banks: [{ bank_name: 'Vietcombank', account_number: '0071 000 452100', branch: null }] },
    ],
    partners: [
      // đối tác đã tạo tay ở v2 (không có migration.key) — phải được tái sử dụng, không tạo trùng
      { _id: EXISTING_PARTNER, company_id: C1, code: 'DT-2026-00001', type: 'supplier', status: 'active', name: 'Công ty CP Ép cọc nền móng Trường Phát', name_key: 'công ty cp ép cọc nền móng trường phát', account_number: null },
    ],
    documents: [
      { _id: D1, company_id: C1, kind: 'spend', status: 'paid', payee: { name: 'Công ty VLXD Thành Trung', bank_account: '1271 0000 889901' }, amount: { minor: money(2_500_000_000) } },
      { _id: D2, company_id: C1, kind: 'income', status: 'paid', payee: { name: 'Công ty CP Đầu tư Nhà Xanh' }, amount: { minor: money(1_200_000_000) } },
      { _id: D3, company_id: C1, kind: 'rollover', status: 'approved', payee: { name: 'BIDV Chi nhánh TP.HCM' }, amount: { minor: money(2_000_000_000) }, loan_id: LOAN1 },
      { _id: D4, company_id: C1, kind: 'spend', status: 'paid', payee: { name: 'BIDV Chi nhánh TP.HCM' }, amount: { minor: money(500_000_000) } },
      { _id: D5, company_id: C1, kind: 'income', status: 'paid', payee: { name: 'Công ty TNHH Minh Long' }, amount: { minor: money(800_000_000) }, create_bank_debt: true, execution: { paid_at: '2026-03-01' } },
      { _id: D6, company_id: C1, kind: 'spend', status: 'paid', payee: { name: 'Công ty CP Ép cọc nền móng Trường Phát' }, amount: { minor: money(100_000) } },
      { _id: D7, company_id: C1, kind: 'spend', status: 'paid', payee: { name: 'AP - VietinBank - 10987001234501' }, amount: { minor: money(300_000_000) } },
      { _id: D8, company_id: C2, kind: 'income', status: 'paid', payee: { name: 'MP - Công ty MP', is_internal: true }, amount: { minor: money(300_000_000) }, auto_source_document_id: D7, auto_created: true },
      { _id: D9, company_id: C1, kind: 'spend', status: 'paid', payee: { name: 'Nhà cung cấp X' }, amount: { minor: money(500_000) } },
      { _id: D10, company_id: C1, kind: 'spend', status: 'draft', payee: {}, amount: { minor: money(42_000) } },
    ],
    debt_vouchers: [
      { _id: DEBT_SUP, company_id: C1, party_type: 'supplier', party_name: 'Công ty VLXD Thành Trung', party_bank_account: '12710000889901', account_code: '331', side: 'credit', value_minor: money(2_500_000_000), document_links: [{ _id: new FakeOID(), document_id: D1, amount_minor: money(1_000_000_000), linked_at: new Date('2026-02-01') }] },
      { _id: DEBT_CUS, company_id: C1, party_type: 'customer', party_name: 'Công ty CP Đầu tư Nhà Xanh', counterparty_id: CP1, account_code: '131', side: 'debit', value_minor: money(1_500_000_000), document_links: [{ _id: new FakeOID(), document_id: D2, amount_minor: money(1_200_000_000) }] },
      { _id: DEBT_EMP, company_id: C1, party_type: 'employee', party_name: 'Hoàng Văn Tuấn', account_code: '334', side: 'credit', value_minor: money(120_000_000), document_links: [{ _id: new FakeOID(), document_id: D6, amount_minor: money(100_000) }] },
      { _id: DEBT_C2, company_id: C2, party_type: 'supplier', party_name: 'Nhà cung cấp Bao bì', account_code: '331', side: 'credit', value_minor: money(3_200_000_000), document_links: [{ _id: new FakeOID(), document_id: D9, amount_minor: money(500_000) }] },
      { _id: DEBT_NONAME, company_id: C1, party_type: 'customer', party_name: '', account_code: '131', side: 'debit', value_minor: money(10_000_000), document_links: [] },
    ],
    bank_debts: [
      { _id: LOAN1, company_id: C1, bank_name: 'BIDV', branch: 'Chi nhánh TP.HCM', principal_minor: money(2_000_000_000), status: 'active', repayment_links: [{ _id: new FakeOID(), document_id: D4, amount_minor: money(500_000_000) }], created_at: new Date('2026-01-10') },
      { _id: LOAN2, company_id: C1, bank_name: 'BIDV', branch: 'Chi nhánh TP.HCM', principal_minor: money(800_000_000), status: 'active', auto_source_document_id: D5, repayment_links: [], created_at: new Date('2026-03-01T03:00:00Z') },
      { _id: LOAN3, company_id: C2, bank_name: 'VietinBank', branch: 'Chi nhánh 1', principal_minor: money(900_000_000), status: 'overdue', repayment_links: [], created_at: new Date('2025-12-01') },
    ],
    recurring_rules: [
      { _id: REC1, company_id: C1, title: 'Thuê văn phòng', payee: { name: 'Theo hợp đồng dịch vụ' } },
      { _id: REC2, company_id: C2, title: 'Trả lãi vay MB', payee: { name: 'Vietcombank' } },
      { _id: REC3, company_id: C1, title: 'Lương', payee: {} },
    ],
    business_links: [],
    cash_entries: [
      { _id: new FakeOID(), company_id: C1, account_id: ACC_A, direction: 'in', amount_minor: money(10_000_000_000) },
      { _id: new FakeOID(), company_id: C1, account_id: ACC_A, direction: 'out', amount_minor: money(2_000_000_000) },
      { _id: new FakeOID(), company_id: C2, account_id: ACC_B, direction: 'in', amount_minor: money(300_000_000) },
    ],
    counters: [],
    settings: [],
  };
}

/* ------------------------------------------------------------------ *
 * Tiện ích thuần
 * ------------------------------------------------------------------ */

test('chuẩn hoá tên và STK theo khoá đối tác', () => {
  assert.equal(normalizeNameKey('  Công   ty  ABC '), 'công ty abc');
  assert.equal(normalizeAccount('0071 000-452.100'), '0071000452100');
  assert.equal(normalizeAccount('   '), null);
  assert.equal(toBig(12345n), 12345n);
  assert.equal(toBig('98765'), 98765n);
  assert.equal(toBig(null), 0n);
});

test('nhận diện ngân hàng và nhãn chuyển nội bộ', () => {
  assert.equal(looksLikeBank('BIDV Chi nhánh TP.HCM'), true);
  assert.equal(looksLikeBank('Công ty CP Ép cọc'), false);
  assert.equal(isInternalLabel('AP - VietinBank - 10987001234501', new Set(['AP', 'MP'])), true);
  assert.equal(isInternalLabel('XY - Bank - 1', new Set(['AP'])), false);
  assert.equal(isInternalLabel('Công ty A', new Set(['AP'])), false);
});

/* ------------------------------------------------------------------ *
 * Dry-run: không ghi gì, báo cáo đầy đủ
 * ------------------------------------------------------------------ */

test('dry-run không ghi DB và đối chiếu khớp trên trạng thái mô phỏng', async () => {
  const { conn, writes, list } = makeConn(seedV1());
  const res = await run(conn, { dryRun: true });
  assert.equal(writes.count, 0, 'dry-run không được ghi');
  assert.equal(list('settings').length, 0, 'dry-run không ghi tóm tắt');
  assert.equal(res.ok, true, `M6 phải khớp: ${res.mismatches.join(' | ')}`);
  assert.equal(res.summary.mode, 'dry-run');
});

test('dry-run phân loại đối tác, liên kết, ngoại lệ và rà soát đúng', async () => {
  const { conn } = makeConn(seedV1());
  const { summary } = await run(conn, { dryRun: true });

  // đối tác: tái sử dụng 1 (đã có tay), còn lại tạo mới
  assert.equal(summary.partners.existing, 1);
  assert.ok(summary.partners.reused >= 1, 'đối tác tạo tay phải được tái sử dụng');
  // NH: BIDV – CN TP.HCM (L1 & L2 gộp), VietinBank (AP), Vietcombank (khoản chi định kỳ AP)
  assert.equal(summary.partners.by_type_new.bank, 3, 'ba đối tác ngân hàng');
  // "Chưa xác định": MP (chuyển nội bộ/không tên, CN không tên) · MP KH (công nợ không tên) · AP (nội bộ)
  assert.equal(summary.partners.unassigned_new, 3, 'mỗi công ty/loại một đối tác "Chưa xác định"');

  // liên kết: offset (2 phiếu), repayment (1), disbursement (R2), internal_transfer (R1, khác công ty)
  const byRel = summary.links.planned.by_relation;
  assert.equal(byRel.offset, 2, 'D1, D2 → công nợ');
  assert.equal(byRel.repayment, 1, 'D4 → L1');
  assert.equal(byRel.disbursement, undefined, 'cờ create_bank_debt tắt: D5 không sinh liên kết giải ngân');
  assert.equal(byRel.internal_transfer, 1, 'D7 → D8 khác công ty');
  assert.equal(byRel.generated, undefined, 'generated chỉ dùng cùng công ty');

  // ngoại lệ: công nợ nhân viên không đụng; cấn trừ lệch công ty bị bỏ
  assert.equal(summary.links.exceptions.employee_debt_untouched.count, 1);
  assert.equal(summary.links.exceptions.invalid_offset.count, 1);

  // M3b: công nợ KH/NCC có hướng; nhân viên để trống
  assert.equal(summary.assignments.debts, 4, 'DEBT_SUP, DEBT_CUS, DEBT_C2, DEBT_NONAME: đối tác + hướng');
  assert.equal(summary.assignments.debts_employee_untouched, 1);

  // rà soát: phiếu không tên/nội bộ, đổi đối tác theo liên kết
  assert.ok(summary.review.by_reason.unassigned_internal_transfer >= 1);
  assert.ok(summary.review.by_reason.unassigned_no_payee >= 1);
  assert.ok(Object.keys(summary.review.by_reason).some((r) => r.startsWith('link_partner_')));
  assert.equal(summary.verify.ok, true);
});

/* ------------------------------------------------------------------ *
 * Apply: ghi đúng, đối chiếu khớp, chạy lại không tạo trùng
 * ------------------------------------------------------------------ */

test('apply ghi đối tác, liên kết, hướng, origin; chạy lại không tạo trùng', async () => {
  const { conn, list } = makeConn(seedV1());
  const first = await up(conn);
  assert.equal(first.ok, true, `M6 phải khớp: ${first.mismatches.join(' | ')}`);

  const partners1 = list('partners').length;
  const links1 = list('business_links').length;
  assert.equal(links1, 4, 'offset×2 + repayment + internal_transfer (cờ create_bank_debt tắt: không disbursement)');
  assert.ok(list('settings').some((s) => s.key === 'migration.0004.summary'), 'lưu tóm tắt');

  // đối tác: DT-code được cấp, có migration.key, phủ mọi phiếu/khoản
  const newPartners = list('partners').filter((p) => p.migration?.key);
  assert.ok(newPartners.every((p) => /^DT-\d{4}-\d{5}$/.test(p.code)));
  for (const d of list('documents')) assert.ok(d.partner_id, `phiếu ${String(d._id)} phải có partner_id`);

  // phiếu liên kết đổi sang đối tác của liên kết (partnerMatch)
  const loan1 = list('bank_debts').find((x) => String(x._id) === String(LOAN1));
  const d4 = list('documents').find((x) => String(x._id) === String(D4));
  assert.equal(String(d4.partner_id), String(loan1.partner_id), 'phiếu trả nợ = đối tác NH của khoản vay');
  const debtSup = list('debt_vouchers').find((x) => String(x._id) === String(DEBT_SUP));
  const d1 = list('documents').find((x) => String(x._id) === String(D1));
  assert.equal(String(d1.partner_id), String(debtSup.partner_id), 'phiếu cấn trừ = đối tác công nợ');

  // M3b + M5
  assert.equal(debtSup.direction, 'payable');
  assert.equal(list('debt_vouchers').find((x) => String(x._id) === String(DEBT_CUS)).direction, 'receivable');
  const emp = list('debt_vouchers').find((x) => String(x._id) === String(DEBT_EMP));
  assert.equal(emp.partner_id, undefined, 'nhân viên không có đối tác');
  assert.equal(emp.direction, undefined, 'nhân viên không có hướng');

  // cờ create_bank_debt tắt: khoản vay không nhãn R2, phiếu thu có cờ là KH thường; R1 origin trên phiếu thu nội bộ
  assert.notEqual(list('bank_debts').find((x) => String(x._id) === String(LOAN2)).origin?.rule_code, 'R2', 'không nhãn tự động R2');
  const d5 = list('documents').find((x) => String(x._id) === String(D5));
  assert.equal(list('partners').find((x) => String(x._id) === String(d5.partner_id)).type, 'customer', 'cờ create_bank_debt không suy đối tác thành NH');
  assert.equal(list('documents').find((x) => String(x._id) === String(D8)).origin.rule_code, 'R1');

  // M4: khoản vay không đổi trạng thái, không có pending_disbursement
  assert.equal(list('bank_debts').find((x) => String(x._id) === String(LOAN3)).status, 'overdue');

  // đối tác tái sử dụng được (không trùng với đối tác tạo tay)
  assert.equal(list('partners').filter((p) => String(p._id) === String(EXISTING_PARTNER)).length, 1);
  assert.equal(list('partners').find((p) => String(p._id) === String(EXISTING_PARTNER)).migration, undefined);

  // chạy lại: không tạo partner/liên kết mới, M6 vẫn khớp
  const second = await up(conn);
  assert.equal(second.ok, true, `chạy lại phải khớp: ${second.mismatches.join(' | ')}`);
  assert.equal(list('partners').length, partners1, 'chạy lại không tạo đối tác trùng');
  assert.equal(list('business_links').length, links1, 'chạy lại không tạo liên kết trùng');
});

test('phiếu gắn khoản vay khác công ty không lấy đối tác của công ty khác (M2 giữ phạm vi công ty)', async () => {
  const seed = seedV1();
  const DX = new FakeOID('dx0000000000000000000001');
  // phiếu thuộc C1 nhưng trỏ tới khoản vay LOAN3 của C2
  seed.documents.push({ _id: DX, company_id: C1, kind: 'rollover', status: 'approved', payee: { name: 'VietinBank – Chi nhánh 1' }, amount: { minor: 900_000_000n }, loan_id: LOAN3 });
  const { conn, list } = makeConn(seed);
  const res = await up(conn);
  assert.equal(res.ok, true, `M6 phải khớp: ${res.mismatches.join(' | ')}`);
  const doc = list('documents').find((d) => String(d._id) === String(DX));
  const partner = list('partners').find((p) => String(p._id) === String(doc.partner_id));
  assert.equal(String(partner.company_id), String(C1), 'đối tác của phiếu phải cùng công ty với phiếu');
});

test('M6 bắt lệch: liên kết không ghi được ⇒ up() ném lỗi, không đánh dấu thành công', async () => {
  const seed = seedV1();
  const { conn } = makeConn(seed);
  // giả lập lỗi ghi: bỏ qua mọi liên kết mới
  const realCollection = conn.collection;
  conn.collection = (name) => {
    const c = realCollection(name);
    if (name !== 'business_links') return c;
    return { ...c, insertMany: async () => ({ insertedCount: 0 }) };
  };
  await assert.rejects(() => up(conn), /M6 đối chiếu LỆCH/);
});

test('chạy lại sau khi người dùng gỡ liên kết và đổi hướng ở v2: không sống lại, không ghi đè, vẫn khớp', async () => {
  const { conn, list } = makeConn(seedV1());
  await up(conn);

  // người dùng v2: gỡ cấn trừ D1 → công nợ NCC, đổi hướng công nợ đó
  const link = list('business_links').find((l) => String(l.from_id) === String(D1) && String(l.to_id) === String(DEBT_SUP));
  link.status = 'removed';
  link.removed_reason = 'gỡ thủ công (kiểm thử)';
  const debt = list('debt_vouchers').find((x) => String(x._id) === String(DEBT_SUP));
  debt.direction = 'receivable';
  const linksBefore = list('business_links').length;

  const again = await up(conn);
  assert.equal(again.ok, true, `chạy lại phải khớp: ${again.mismatches.join(' | ')}`);
  assert.equal(list('business_links').length, linksBefore, 'liên kết đã gỡ không được tạo lại');
  assert.equal(list('business_links').find((l) => String(l.from_id) === String(D1) && String(l.to_id) === String(DEBT_SUP)).status, 'removed');
  assert.equal(list('debt_vouchers').find((x) => String(x._id) === String(DEBT_SUP)).direction, 'receivable', 'hướng người dùng chọn không bị ghi đè');
});
