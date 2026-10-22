import { describe, expect, it, vi } from 'vitest';
import { resolveLoanTerms } from '../policy.ts';

vi.mock('../../../db/models.ts', () => ({ Models: {} }));
vi.mock('../../numbering/index.ts', () => ({ nextSequentialCode: vi.fn() }));
vi.mock('../../audit/index.ts', () => ({ buildHistoryEntry: vi.fn(), mirrorAudit: vi.fn() }));
vi.mock('../../events/index.ts', () => ({ emitDomainEvent: vi.fn() }));

import { changedFieldsOf, termFields } from './loan.ts';

describe('khoản vay tự sinh › số HĐ tín dụng và TSĐB là trường riêng (v2 §10.1, §11.4)', () => {
  it('số HĐ tín dụng và TSĐB được ghi vào trường riêng, không chỉ nằm trong ghi chú', () => {
    const terms = resolveLoanTerms({ terms: { contract_no: ' HDTD-2026-01 ', collateral: 'Nhà 12 Lê Lợi' }, baseDate: '2026-10-22' });
    const fields = termFields(terms);
    expect(fields.contract_no).toBe('HDTD-2026-01');
    expect(fields.collateral).toBe('Nhà 12 Lê Lợi');
  });

  it('không nhập số HĐ / TSĐB thì hai trường là null', () => {
    const fields = termFields(resolveLoanTerms({ terms: null, baseDate: '2026-10-22' }));
    expect(fields.contract_no).toBeNull();
    expect(fields.collateral).toBeNull();
  });
});

describe('khoản vay tự sinh › đồng bộ khi sửa phiếu trước duyệt', () => {
  const stored = {
    partner_id: 'p1',
    bank_name: 'BIDV',
    principal_minor: '50000000',
    contract_no: 'HDTD-1',
    collateral: null,
    interest_rate: '9.5',
    term_months: 12,
    maturity_date: '2027-10-22',
  };

  it('chỉ sửa số HĐ tín dụng vẫn là thay đổi cần đồng bộ (trước đây bị bỏ qua)', () => {
    const changed = changedFieldsOf(stored, { ...stored, contract_no: 'HDTD-2' });
    expect(Object.keys(changed)).toEqual(['contract_no']);
    expect(changed.contract_no).toEqual({ from: 'HDTD-1', to: 'HDTD-2' });
  });

  it('chỉ thêm TSĐB vẫn là thay đổi cần đồng bộ', () => {
    expect(Object.keys(changedFieldsOf(stored, { ...stored, collateral: 'Xe ô tô' }))).toEqual(['collateral']);
  });

  it('không đổi gì, hoặc null và chuỗi rỗng cùng coi là trống ⇒ không có thay đổi', () => {
    expect(changedFieldsOf(stored, { ...stored })).toEqual({});
    expect(changedFieldsOf({ collateral: null }, { collateral: '' })).toEqual({});
  });
});
