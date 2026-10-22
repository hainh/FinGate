import { describe, expect, it } from 'vitest';
import { decisionPackQuery, documentCreateBody, loanTerms } from '../src/contracts/documents.js';

const OID = 'a'.repeat(24);

/** Phương án đảo hạn tối thiểu hợp lệ, chỉ đổi lãi suất mới. */
const rolloverWithRate = (new_rate?: string) => ({
  kind: 'rollover',
  title: 'Đảo hạn',
  purpose: 'Gia hạn khoản vay',
  amount: { amount_minor: '30000000', currency: 'VND' },
  source: { fund: 'bank', account_id: OID },
  planned_date: '2026-10-21',
  partner_id: OID,
  loan_id: OID,
  rollover: {
    need_amount: { amount_minor: '30000000', currency: 'VND', decimals: 0 },
    plan: 'Gia hạn 12 tháng',
    new_maturity_date: '2027-10-21',
    ...(new_rate === undefined ? {} : { new_rate }),
  },
});

describe('lãi suất — một quy tắc: số, tối đa 2 chữ số thập phân (docs/02_design_system.md)', () => {
  it('phương án đảo hạn: lãi suất mới chỉ nhận số (dấu phẩy hoặc chấm, tối đa 2 chữ số thập phân)', () => {
    for (const rate of ['9,5', '9.5', '9,55', '12']) expect(documentCreateBody.safeParse(rolloverWithRate(rate)).success, rate).toBe(true);
    for (const rate of ['abc', '9,555', '12,']) expect(documentCreateBody.safeParse(rolloverWithRate(rate)).success, rate).toBe(false);
    expect(documentCreateBody.safeParse(rolloverWithRate()).success).toBe(true);
  });

  it('điều khoản khoản vay (R2 / R3 / thủ công): cùng quy tắc, từ chối 3–4 chữ số thập phân', () => {
    for (const rate of ['9,5', '9.5', '9,55']) expect(loanTerms.safeParse({ interest_rate: rate }).success, rate).toBe(true);
    for (const rate of ['9,555', '9,5555', 'abc']) expect(loanTerms.safeParse({ interest_rate: rate }).success, rate).toBe(false);
  });
});

describe('decision-pack — tham số TK đang chọn ở cấp duyệt', () => {
  it('nhận id tài khoản hợp lệ hoặc bỏ trống; từ chối id sai định dạng', () => {
    expect(decisionPackQuery.safeParse({}).success).toBe(true);
    expect(decisionPackQuery.safeParse({ source_account_id: OID }).success).toBe(true);
    expect(decisionPackQuery.safeParse({ source_account_id: 'tk-sai' }).success).toBe(false);
  });
});
