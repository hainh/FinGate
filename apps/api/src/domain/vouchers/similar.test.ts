import { describe, expect, it } from 'vitest';
import { scoreSimilarDocuments, type SimilarCandidate, type SimilarInput } from './similar.ts';

const PARTNER_ID = '6650a1b2c3d4e5f607080901';
const ID_A = '6650a1b2c3d4e5f60708090a';
const ID_B = '6650a1b2c3d4e5f60708090b';
const ID_C = '6650a1b2c3d4e5f60708090c';

/** Số tiền chuẩn: 100.000.000 VND (minor, decimals 0). ±5% ⇒ [95.000.000 ; 105.000.000]. */
const BASE = 100_000_000n;

const input = (over: Partial<SimilarInput> = {}): SimilarInput => ({
  amountMinor: BASE,
  currency: 'VND',
  partnerId: PARTNER_ID,
  partnerName: 'Công ty ABC',
  limit: 20,
  ...over,
});

const cand = (over: Partial<SimilarCandidate> & { _id: string; minor: bigint; currency?: string }): SimilarCandidate => ({
  code: `PC-2026-${over._id.slice(-2)}`,
  kind: over.kind ?? 'spend',
  status: over.status ?? 'pending.pgd',
  title: 'Thanh toán hàng',
  amount: { minor: over.minor, currency: over.currency ?? 'VND', decimals: 0 },
  partner_id: 'partner_id' in over ? over.partner_id ?? null : PARTNER_ID,
  payee_name: over.payee_name ?? 'Công ty ABC',
  partner_name: 'partner_name' in over ? over.partner_name ?? null : 'Công ty ABC',
  created_by_name: 'Nhân viên A',
  created_at: over.created_at ?? '2026-06-01T00:00:00.000Z',
  planned_date: over.planned_date ?? '2026-06-05',
  _id: over._id,
});

describe('scoreSimilarDocuments — ngưỡng tiền ±5% và tiền tệ', () => {
  it('giữ đúng ngưỡng ±5% (so với số tiền đưa vào), loại ngoài ngưỡng — tính số nguyên, biên CHẶN được giữ', () => {
    const candidates = [
      cand({ _id: ID_A, minor: 95_000_000n }), // −5% đúng ⇒ giữ
      cand({ _id: ID_B, minor: 105_000_000n }), // +5% đúng ⇒ giữ
      cand({ _id: ID_C, minor: 94_999_999n }), // ngoài dưới ⇒ loại
      cand({ _id: '6650a1b2c3d4e5f60708090d', minor: 105_000_001n }), // ngoài trên ⇒ loại
    ];
    const rows = scoreSimilarDocuments(input(), candidates);
    expect(rows.map((r) => r._id).sort()).toEqual([ID_A, ID_B]);
  });

  it('chỉ so phiếu CÙNG tiền tệ', () => {
    const candidates = [cand({ _id: ID_A, minor: BASE, currency: 'USD' }), cand({ _id: ID_B, minor: BASE })];
    const rows = scoreSimilarDocuments(input(), candidates);
    expect(rows.map((r) => r._id)).toEqual([ID_B]);
  });

  it('số tiền đưa vào không hợp lệ (<= 0) ⇒ không có kết quả', () => {
    expect(scoreSimilarDocuments(input({ amountMinor: 0n }), [cand({ _id: ID_A, minor: 0n })])).toEqual([]);
  });
});

describe('scoreSimilarDocuments — khớp đối tác và matched_by', () => {
  it('phiếu có partner_id khớp ⇒ matched_by = partner_id', () => {
    const rows = scoreSimilarDocuments(input(), [cand({ _id: ID_A, minor: BASE })]);
    expect(rows[0]).toMatchObject({ matched_by: 'partner_id', exact_amount: true });
  });

  it('phiếu CŨ không có partner_id ⇒ matched_by = payee_name, kể cả tên viết khác hoa/thường và khoảng trắng thừa', () => {
    const legacy = cand({ _id: ID_A, minor: 102_000_000n, partner_id: null, partner_name: '  công   TY  abc  ' });
    const rows = scoreSimilarDocuments(input(), [legacy]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ matched_by: 'payee_name', partner_id: null, partner_name: '  công   TY  abc  ' });
  });

  it('phiếu có partner_id KHÁC đối tác thì bỏ, dù tên thụ nộp trùng', () => {
    const other = cand({ _id: ID_A, minor: BASE, partner_id: '6650a1b2c3d4e5f607080999', partner_name: 'Đối tác khác' });
    expect(scoreSimilarDocuments(input(), [other])).toEqual([]);
  });

  it('phiếu cũ nhưng tên thụ nộp khác (sau chuẩn hoá) ⇒ bỏ', () => {
    const legacy = cand({ _id: ID_A, minor: BASE, partner_id: null, payee_name: 'Doanh nghiệp XYZ' });
    expect(scoreSimilarDocuments(input(), [legacy])).toEqual([]);
  });
});

describe('scoreSimilarDocuments — thứ tự và các trường dẫn xuất', () => {
  it('đúng số tiền xếp trước, rồi lệch ít hơn trước, rồi mới hơn trước; tie-break theo _id', () => {
    const candidates = [
      cand({ _id: ID_C, minor: 96_000_000n, created_at: '2026-06-09T00:00:00.000Z' }), // lệch 4%
      cand({ _id: ID_A, minor: 99_000_000n, created_at: '2026-06-10T00:00:00.000Z' }), // lệch 1%
      cand({ _id: ID_B, minor: BASE, created_at: '2026-05-01T00:00:00.000Z' }), // đúng tiền, cũ hơn
      cand({ _id: '6650a1b2c3d4e5f6070809ff', minor: 96_000_000n, created_at: '2026-06-09T00:00:00.000Z', partner_id: null }), // cùng lệch, cùng ngày, _id lớn hơn
    ];
    const rows = scoreSimilarDocuments(input(), candidates);
    expect(rows.map((r) => r._id)).toEqual([ID_B, ID_A, ID_C, '6650a1b2c3d4e5f6070809ff']);
  });

  it('cắt theo limit SAU khi sắp xếp (giữ nghi ngờ nhất)', () => {
    const candidates = [
      cand({ _id: ID_A, minor: BASE }),
      cand({ _id: ID_B, minor: 99_000_000n }),
      cand({ _id: ID_C, minor: 96_000_000n }),
    ];
    const rows = scoreSimilarDocuments(input({ limit: 2 }), candidates);
    expect(rows.map((r) => r._id)).toEqual([ID_A, ID_B]);
  });

  it('hiệu có dấu (ứng viên − đưa vào) và % làm tròn 1 chữ số thập phân', () => {
    const candidates = [
      cand({ _id: ID_A, minor: 103_333_333n }), // +3.333333% ⇒ 3.3
      cand({ _id: ID_B, minor: 97_000_000n }), // −3% ⇒ 3
    ];
    const rows = scoreSimilarDocuments(input(), candidates);
    const [a, b] = rows;
    expect(a).toMatchObject({ _id: ID_B, amount_diff_minor: '-3000000', amount_diff_percent: 3 });
    expect(b).toMatchObject({ _id: ID_A, amount_diff_minor: '3333333', amount_diff_percent: 3.3 });
    // tiền trên wire là chuỗi theo minor units
    expect(a?.amount).toEqual({ minor: '97000000', currency: 'VND', decimals: 0 });
  });

  it('lệch 33/700 của số tiền ⇒ 4.714…% làm tròn 4.7', () => {
    const rows = scoreSimilarDocuments(input({ amountMinor: 700n, partnerName: 'X' }), [
      cand({ _id: ID_A, minor: 733n, partner_id: PARTNER_ID, payee_name: 'X', partner_name: 'X' }),
    ]);
    expect(rows[0]).toMatchObject({ amount_diff_minor: '33', amount_diff_percent: 4.7 });
  });

  it('nhãn tiếng Việt từ shared: kind_label / status_label', () => {
    const rows = scoreSimilarDocuments(input(), [cand({ _id: ID_A, minor: BASE, kind: 'income', status: 'approved' })]);
    expect(rows[0]).toMatchObject({ kind: 'income', kind_label: 'Phiếu thu', status: 'approved', status_label: 'Đã duyệt' });
  });
});
