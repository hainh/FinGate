/**
 * FgSegmented (components/uitk.tsx): `value={null}` = chưa chọn mục nào; `value={undefined}` = không điều khiển,
 * antd rơi về mục đầu tiên (nguyên nhân lỗi form công nợ "Phải thu" hiện đã chọn khi chưa có hướng — v2 §9.1).
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FgSegmented } from './uitk.tsx';

const OPTIONS = [
  { value: 'receivable', label: 'Phải thu' },
  { value: 'payable', label: 'Phải trả' },
];

/** Cờ `checked` của từng radio trong HTML, theo thứ tự tuỳ chọn. */
function checkedFlags(html: string): boolean[] {
  return [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => / checked=""/.test(m[0]));
}

describe('FgSegmented — trạng thái chưa chọn', () => {
  it('value = null: không mục nào được đánh dấu đã chọn', () => {
    const html = renderToStaticMarkup(<FgSegmented value={null} options={OPTIONS} />);
    expect(checkedFlags(html)).toEqual([false, false]);
  });

  it('value = mục cụ thể: đúng mục đó được đánh dấu', () => {
    const html = renderToStaticMarkup(<FgSegmented value="payable" options={OPTIONS} />);
    expect(checkedFlags(html)).toEqual([false, true]);
  });

  it('value = undefined: không điều khiển, antd hiển thị mục đầu như đã chọn (lý do phải dùng null)', () => {
    const html = renderToStaticMarkup(<FgSegmented value={undefined} options={OPTIONS} />);
    expect(checkedFlags(html)).toEqual([true, false]);
  });
});
