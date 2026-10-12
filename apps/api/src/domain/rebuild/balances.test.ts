import { describe, expect, it } from 'vitest';
import { orphanDocumentIds } from './balances.ts';

describe('rebuild · orphanDocumentIds', () => {
  it('trả về id có bút toán nhưng hồ sơ đã bị xoá', () => {
    expect(orphanDocumentIds(['d1', 'd2', 'd3'], ['d1'])).toEqual(['d2', 'd3']);
  });

  it('khử trùng và giữ nguyên khi mọi hồ sơ còn sống', () => {
    expect(orphanDocumentIds(['d1', 'd1', 'd2'], ['d1', 'd2'])).toEqual([]);
  });

  it('mọi hồ sơ đều mất → trả về toàn bộ id duy nhất', () => {
    expect(orphanDocumentIds(['d1', 'd2', 'd1'], [])).toEqual(['d1', 'd2']);
  });
});
