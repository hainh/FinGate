/**
 * Kiểm thử migration 0006 (làm sạch lãi suất) bằng bộ nhớ giả lập find/updateOne — không cần MongoDB.
 * Chạy: node --test db/migrations/0006-clean-interest-rates.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { up, cleanRate, RATE_RE } from './0006-clean-interest-rates.js';

/* ----------------------------- bộ nhớ giả lập ----------------------------- */

const getPath = (doc, path) =>
  path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), doc);

function setPath(doc, path, value) {
  const keys = path.split('.');
  let o = doc;
  for (const k of keys.slice(0, -1)) {
    if (o[k] === null || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[keys.at(-1)] = value;
}

/** Chỉ các toán tử migration dùng: equality, $ne (null), $not (regex). */
function matches(doc, filter) {
  return Object.entries(filter).every(([path, want]) => {
    const have = getPath(doc, path);
    if (want && typeof want === 'object' && !(want instanceof RegExp)) {
      return Object.entries(want).every(([op, arg]) => {
        if (op === '$ne') return arg === null ? have !== null && have !== undefined : have !== arg;
        if (op === '$not')
          return !(arg instanceof RegExp && typeof have === 'string' && arg.test(have));
        throw new Error(`toán tử chưa hỗ trợ trong bộ giả lập: ${op}`);
      });
    }
    return have === want;
  });
}

function applyUpdate(doc, update) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, val] of Object.entries(fields)) {
      if (op === '$set') setPath(doc, path, structuredClone(val));
      else if (op === '$push')
        setPath(doc, path, [...(getPath(doc, path) ?? []), structuredClone(val)]);
      else if (op === '$inc') setPath(doc, path, (getPath(doc, path) ?? 0) + val);
      else throw new Error(`toán tử cập nhật chưa hỗ trợ: ${op}`);
    }
  }
}

function project(doc, projection) {
  if (!projection) return structuredClone(doc);
  const out = {};
  for (const path of Object.keys(projection)) {
    const v = getPath(doc, path);
    if (v !== undefined) setPath(out, path, structuredClone(v));
  }
  return out;
}

/** `hooks.afterFind(collection, list)` chạy sau khi find trả kết quả — dùng để mô phỏng sửa đồng thời. */
function makeConn(seed, hooks = {}) {
  const store = new Map(Object.entries(seed).map(([name, docs]) => [name, structuredClone(docs)]));
  const list = (name) => {
    if (!store.has(name)) store.set(name, []);
    return store.get(name);
  };
  return {
    store,
    collection(name) {
      return {
        find(filter, opts = {}) {
          return {
            toArray: async () => {
              const rows = list(name)
                .filter((d) => matches(d, filter))
                .map((d) => project(d, opts.projection));
              hooks.afterFind?.(name, list(name));
              return rows;
            },
          };
        },
        async updateOne(filter, update) {
          const doc = list(name).find((d) => matches(d, filter));
          if (!doc) return { matchedCount: 0, modifiedCount: 0 };
          applyUpdate(doc, update);
          return { matchedCount: 1, modifiedCount: 1 };
        },
      };
    },
  };
}

/** Im log trong lúc chạy migration (migration in tiến trình ra console). */
async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

const byId = (rows, id) => rows.find((r) => r._id === id);
const lastHistory = (doc) => doc.history.at(-1);

/* --------------------------------- cleanRate -------------------------------- */

test('RATE_RE khớp đúng quy tắc 2 chữ số thập phân', () => {
  for (const ok of ['9', '9,5', '9,50', '9.5', '09,5', '0', '12,34']) assert.match(ok, RATE_RE, ok);
  for (const bad of ['9,555', '9.555', 'abc', '9%', '', '-1', '1e3', ' 9,5'])
    assert.doesNotMatch(bad, RATE_RE, bad);
});

test('cleanRate giữ nguyên giá trị đã đúng và null', () => {
  for (const v of ['9,5', '9.50', '12', '0', '09,5'])
    assert.deepEqual(cleanRate(v, '0'), { value: v, status: 'ok' }, v);
  assert.deepEqual(cleanRate(null, '0'), { value: null, status: 'ok' });
  assert.deepEqual(cleanRate(undefined, null), { value: null, status: 'ok' });
});

test('cleanRate làm tròn nửa lên bằng số học thập phân (không qua float)', () => {
  const cases = [
    ['9,555', '9,56'], // 9.555 trong float là 9.54999…, phải vẫn làm tròn lên
    ['9.555', '9,56'],
    ['9,999', '10'],
    ['0,004', '0'],
    ['0,005', '0,01'],
    ['12,350', '12,35'],
    ['9,5000', '9,5'],
    ['1234,5678', '1234,57'],
  ];
  for (const [input, expected] of cases)
    assert.deepEqual(cleanRate(input, '0'), { value: expected, status: 'rounded' }, input);
});

test('cleanRate bỏ ký hiệu thừa và đổi kiểu số về dạng chuỗi', () => {
  assert.deepEqual(cleanRate('9,5%', '0'), { value: '9,5', status: 'normalized' });
  assert.deepEqual(cleanRate(' 9,5 % ', '0'), { value: '9,5', status: 'normalized' });
  assert.deepEqual(cleanRate('9.5%', '0'), { value: '9,5', status: 'normalized' });
  assert.deepEqual(cleanRate('.5', '0'), { value: '0,5', status: 'normalized' });
  assert.deepEqual(cleanRate(9.5, '0'), { value: '9,5', status: 'normalized' });
});

test('cleanRate trả giá trị không đọc được về mặc định của trường', () => {
  for (const bad of ['abc', '', '1e3', '-2', '9%/năm', '1.000,5']) {
    assert.deepEqual(cleanRate(bad, '0'), { value: '0', status: 'unreadable' }, bad);
    assert.deepEqual(cleanRate(bad, null), { value: null, status: 'unreadable' }, bad);
  }
});

/* ------------------------------------ up ------------------------------------ */

const LOAN_OK = {
  _id: 'b-ok',
  code: 'NHD-OK',
  interest_rate: '9,5',
  status: 'active',
  history: [],
};
const LOAN_ROUND = {
  _id: 'b-round',
  code: 'NHD-2026-02111',
  interest_rate: '9,555',
  status: 'pending_disbursement',
  history: [],
};
const LOAN_ABC = {
  _id: 'b-abc',
  code: 'NHD-ABC',
  interest_rate: 'abc',
  status: 'active',
  history: [],
};
const LOAN_NULL = {
  _id: 'b-null',
  code: 'NHD-NULL',
  interest_rate: null,
  status: 'active',
  history: [],
};

const DOC_DRAFT_ABC = {
  _id: 'd-abc',
  code: 'DRAFT-ABC',
  kind: 'rollover',
  status: 'draft',
  version: 3,
  rollover: { plan: 'x', new_rate: 'abc', result: null },
  history: [],
};
const DOC_DRAFT_OK = {
  _id: 'd-ok',
  code: 'DRAFT-OK',
  kind: 'rollover',
  status: 'draft',
  version: 1,
  rollover: { plan: 'x', new_rate: '9,20', result: null },
  history: [],
};
const DOC_INCOME_TERMS = {
  _id: 'd-terms',
  code: 'DRAFT-TERMS',
  kind: 'income',
  status: 'draft',
  version: 1,
  options: { loan: { kind: 'borrow', terms: { interest_rate: '9,555', term_months: 12 } } },
  history: [],
};
const DOC_RESULT = {
  _id: 'd-result',
  code: 'DONE-RESULT',
  kind: 'rollover',
  status: 'executed',
  version: 2,
  rollover: { plan: 'x', new_rate: null, result: { new_rate: '8,777', new_contract_code: 'HD-1' } },
  history: [],
};

function seedAll() {
  return {
    bank_debts: [LOAN_OK, LOAN_ROUND, LOAN_ABC, LOAN_NULL],
    documents: [DOC_DRAFT_ABC, DOC_DRAFT_OK, DOC_INCOME_TERMS, DOC_RESULT],
  };
}

test('up làm sạch đúng các trường vi phạm và bỏ qua giá trị đúng', async () => {
  const conn = makeConn(seedAll());
  const totals = await quietly(() => up(conn));

  const loans = conn.store.get('bank_debts');
  assert.equal(byId(loans, 'b-round').interest_rate, '9,56');
  assert.equal(byId(loans, 'b-abc').interest_rate, '0');
  assert.equal(byId(loans, 'b-ok').interest_rate, '9,5');
  assert.equal(byId(loans, 'b-null').interest_rate, null);
  assert.equal(byId(loans, 'b-ok').history.length, 0, 'bản ghi đúng không được thêm lịch sử');
  assert.equal(byId(loans, 'b-round').version, undefined, 'khoản nợ ngân hàng không có version');

  const docs = conn.store.get('documents');
  assert.equal(byId(docs, 'd-abc').rollover.new_rate, null);
  assert.equal(byId(docs, 'd-ok').rollover.new_rate, '9,20');
  assert.equal(byId(docs, 'd-terms').options.loan.terms.interest_rate, '9,56');
  assert.equal(byId(docs, 'd-result').rollover.result.new_rate, '8,78');

  assert.deepEqual(totals['bank_debts.interest_rate'], {
    rounded: 1,
    normalized: 0,
    unreadable: 1,
    conflict: 0,
  });
  assert.deepEqual(totals['documents.rollover.new_rate'], {
    rounded: 0,
    normalized: 0,
    unreadable: 1,
    conflict: 0,
  });
  assert.deepEqual(totals['documents.rollover.result.new_rate'], {
    rounded: 1,
    normalized: 0,
    unreadable: 0,
    conflict: 0,
  });
  assert.deepEqual(totals['documents.options.loan.terms.interest_rate'], {
    rounded: 1,
    normalized: 0,
    unreadable: 0,
    conflict: 0,
  });
});

test('up ghi lịch sử trước → sau và tăng version của phiếu', async () => {
  const conn = makeConn(seedAll());
  await quietly(() => up(conn));
  const docs = conn.store.get('documents');
  const loans = conn.store.get('bank_debts');

  const h = lastHistory(byId(loans, 'b-round'));
  assert.equal(h.action, 'update');
  assert.equal(h.actor.name, 'Migration 0006');
  assert.equal(h.request_id, 'migration-0006');
  assert.deepEqual(h.fields.changes, { interest_rate: { from: '9,555', to: '9,56' } });
  assert.deepEqual(h.fields.changed, ['interest_rate']);
  assert.match(h.reason, /Làm tròn/);

  const hAbc = lastHistory(byId(loans, 'b-abc'));
  assert.deepEqual(hAbc.fields.changes, { interest_rate: { from: 'abc', to: '0' } });

  const dAbc = byId(docs, 'd-abc');
  assert.equal(dAbc.version, 4, 'phiếu tăng version để ETag/If-Match cũ bị từ chối');
  assert.deepEqual(lastHistory(dAbc).fields.changes, {
    'rollover.new_rate': { from: 'abc', to: null },
  });
  assert.equal(byId(docs, 'd-ok').version, 1, 'phiếu đúng không đổi version');
  assert.equal(byId(docs, 'd-terms').version, 2);
  assert.equal(byId(docs, 'd-result').version, 3);
});

test('up chạy lại là idempotent: không thêm lịch sử, không tăng version', async () => {
  const conn = makeConn(seedAll());
  await quietly(() => up(conn));
  const snapshot = structuredClone([...conn.store.entries()]);
  const second = await quietly(() => up(conn));
  assert.deepEqual([...conn.store.entries()], snapshot);
  for (const stat of Object.values(second))
    assert.equal(stat.rounded + stat.normalized + stat.unreadable + stat.conflict, 0);
});

test('up không ghi đè khi trường đã bị sửa đồng thời (CAS)', async () => {
  let injected = false;
  const conn = makeConn(seedAll(), {
    afterFind(name, list) {
      // sau khi đã đọc vi phạm, người khác sửa khoản vay sang giá trị hợp lệ khác
      if (name !== 'bank_debts' || injected) return;
      injected = true;
      setPath(
        list.find((d) => d._id === 'b-round'),
        'interest_rate',
        '7,1',
      );
    },
  });
  const totals = await quietly(() => up(conn));
  const loan = byId(conn.store.get('bank_debts'), 'b-round');
  assert.equal(loan.interest_rate, '7,1', 'giá trị sửa đồng thời được giữ nguyên');
  assert.equal(loan.history.length, 0, 'không ghi lịch sử giả');
  assert.equal(totals['bank_debts.interest_rate'].conflict, 1);
});
