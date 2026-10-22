/**
 * Đối tác / tag của màn báo cáo theo công ty (reports.tsx, v2 §5, §6.2): lựa chọn của công ty cũ không
 * được áp dụng cho công ty mới. Hàm thuần, không gọi mạng.
 */
import { describe, expect, it } from 'vitest';
import { picksForCompany, type CompanyPicks } from './reports.tsx';

const CTA: CompanyPicks = { companyId: 'cta', partnerId: 'doi-tac-cta', tagIds: ['tag-cta-1', 'tag-cta-2'] };

describe('picksForCompany — đối tác và tag không dùng chung giữa các công ty', () => {
  it('cùng công ty: giữ nguyên lựa chọn', () => {
    expect(picksForCompany(CTA, 'cta')).toBe(CTA);
  });

  it('đổi sang công ty khác: bỏ đối tác và tag của công ty cũ', () => {
    expect(picksForCompany(CTA, 'mayogu')).toEqual({ companyId: 'mayogu', partnerId: null, tagIds: [] });
  });

  it('từ một công ty sang "Toàn tập đoàn" (null) cũng bỏ lựa chọn', () => {
    expect(picksForCompany(CTA, null)).toEqual({ companyId: null, partnerId: null, tagIds: [] });
  });
});
