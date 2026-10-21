import { describe, expect, it } from 'vitest';
import { ApiError, normalizeNameKey } from '@fingate/shared';
import { TAG_NAME_MAX, changedFields, normalizeTagName, replaceTagIds } from './normalize.ts';

// Ký tự vô hình / khoảng trắng đặc biệt dựng bằng mã để file nguồn chỉ chứa ASCII.
const ZWSP = String.fromCharCode(0x200b);
const NBSP = String.fromCharCode(0xa0);

function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('kỳ vọng ném ApiError nhưng không ném');
}

describe('normalizeTagName — chuẩn hoá tên tag (v2 §6.2)', () => {
  it('bỏ khoảng trắng đầu/cuối và gộp khoảng trắng bên trong', () => {
    expect(normalizeTagName('   Dự   án  A  ').name).toBe('Dự án A');
  });

  it('coi NBSP và tab là khoảng trắng thường', () => {
    expect(normalizeTagName(`Công${NBSP}trình\tX`).name).toBe('Công trình X');
  });

  it('bỏ ký tự vô hình hay dính khi copy/paste', () => {
    expect(normalizeTagName(`Dự${ZWSP} án`).name).toBe('Dự án');
  });

  it('không phân biệt hoa thường: name_key giống nhau', () => {
    expect(normalizeTagName('DỰ ÁN Q3').name_key).toBe(normalizeTagName('dự án q3').name_key);
    expect(normalizeTagName('  Dự   án   Q3 ').name_key).toBe(normalizeTagName('dự án q3').name_key);
  });

  it('giữ dấu tiếng Việt: "Dự án" khác "Du an" (không bỏ dấu)', () => {
    expect(normalizeTagName('Dự án').name_key).not.toBe(normalizeTagName('Du an').name_key);
  });

  it('NFC và NFD của cùng một chữ cho cùng tên và cùng khoá', () => {
    const nfc = 'Dự án'.normalize('NFC');
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc); // kiểm tra chính test: chuỗi NFD thật sự khác
    expect(normalizeTagName(nfd).name).toBe(nfc);
    expect(normalizeTagName(nfd).name_key).toBe(normalizeTagName(nfc).name_key);
  });

  it('name_key trùng với normalizeNameKey dùng chung của shared', () => {
    expect(normalizeTagName('  Công   Trình  ').name_key).toBe(normalizeNameKey('  Công   Trình  '));
    expect(normalizeTagName('  Công   Trình  ').name_key).toBe('công trình');
  });

  it('chấp nhận đúng 40 ký tự, từ chối 41', () => {
    expect(normalizeTagName('a'.repeat(TAG_NAME_MAX)).name).toHaveLength(TAG_NAME_MAX);
    const err = errorOf(() => normalizeTagName('a'.repeat(TAG_NAME_MAX + 1)));
    expect(err.code).toBe('FG-VAL-001');
    expect(err.errors?.name).toContain(String(TAG_NAME_MAX));
  });

  it('rỗng, chỉ khoảng trắng, chỉ ký tự vô hình, hoặc thiếu đều bị từ chối', () => {
    for (const raw of ['', '   ', `${ZWSP}${NBSP}`, undefined, null]) {
      const err = errorOf(() => normalizeTagName(raw));
      expect(err.code).toBe('FG-VAL-001');
      expect(err.errors?.name).toBeTruthy();
    }
  });

  it('độ dài tính sau khi gộp khoảng trắng: chuỗi dài nhưng rút gọn được vẫn hợp lệ', () => {
    const padded = `a${' '.repeat(60)}b`; // 62 ký tự thô, sau gộp còn "a b"
    expect(normalizeTagName(padded).name).toBe('a b');
  });
});

describe('replaceTagIds — gộp tag trên phiếu, không trùng lặp', () => {
  it('thay nguồn bằng đích và giữ thứ tự', () => {
    expect(replaceTagIds(['a', 'b', 'c'], 'b', 'z')).toEqual(['a', 'z', 'c']);
  });

  it('đích đã có sẵn thì chỉ bỏ nguồn, không nhân đôi', () => {
    expect(replaceTagIds(['a', 'b', 'c'], 'b', 'c')).toEqual(['a', 'c']);
  });

  it('dữ liệu cũ có tag lặp trong một phiếu cũng được gộp', () => {
    expect(replaceTagIds(['b', 'a', 'b'], 'b', 'a')).toEqual(['a']);
  });

  it('không có tag nguồn trong phiếu thì giữ nguyên', () => {
    expect(replaceTagIds(['a'], 'x', 'y')).toEqual(['a']);
  });
});

describe('changedFields — diff để ghi audit', () => {
  it('chỉ liệt kê trường thực sự đổi và bỏ qua trường không yêu cầu đổi', () => {
    const diff = changedFields(
      { name: 'A', color: '#000000', hidden: false },
      { name: 'A', color: '#ffffff', hidden: undefined },
    );
    expect(diff).toEqual({ color: { from: '#000000', to: '#ffffff' } });
  });
});

