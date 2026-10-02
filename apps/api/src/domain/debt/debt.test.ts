import { describe, expect, it } from 'vitest';
import { debtAgingBucket, debtStatus, linkDocumentIds, linkItems, settledFromLinks, toBigInt, type LinkedDocInfo } from './index.ts';

function docs(entries: [string, string, bigint][]): Map<string, LinkedDocInfo> {
  return new Map(
    entries.map(([id, status, amount_minor]) => [
      id,
      { _id: id, code: id, title: '', kind: 'spend', status, amount_minor, currency: 'VND' },
    ]),
  );
}

describe('debt › liên kết cấn trừ động', () => {
  it('chỉ tính liên kết có phiếu ở trạng thái paid', () => {
    const links = [
      { document_id: 'd1', amount_minor: 100n },
      { document_id: 'd2', amount_minor: 50n },
      { document_id: 'd3', amount_minor: 30n },
    ];
    const map = docs([
      ['d1', 'paid', 100n],
      ['d2', 'pending.gd', 50n],
      ['d3', 'paid', 30n],
    ]);
    expect(settledFromLinks(links, map)).toBe(130n);
  });

  it('gỡ liên kết ⇒ không còn được tính', () => {
    const map = docs([['d1', 'paid', 100n]]);
    expect(settledFromLinks([{ document_id: 'd1', amount_minor: 100n }], map)).toBe(100n);
    expect(settledFromLinks([], map)).toBe(0n);
  });

  it('chuẩn hoá dữ liệu Mongo: linkItems/linkDocumentIds an toàn với giá trị lạ', () => {
    expect(linkItems(undefined)).toEqual([]);
    expect(linkItems({})).toEqual([]);
    expect(linkDocumentIds([{ document_id: 'x' }, { document_id: 'y' }])).toEqual(['x', 'y']);
    expect(toBigInt('123')).toBe(123n);
    expect(toBigInt(45)).toBe(45n);
  });

  it('trạng thái công nợ theo mức đã cấn trừ', () => {
    expect(debtStatus(100n, 0n)).toBe('open');
    expect(debtStatus(100n, 40n)).toBe('partial');
    expect(debtStatus(100n, 100n)).toBe('settled');
  });

  it('tuổi nợ theo số ngày quá hạn', () => {
    expect(debtAgingBucket(0)).toBe('none');
    expect(debtAgingBucket(10)).toBe('lt30');
    expect(debtAgingBucket(45)).toBe('d30_60');
    expect(debtAgingBucket(75)).toBe('d60_90');
    expect(debtAgingBucket(120)).toBe('gt90');
  });
});
