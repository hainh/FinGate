import { describe, expect, it } from 'vitest';
import { daysLabel, maturity, maturityChipParts, maturityLabel } from '../src/status/index.js';

const GLYPHS = /[⛔⚠▲]/g;

describe('chip đáo hạn — một biểu tượng (v2 §10.1, DS §3.3)', () => {
  it('maturityChipParts: biểu tượng mức + nhãn số ngày, không kèm glyph trong text', () => {
    expect(maturityChipParts(-15)).toEqual({ glyph: '⛔', text: 'qua hạn 15 ngày' });
    expect(maturityChipParts(0)).toEqual({ glyph: '⛔', text: 'hôm nay' });
    expect(maturityChipParts(2)).toEqual({ glyph: '⛔', text: 'còn 2 ngày' });
    expect(maturityChipParts(5)).toEqual({ glyph: '⚠', text: 'còn 5 ngày' });
    expect(maturityChipParts(10)).toEqual({ glyph: '▲', text: 'còn 10 ngày' });
    expect(maturityChipParts(60)).toEqual({ glyph: '·', text: 'còn 2 tháng' });
  });

  it('nhãn đầy đủ (aria-label, API) có đúng một biểu tượng: "⛔ qua hạn 15 ngày", "▲ còn 10 ngày"', () => {
    expect(maturityLabel(-15)).toBe('⛔ qua hạn 15 ngày');
    expect(maturityLabel(10)).toBe('▲ còn 10 ngày');
    expect(maturityLabel(60)).toBe('còn 2 tháng');
  });

  it('chip = glyph + text khớp maturityLabel, và mọi mức đều chỉ có tối đa một biểu tượng', () => {
    for (const d of [-15, -1, 0, 1, 2, 3, 4, 7, 8, 30, 31, 90]) {
      const { glyph, text } = maturityChipParts(d);
      const expected = maturity(d).glyph ? `${glyph} ${text}` : text;
      expect(maturityLabel(d), `nhãn đầy đủ ${d} ngày`).toBe(expected);
      expect(text, `text chip ${d} ngày không lặp biểu tượng`).toBe(daysLabel(d));
      expect(`${glyph} ${text}`.match(GLYPHS)?.length ?? 0, `số biểu tượng ${d} ngày`).toBeLessThanOrEqual(1);
    }
  });
});
