/**
 * Kiểm thử migration 0007 (sửa đối tác chuyển nội bộ) bằng bộ nhớ giả lập find/updateOne/... — không cần MongoDB.
 * Chạy: node --test db/migrations/0007-internal-transfer-partners.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { up, internalDestOf, isInternalTransfer, isInternalLabel, internalPartnerName } from './0007-internal-transfer-partners.js';

/* ----------------------------- bộ nhớ giả lập ----------------------------- */

class FakeOID {
  constructor(hex) {
    this.hex = hex;
  }
  toString() {
    return this.hex;
  }
}
const oid = (n) => new FakeOID(n.toString(16).padStart(24, '0'));

function clone(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof FakeOID) return new FakeOID(v.hex);
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

const getPath = (doc, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), doc);

function setPath(doc, path, value) {
  const keys = path.split('.');
  let o = doc;
  for (const k of keys.slice(0, -1)) {
    if (o[k] === null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
}

const eq = (a, b) => {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (a instanceof FakeOID || b instanceof FakeOID) return String(a) === String(b);
  return a === b;
};

/** Chỉ các toán tử migration dùng: equality, $in, $ne. */
function matches(doc, filter) {
  return Object.entries(filter).every(([path, want]) => {
    const have = getPath(doc, path);
    if (want && typeof want === 'object' && !(want instanceof FakeOID) && !(want instanceof Date)) {
      return Object.entries(want).every(([op, arg]) => {
        if (op === '$in') return arg.some((x) => eq(have, x));
        if (op === '$ne') return !eq(have, arg);
        throw new Error(`toán tử chưa hỗ trợ trong bộ giả lập: ${op}`);
      });
    }
    return eq(have, want);
  });
}

function applyUpdate(doc, update) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, val] of Object.entries(fields)) {
      if (op === '$set') setPath(doc, path, clone(val));
      else if (op === '$inc') setPath(doc, path, (getPath(doc, path) ?? 0) + val);
      else if (op === '$push') {
        const arr = getPath(doc, path) ?? [];
        arr.push(clone(val));
        setPath(doc, path, arr);
      } else throw new Error(`toán tử cập nhật chưa hỗ trợ: ${op}`);
    }
  }
}

function fakeConn(seed) {
  const data = new Map(Object.entries(seed).map(([k, rows]) => [k, rows.map(clone)]));
  const rowsOf = (name) => {
    if (!data.has(name)) data.set(name, []);
    return data.get(name);
  };
  const conn = {
    base: { Types: { ObjectId: FakeOID } },
    data,
    collection(name) {
      return {
        find(filter = {}) {
          const out = rowsOf(name).filter((d) => matches(d, filter)).map(clone);
          return { toArray: async () => out };
        },
        async countDocuments(filter = {}) {
          return rowsOf(name).filter((d) => matches(d, filter)).length;
        },
        async updateOne(filter, update) {
          const d = rowsOf(name).find((x) => matches(x, filter));
          if (!d) return { matchedCount: 0, modifiedCount: 0 };
          applyUpdate(d, update);
          return { matchedCount: 1, modifiedCount: 1 };
        },
        async updateMany(filter, update) {
          const hit = rowsOf(name).filter((x) => matches(x, filter));
          for (const d of hit) applyUpdate(d, update);
          return { matchedCount: hit.length, modifiedCount: hit.length };
        },
        async insertOne(doc) {
          rowsOf(name).push(clone(doc));
          return { insertedId: doc._id };
        },
        async deleteOne(filter) {
          const arr = rowsOf(name);
          const i = arr.findIndex((d) => matches(d, filter));
          if (i >= 0) arr.splice(i, 1);
          return { deletedCount: i >= 0 ? 1 : 0 };
        },
        async findOneAndUpdate(filter, update) {
          let d = rowsOf(name).find((x) => matches(x, filter));
          if (!d) {
            d = { ...clone(filter) };
            rowsOf(name).push(d);
          }
          applyUpdate(d, update);
          return { value: clone(d) };
        },
      };
    },
  };
  return conn;
}

/* ------------------------------ dữ liệu mẫu ------------------------------ */

const cA = oid(0xa1); // công ty phiếu (VIX)
const cB = oid(0xb1); // công ty đích (CDT)
const cC = oid(0xc1); // công ty khác
const accX = oid(0x1001); // TK đích thuộc B
const accGroup = oid(0x1002); // TK nhóm của B (không dùng được)
const accC = oid(0x1003); // TK của C
const uA = oid(0x2001); // đối tác tạm 0004 của A
const uB = oid(0x2002); // đối tác tạm 0004 của B
const unassignedOf = (id, company) => ({
  _id: id,
  company_id: company,
  code: `DT-2025-0000${id.hex.slice(-1)}`,
  type: 'supplier',
  status: 'active',
  name: 'Chưa xác định',
  name_key: 'chưa xác định',
  bank_name: null,
  account_number: null,
  history: [],
  migration: { source: 'v1', migration: '0004', key: `${company}|supplier|chưa xác định|` },
});

function seedBase() {
  return {
    companies: [
      { _id: cA, code: 'VIX', name: 'Cty VIX' },
      { _id: cB, code: 'CDT', name: 'Cty CDT' },
      { _id: cC, code: 'CCC', name: 'Cty C' },
    ],
    bank_accounts: [
      { _id: accX, company_id: cB, bank_name: 'Sacombank', account_name: 'TK vay', account_number: '086', is_group: false, status: 'active' },
      { _id: accGroup, company_id: cB, bank_name: 'BIDV', account_name: 'TK nhóm', account_number: '999', is_group: true, status: 'active' },
      { _id: accC, company_id: cC, bank_name: 'VCB', account_name: 'TK C', account_number: '111', is_group: false, status: 'active' },
    ],
    partners: [unassignedOf(uA, cA), unassignedOf(uB, cB)],
    documents: [
      // S1, S2: chi chuyển nội bộ sang TK đích của B → phải thành đối tác internal (dùng chung một đối tác)
      { _id: oid(0x3001), code: 'PC-1', kind: 'spend', company_id: cA, partner_id: uA, version: 1, history: [], payee: { name: 'CDT - Sacombank - 086', is_internal: true }, target: { company_id: cB, account_id: accX } },
      { _id: oid(0x3002), code: 'PC-2', kind: 'spend', company_id: cA, partner_id: uA, version: 1, history: [], payee: { name: 'CDT - Sacombank - 086', is_internal: true }, target: { company_id: cB, account_id: accX } },
      // M1: phiếu thu R1 tự sinh ở B từ S1 → bỏ đối tác tạm (không đối tác như R1 v2)
      { _id: oid(0x3003), code: 'PT-1', kind: 'income', company_id: cB, partner_id: uB, version: 1, history: [], payee: { name: 'VIX - Cty VIX', is_internal: true }, target: null, auto_created: true, auto_source_document_id: oid(0x3001) },
      // S3: đích là chính công ty phiếu → không xác định được đích, để nguyên và báo
      { _id: oid(0x3004), code: 'PC-3', kind: 'spend', company_id: cA, partner_id: uA, version: 1, history: [], payee: { name: 'VIX - x - y', is_internal: true }, target: { company_id: cA, account_id: null } },
      // S4: TK đích không thuộc công ty đích → để nguyên và báo
      { _id: oid(0x3005), code: 'PC-4', kind: 'spend', company_id: cA, partner_id: uA, version: 1, history: [], payee: { name: 'CDT - x', is_internal: true }, target: { company_id: cB, account_id: accC } },
      // S6: đích là TK nhóm (không dùng được) → đối tác internal nhưng ngừng giao dịch
      { _id: oid(0x3006), code: 'PC-6', kind: 'spend', company_id: cA, partner_id: uA, version: 1, history: [], payee: { name: 'CDT - nhóm', is_internal: true }, target: { company_id: cB, account_id: accGroup } },
      // N1: chi bình thường cho NCC → không đụng (vẫn trỏ tới đối tác tạm, nhưng không phải chuyển nội bộ)
      { _id: oid(0x3007), code: 'PC-5', kind: 'spend', company_id: cA, partner_id: uA, version: 1, history: [], payee: { name: 'NCC Thép', is_internal: false }, target: null },
    ],
    migration_reviews: [
      { migration: '0004', collection: 'documents', ref_id: String(oid(0x3001)), reason: 'unassigned_internal_transfer', resolved: false },
      { migration: '0004', collection: 'documents', ref_id: String(oid(0x3003)), reason: 'unassigned_internal_transfer', resolved: false },
      { migration: '0004', collection: 'documents', ref_id: String(oid(0x3004)), reason: 'unassigned_internal_transfer', resolved: false },
      { migration: '0004', collection: 'partners', ref_id: String(uB), reason: 'inferred_type', resolved: false },
    ],
  };
}

const silently = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

const docByCode = (conn, code) => conn.data.get('documents').find((d) => d.code === code);

/* -------------------------------- kiểm thử -------------------------------- */

test('đích chuyển nội bộ: ưu tiên transfer_target, công ty đích phải khác công ty phiếu', () => {
  assert.deepEqual(internalDestOf({ company_id: cA, transfer_target: { company_id: cB, account_id: accX }, target: { company_id: cC, account_id: accC } }), {
    company_id: cB,
    account_id: accX,
  });
  assert.deepEqual(internalDestOf({ company_id: cA, transfer_target: null, target: { company_id: cB, account_id: accX } }), { company_id: cB, account_id: accX });
  assert.equal(internalDestOf({ company_id: cA, target: { company_id: cA, account_id: accX } }), null);
  assert.equal(internalDestOf({ company_id: cA, target: { company_id: cB, account_id: null } }), null);
  assert.equal(internalDestOf({ company_id: cA, target: null }), null);
});

test('nhận diện phiếu chuyển nội bộ theo cùng quy tắc với 0004', () => {
  const codes = new Set(['VIX', 'CDT']);
  assert.equal(isInternalTransfer({ kind: 'internal' }, codes), true);
  assert.equal(isInternalTransfer({ kind: 'spend', payee: { is_internal: true } }, codes), true);
  assert.equal(isInternalTransfer({ kind: 'income', auto_created: true }, codes), true);
  assert.equal(isInternalTransfer({ kind: 'spend', payee: { name: 'CDT - Sacombank - 086' } }, codes), true);
  assert.equal(isInternalTransfer({ kind: 'spend', payee: { name: 'NCC Thép' } }, codes), false);
  assert.equal(isInternalLabel('cdt - a - b', codes), true);
  assert.equal(isInternalLabel('XYZ - a - b', codes), false);
  assert.equal(internalPartnerName('Cty CDT', 'TK vay'), 'Cty CDT · TK vay');
});

test('apply: chi chuyển nội bộ thành đối tác internal, phiếu thu tự sinh bỏ đối tác tạm, phần còn lại giữ nguyên', async () => {
  const conn = fakeConn(seedBase());
  const stats = await silently(() => up(conn));

  assert.equal(stats.assigned, 3); // S1, S2, S6
  assert.equal(stats.created, 2); // đối tác internal theo TK đích thường và TK nhóm
  assert.equal(stats.unlinked, 1); // M1
  assert.equal(stats.deleted, 1); // đối tác tạm của B không còn được dùng
  assert.equal(stats.unresolved.length, 2); // S3, S4

  const internal = conn.data.get('partners').filter((p) => p.type === 'internal');
  assert.equal(internal.length, 2);
  const partnerX = internal.find((p) => String(p.internal_account_id) === String(accX));
  assert.equal(partnerX.name, 'Cty CDT · TK vay');
  assert.equal(String(partnerX.company_id), String(cA));
  assert.equal(String(partnerX.internal_company_id), String(cB));
  assert.equal(partnerX.bank_name, 'Sacombank');
  assert.equal(partnerX.account_number, '086');
  assert.equal(partnerX.status, 'active');
  assert.match(partnerX.code, /^DT-\d{4}-00001$/);
  assert.equal(partnerX.migration.migration, '0007');

  const partnerGroup = internal.find((p) => String(p.internal_account_id) === String(accGroup));
  assert.equal(partnerGroup.status, 'inactive');
  assert.match(partnerGroup.code, /^DT-\d{4}-00002$/);

  const s1 = docByCode(conn, 'PC-1');
  const s2 = docByCode(conn, 'PC-2');
  assert.equal(String(s1.partner_id), String(partnerX._id));
  assert.equal(String(s2.partner_id), String(partnerX._id)); // dùng lại, không tạo trùng
  assert.equal(s1.version, 2);
  assert.equal(s1.history.at(-1).action, 'migrate_v2');
  assert.equal(s1.history.at(-1).fields.partner_id.to, String(partnerX._id));

  assert.equal(docByCode(conn, 'PT-1').partner_id, null);
  assert.equal(docByCode(conn, 'PT-1').version, 2);

  // phiếu không xác định được đích: giữ đối tác tạm, không đổi version
  assert.equal(String(docByCode(conn, 'PC-3').partner_id), String(uA));
  assert.equal(String(docByCode(conn, 'PC-4').partner_id), String(uA));
  assert.equal(docByCode(conn, 'PC-3').version, 1);

  // chi thường cho NCC: không đụng
  const n1 = docByCode(conn, 'PC-5');
  assert.equal(String(n1.partner_id), String(uA));
  assert.equal(n1.version, 1);

  // đối tác tạm còn được tham chiếu (PC-3, PC-4, PC-5) ⇒ giữ; đối tác tạm của B không còn ai dùng ⇒ xoá
  const remainingIds = conn.data.get('partners').map((p) => String(p._id));
  assert.ok(remainingIds.includes(String(uA)));
  assert.ok(!remainingIds.includes(String(uB)));

  // rà soát: các phiếu đã sửa được đánh dấu xử lý; phiếu chưa xử lý thì không
  const reviews = conn.data.get('migration_reviews');
  const reviewOf = (ref) => reviews.find((r) => r.collection === 'documents' && r.ref_id === String(ref));
  assert.equal(reviewOf(oid(0x3001)).resolved, true);
  assert.equal(reviewOf(oid(0x3003)).resolved, true);
  assert.equal(reviewOf(oid(0x3004)).resolved, false);
  assert.equal(reviews.find((r) => r.collection === 'partners').resolved, true);
});

test('chạy lại không đổi gì (idempotent)', async () => {
  const conn = fakeConn(seedBase());
  await silently(() => up(conn));
  const partnersAfterFirst = conn.data.get('partners').length;
  const docsAfterFirst = JSON.stringify(conn.data.get('documents'));

  const stats = await silently(() => up(conn));
  assert.deepEqual(
    { assigned: stats.assigned, unlinked: stats.unlinked, created: stats.created, deleted: stats.deleted },
    { assigned: 0, unlinked: 0, created: 0, deleted: 0 },
  );
  assert.equal(conn.data.get('partners').length, partnersAfterFirst);
  assert.equal(JSON.stringify(conn.data.get('documents')), docsAfterFirst);
});

test('đối tác tạm do người dùng gán tay vẫn còn tham chiếu thì không bị xoá; đối tác nội bộ có sẵn được dùng lại', async () => {
  const seed = seedBase();
  // người dùng đã tạo sẵn đối tác internal cho TK đích và gán một phiếu thu thủ công vào đối tác tạm của B
  const existing = { _id: oid(0x4001), company_id: cA, code: 'DT-2026-00009', type: 'internal', status: 'active', name: 'Cty CDT · TK vay', name_key: 'cty cdt · tk vay', internal_company_id: cB, internal_account_id: accX, history: [] };
  seed.partners.push(existing);
  seed.documents.push({ _id: oid(0x3010), code: 'PT-9', kind: 'income', company_id: cB, partner_id: uB, version: 1, history: [], payee: { name: 'Khách lẻ' }, target: null });
  const conn = fakeConn(seed);

  const stats = await silently(() => up(conn));
  assert.equal(stats.created, 1); // chỉ tạo đối tác TK nhóm; TK vay dùng lại đối tác có sẵn
  assert.equal(String(docByCode(conn, 'PC-1').partner_id), String(existing._id));
  assert.equal(conn.data.get('partners').some((p) => String(p._id) === String(uB)), true); // còn PT-9 tham chiếu
});

test('thiếu đối tác tạm 0004 (chưa chạy 0004) thì không làm gì', async () => {
  const seed = seedBase();
  seed.partners = [];
  const conn = fakeConn(seed);
  const stats = await silently(() => up(conn));
  assert.equal(stats.assigned + stats.unlinked + stats.created + stats.deleted, 0);
});
