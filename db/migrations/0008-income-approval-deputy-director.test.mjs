/**
 * Kiểm thử migration 0008 (thêm bước PGĐ vào ma trận duyệt phiếu thu) bằng bộ nhớ giả lập — không cần MongoDB.
 * Chạy: node --test db/migrations/0008-income-approval-deputy-director.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { up, isLegacyIncomeChain, withDeputyDirector } from './0008-income-approval-deputy-director.js';

/* ----------------------------- bộ nhớ giả lập ----------------------------- */

function clone(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

const getPath = (doc, path) => path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), doc);
const setPath = (doc, path, value) => {
  const keys = path.split('.');
  let o = doc;
  for (const k of keys.slice(0, -1)) {
    if (o[k] === null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
};

const eq = (a, b) => (a === null || a === undefined || b === null || b === undefined ? (a ?? null) === (b ?? null) : a === b);

/** Chỉ toán tử migration 0008 dùng: equality trên `_id`, `doc_kind` và so nguyên mảng `steps`. */
function matches(doc, filter) {
  return Object.entries(filter).every(([path, want]) => {
    const have = getPath(doc, path);
    if (Array.isArray(want)) return JSON.stringify(have) === JSON.stringify(want);
    return eq(have, want);
  });
}

function fakeConn(seed) {
  const data = new Map(Object.entries(seed).map(([k, rows]) => [k, rows.map(clone)]));
  return {
    data,
    collection(name) {
      const rowsOf = () => {
        if (!data.has(name)) data.set(name, []);
        return data.get(name);
      };
      return {
        find(filter = {}) {
          const out = rowsOf().filter((d) => matches(d, filter)).map(clone);
          return { toArray: async () => out };
        },
        async updateOne(filter, update) {
          const d = rowsOf().find((x) => matches(x, filter));
          if (!d) return { matchedCount: 0, modifiedCount: 0 };
          for (const [path, val] of Object.entries(update.$set ?? {})) setPath(d, path, clone(val));
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
    },
  };
}

/* ------------------------------- dữ liệu mẫu ------------------------------ */

const legacySteps = () => [
  { order: 1, role: 'chief_accountant', sla_hours: 24, mandatory: true },
  { order: 2, role: 'director', sla_hours: 48, mandatory: true },
  { order: 3, role: 'deputy_chairman', sla_hours: 48, mandatory: true },
];

const row = (id, steps, extra = {}) => ({
  _id: id,
  doc_kind: 'income',
  steps,
  label: 'Khoản thu — KTT → GĐ → P.TGĐ',
  ...extra,
});

/* --------------------------------- kiểm thử -------------------------------- */

test('nhận diện đúng hình dạng chuỗi mặc định CŨ của phiếu thu', () => {
  assert.equal(isLegacyIncomeChain(legacySteps()), true);
  // đã có PGĐ → không phải hình dạng cũ
  assert.equal(isLegacyIncomeChain(withDeputyDirector(legacySteps())), false);
  // thứ tự khác → cấu hình tay, không đụng
  assert.equal(isLegacyIncomeChain([legacySteps()[1], legacySteps()[0], legacySteps()[2]]), false);
  // thiếu cấp
  assert.equal(isLegacyIncomeChain(legacySteps().slice(0, 2)), false);
  assert.equal(isLegacyIncomeChain(null), false);
});

test('withDeputyDirector chèn PGĐ ngay sau KTT và đánh số lại liên tục', () => {
  const out = withDeputyDirector(legacySteps());
  assert.deepEqual(
    out.map((s) => s.role),
    ['chief_accountant', 'deputy_director', 'director', 'deputy_chairman'],
  );
  assert.deepEqual(
    out.map((s) => s.order),
    [1, 2, 3, 4],
  );
  // giữ nguyên SLA của các bước cũ
  assert.equal(out.find((s) => s.role === 'director').sla_hours, 48);
  assert.equal(out.find((s) => s.role === 'deputy_director').sla_hours, 24);
});

test('up chèn PGĐ vào dòng income cũ và đổi nhãn mặc định', async () => {
  const conn = fakeConn({ approval_matrix: [row('m1', legacySteps())] });
  await up(conn);
  const [m1] = conn.data.get('approval_matrix');
  assert.deepEqual(
    m1.steps.map((s) => s.role),
    ['chief_accountant', 'deputy_director', 'director', 'deputy_chairman'],
  );
  assert.equal(m1.label, 'Khoản thu — KTT → PGĐ → GĐ → P.TGĐ');
});

test('up giữ nguyên nhãn người dùng tự đặt', async () => {
  const conn = fakeConn({ approval_matrix: [row('m1', legacySteps(), { label: 'Quy trình thu riêng' })] });
  await up(conn);
  assert.equal(conn.data.get('approval_matrix')[0].label, 'Quy trình thu riêng');
});

test('up không đụng dòng đã có PGĐ, dòng cấu hình khác, hay loại hồ sơ khác', async () => {
  const already = withDeputyDirector(legacySteps());
  const custom = [
    { order: 1, role: 'chief_accountant', sla_hours: 24, mandatory: true },
    { order: 2, role: 'chairman', sla_hours: 24, mandatory: true },
  ];
  const conn = fakeConn({
    approval_matrix: [
      row('m1', already),
      row('m2', custom),
      { _id: 'm3', doc_kind: 'spend', steps: legacySteps(), label: 'Chi' },
    ],
  });
  await up(conn);
  const rows = conn.data.get('approval_matrix');
  assert.deepEqual(rows.find((r) => r._id === 'm1').steps, already);
  assert.deepEqual(rows.find((r) => r._id === 'm2').steps, custom);
  assert.deepEqual(rows.find((r) => r._id === 'm3').steps, legacySteps());
});

test('chạy lại là idempotent: không chèn PGĐ lần hai', async () => {
  const conn = fakeConn({ approval_matrix: [row('m1', legacySteps())] });
  await up(conn);
  const after1 = clone(conn.data.get('approval_matrix'));
  await up(conn);
  assert.deepEqual(conn.data.get('approval_matrix'), after1);
});

test('up áp cho mọi công ty, kể cả dòng dùng chung (company_id = null)', async () => {
  const conn = fakeConn({ approval_matrix: [row('a', legacySteps()), row('b', legacySteps()), row('c', legacySteps())] });
  await up(conn);
  for (const r of conn.data.get('approval_matrix')) {
    assert.equal(r.steps.filter((s) => s.role === 'deputy_director').length, 1);
  }
  assert.equal(conn.data.get('approval_matrix').length, 3);
});
