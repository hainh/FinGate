import { describe, expect, it } from 'vitest';
import {
  accountSearchPattern,
  bankAccountKeyOf,
  findDuplicateHits,
  normalizeAccountNumber,
  normalizeBankName,
  type DuplicateCandidate,
} from './duplicates.ts';

const ID_A = '6650a1b2c3d4e5f607080901';
const ID_B = '6650a1b2c3d4e5f607080902';
const ID_C = '6650a1b2c3d4e5f607080903';

const candidates: DuplicateCandidate[] = [
  { _id: ID_A, code: 'DT-2026-00001', name: 'Công ty ABC', type: 'customer', bank_name: 'Vietcombank', account_number: '0123 456 789' },
  { _id: ID_B, code: 'DT-2026-00002', name: 'BIDV – CN Đông Đô', type: 'bank', bank_name: 'BIDV', account_number: null },
  { _id: ID_C, code: 'DT-2026-00003', name: 'Nhà cung cấp XYZ', type: 'supplier', bank_name: null, account_number: null },
];

describe('chuẩn hoá khoá trùng', () => {
  it('số tài khoản bỏ khoảng trắng / gạch / chấm và không phân biệt hoa thường', () => {
    expect(normalizeAccountNumber(' 0123-456.789 ')).toBe('0123456789');
    expect(normalizeAccountNumber('AB 12/3')).toBe('ab123');
    expect(normalizeAccountNumber('   ')).toBeNull();
    expect(normalizeAccountNumber(null)).toBeNull();
  });

  it('tên ngân hàng gộp khoảng trắng và không phân biệt hoa thường', () => {
    expect(normalizeBankName('  Vietcombank   CN  Hà  Nội ')).toBe('vietcombank cn hà nội');
    expect(normalizeBankName('')).toBeNull();
  });

  it('khoá (ngân hàng, STK) chỉ có khi đủ cả hai và ổn định với cách ghi khác nhau', () => {
    expect(bankAccountKeyOf(' Vietcombank ', '0123 456 789')).toBe(bankAccountKeyOf('vietcombank', '0123456789'));
    expect(bankAccountKeyOf('Vietcombank', null)).toBeNull();
    expect(bankAccountKeyOf(null, '0123456789')).toBeNull();
  });

  it('mẫu truy vấn khớp mọi cách ghi cùng số TK (phân cách, hoa/thường) và không khớp số khác', () => {
    const rx = (v: string): RegExp => new RegExp(accountSearchPattern(v) as string, 'i');
    expect(rx('0123456789').test('0123-456-789')).toBe(true);
    expect(rx(' 0123 456 789 ').test('0123456789')).toBe(true);
    expect(rx('AB.12-cd').test('ab12CD')).toBe(true);
    expect(rx('0123456789').test('01234567890')).toBe(false);
    expect(rx('0123456789').test('x0123456789')).toBe(false);
    expect(accountSearchPattern('')).toBeNull();
  });
});

describe('findDuplicateHits — cảnh báo trùng (không chặn)', () => {
  it('trùng tên khác cách viết (hoa/thường, khoảng trắng) và KỂ CẢ đối tác khác loại', () => {
    const hits = findDuplicateHits({ name: '  công   ty  abc ' }, candidates);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ reason: 'name', partner_id: ID_A, partner_code: 'DT-2026-00001', partner_type: 'customer' });
    expect(hits[0]?.message).toContain('Khách hàng');
  });

  it('trùng cặp (ngân hàng, STK) dù khác tên', () => {
    const hits = findDuplicateHits({ name: 'Tên mới hoàn toàn', bank_name: 'vietcombank', account_number: '0123456789' }, candidates);
    expect(hits).toEqual([expect.objectContaining({ reason: 'bank_account', partner_id: ID_A })]);
  });

  it('cùng STK nhưng KHÁC ngân hàng thì không trùng', () => {
    const hits = findDuplicateHits({ name: 'Khác', bank_name: 'Techcombank', account_number: '0123456789' }, candidates);
    expect(hits).toEqual([]);
  });

  it('chỉ có STK mà không có ngân hàng thì không tính là trùng cặp', () => {
    const hits = findDuplicateHits({ name: 'Khác', bank_name: null, account_number: '0123456789' }, candidates);
    expect(hits).toEqual([]);
  });

  it('khớp cả tên và cặp ngân hàng ⇒ hai cảnh báo cho cùng một đối tác', () => {
    const hits = findDuplicateHits({ name: 'Công ty ABC', bank_name: 'Vietcombank', account_number: '0123456789' }, candidates);
    expect(hits.map((h) => h.reason).sort()).toEqual(['bank_account', 'name']);
    expect(new Set(hits.map((h) => h.partner_id))).toEqual(new Set([ID_A]));
  });

  it('loại trừ chính đối tác đang sửa (exclude_id)', () => {
    const hits = findDuplicateHits({ name: 'Công ty ABC', exclude_id: ID_A }, candidates);
    expect(hits).toEqual([]);
  });

  it('không có tên khớp và không có cặp ngân hàng ⇒ không có cảnh báo', () => {
    expect(findDuplicateHits({ name: 'Không ai trùng' }, candidates)).toEqual([]);
    expect(findDuplicateHits({ name: '' }, candidates)).toEqual([]);
  });

  it('nhiều đối tác cùng tên ⇒ một cảnh báo cho mỗi đối tác', () => {
    const many: DuplicateCandidate[] = [
      ...candidates,
      { _id: '6650a1b2c3d4e5f607080904', code: 'DT-2026-00004', name: 'CÔNG TY ABC', type: 'supplier', bank_name: null, account_number: null },
    ];
    const hits = findDuplicateHits({ name: 'Công ty ABC' }, many);
    expect(hits.map((h) => h.partner_code)).toEqual(['DT-2026-00001', 'DT-2026-00004']);
  });
});
