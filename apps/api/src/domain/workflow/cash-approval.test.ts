import { describe, expect, it } from 'vitest';
import { isCashVoucher, resolveCashRequiresKtt, type CashApprovalConfig } from './cash-approval.ts';

const COMPANY_A = 'a'.repeat(24);
const COMPANY_B = 'b'.repeat(24);

describe('resolveCashRequiresKtt — "qua KTT duyệt" theo công ty, MẶC ĐỊNH tắt', () => {
  it('chưa có cấu hình → KHÔNG qua KTT (mặc định tắt)', () => {
    expect(resolveCashRequiresKtt(null, COMPANY_A)).toBe(false);
    expect(resolveCashRequiresKtt(undefined, COMPANY_A)).toBe(false);
    expect(resolveCashRequiresKtt({}, COMPANY_A)).toBe(false);
    expect(resolveCashRequiresKtt({ companies: null }, COMPANY_A)).toBe(false);
  });

  it('công ty không có khoá trong cấu hình → KHÔNG qua KTT', () => {
    const cfg: CashApprovalConfig = { companies: { [COMPANY_A]: true } };
    expect(resolveCashRequiresKtt(cfg, COMPANY_B)).toBe(false);
  });

  it('công ty được tick → qua KTT, các công ty khác giữ nguyên', () => {
    const cfg: CashApprovalConfig = { companies: { [COMPANY_A]: true, [COMPANY_B]: false } };
    expect(resolveCashRequiresKtt(cfg, COMPANY_A)).toBe(true);
    expect(resolveCashRequiresKtt(cfg, COMPANY_B)).toBe(false);
  });

  it('chỉ đúng giá trị true mới bật (bỏ tick = ghi false, không giữ rác)', () => {
    const cfg = { companies: { [COMPANY_A]: 'true', [COMPANY_B]: 1 } } as unknown as CashApprovalConfig;
    expect(resolveCashRequiresKtt(cfg, COMPANY_A)).toBe(false);
    expect(resolveCashRequiresKtt(cfg, COMPANY_B)).toBe(false);
  });

  it('không có công ty → không bật', () => {
    expect(resolveCashRequiresKtt({ companies: { [COMPANY_A]: true } }, null)).toBe(false);
    expect(resolveCashRequiresKtt({ companies: { [COMPANY_A]: true } }, '')).toBe(false);
  });
});

describe('isCashVoucher — phiếu thu/chi quỹ tiền mặt (cash + Quỹ phụ fund)', () => {
  it('phiếu thu / chi với quỹ tiền mặt hoặc Quỹ phụ → đúng là phiếu quỹ tiền mặt', () => {
    expect(isCashVoucher({ kind: 'spend', fund: 'cash' })).toBe(true);
    expect(isCashVoucher({ kind: 'spend', fund: 'fund' })).toBe(true);
    expect(isCashVoucher({ kind: 'income', fund: 'cash' })).toBe(true);
    expect(isCashVoucher({ kind: 'income', fund: 'fund' })).toBe(true);
  });

  it('phiếu thu/chi qua NGÂN HÀNG → không phải phiếu quỹ tiền mặt', () => {
    expect(isCashVoucher({ kind: 'spend', fund: 'bank' })).toBe(false);
    expect(isCashVoucher({ kind: 'income', fund: 'bank' })).toBe(false);
  });

  it('loại khác (đáo hạn, chuyển nội bộ) không áp cài đặt, kể cả khi quỹ là tiền mặt', () => {
    expect(isCashVoucher({ kind: 'rollover', fund: 'cash' })).toBe(false);
    expect(isCashVoucher({ kind: 'internal', fund: 'fund' })).toBe(false);
  });

  it('thiếu loại/quỹ → không phải phiếu quỹ tiền mặt', () => {
    expect(isCashVoucher({ kind: 'spend', fund: null })).toBe(false);
    expect(isCashVoucher({ kind: 'spend', fund: undefined })).toBe(false);
    expect(isCashVoucher({ kind: null, fund: 'cash' })).toBe(false);
    expect(isCashVoucher({ kind: 'spend', fund: 'CASH' })).toBe(false);
  });
});
