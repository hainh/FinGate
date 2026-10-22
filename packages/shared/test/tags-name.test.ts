import { describe, expect, it } from 'vitest';
import { normalizeTagDisplayName, tagCreateBody, tagName, tagUpdateBody } from '../src/contracts/tags.js';

// Ký tự vô hình / khoảng trắng đặc biệt dựng bằng mã để file nguồn chỉ chứa ASCII.
const ZWSP = String.fromCharCode(0x200b);
const NBSP = String.fromCharCode(0xa0);

describe('tagName — chuẩn hoá trước khi kiểm độ dài (v2 §6.2)', () => {
  it('chuỗi thô dài hơn 40 nhưng sau khi gộp khoảng trắng còn ≤ 40 thì hợp lệ (tạo và sửa)', () => {
    const padded = `wsprobe${' '.repeat(40)}ok`; // 49 ký tự thô → "wsprobe ok"
    expect(padded.length).toBeGreaterThan(40);
    expect(tagCreateBody.parse({ name: padded }).name).toBe('wsprobe ok');
    expect(tagUpdateBody.parse({ name: padded }).name).toBe('wsprobe ok');
  });

  it('đúng 40 ký tự sau chuẩn hoá được nhận (khoảng trắng đuôi bị bỏ); 41 ký tự bị từ chối', () => {
    expect(tagName.parse(`${'a'.repeat(40)}   `)).toBe('a'.repeat(40));
    const r = tagName.safeParse('a'.repeat(41));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Tên tag tối đa 40 ký tự');
  });

  it('vẫn quá 40 sau khi gộp thì bị từ chối (không cắt cụt tên)', () => {
    // "a" + khoảng trắng + 40 chữ b → sau gộp còn 42 ký tự
    expect(tagName.safeParse(`a${' '.repeat(60)}${'b'.repeat(40)}`).success).toBe(false);
  });

  it('rỗng, chỉ khoảng trắng hoặc chỉ ký tự vô hình thì bị từ chối', () => {
    for (const raw of ['', '   ', `${ZWSP}${NBSP}`]) {
      const r = tagName.safeParse(raw);
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toBe('Tên tag không được để trống');
    }
  });

  it('không phải chuỗi thì bị từ chối', () => {
    expect(tagName.safeParse(123).success).toBe(false);
  });

  it('contract dùng cùng hàm chuẩn hoá với domain: bỏ ký tự vô hình, gộp NBSP, giữ dấu', () => {
    const raw = `  Dự${ZWSP}   án${NBSP}Q3  `;
    expect(normalizeTagDisplayName(raw)).toBe('Dự án Q3');
    expect(tagName.parse(raw)).toBe(normalizeTagDisplayName(raw));
    expect(normalizeTagDisplayName('Dự án'.normalize('NFD'))).toBe('Dự án');
  });
});
