/**
 * Hàm thuần của tag (app/v2/tags.ts): gom đủ trang danh bạ và tra tên / tìm kiếm trên danh bạ lớn
 * (> 500 tag). Không gọi mạng: server GET /tags được giả lập bằng hàm trả đúng một trang.
 */
import { describe, expect, it } from 'vitest';
import { TAG_COLOR_DEFAULT, type TagRow } from '@fingate/shared';
import { collectAllTagPages, findTagByName, TAG_LIST_LIMIT, tagMatchesSearch, type TagPage } from './tags.ts';

const COMPANY = 'c-cta';

/** Danh bạ đã sắp theo tên chuẩn hoá: "Tag 0001" … "Tag 0593". */
function directory(n: number): TagRow[] {
  return Array.from({ length: n }, (_, i) => {
    const no = String(i + 1).padStart(4, '0');
    return {
      _id: `t${no}`,
      company_id: COMPANY,
      name: `Tag ${no}`,
      color: TAG_COLOR_DEFAULT,
      hidden: false,
      usage_count: 0,
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  });
}

/** Server giả: trả đúng cửa sổ [offset, offset + limit) của danh bạ, kèm tổng; ghi lại các offset đã gọi. */
function fakeServer(rows: readonly TagRow[], opts: { withTotal?: boolean; ignoreOffset?: boolean } = {}) {
  const offsets: number[] = [];
  const fetchPage = async (offset: number): Promise<TagPage> => {
    offsets.push(offset);
    const from = opts.ignoreOffset ? 0 : offset;
    return {
      items: rows.slice(from, from + TAG_LIST_LIMIT),
      total: opts.withTotal === false ? null : rows.length,
    };
  };
  return { fetchPage, offsets };
}

describe('collectAllTagPages — tải đủ danh bạ, không cắt ở 500 dòng', () => {
  it('danh bạ 593 tag: lấy đủ hai trang, kể cả tag thứ 550', async () => {
    const server = fakeServer(directory(593));
    const all = await collectAllTagPages(server.fetchPage);
    expect(all).toHaveLength(593);
    expect(server.offsets).toEqual([0, 500]);
    expect(all.some((t) => t.name === 'Tag 0550')).toBe(true);
  });

  it('danh bạ đúng 500 tag: chỉ một lượt gọi', async () => {
    const server = fakeServer(directory(500));
    expect(await collectAllTagPages(server.fetchPage)).toHaveLength(500);
    expect(server.offsets).toEqual([0]);
  });

  it('danh bạ rỗng: một lượt gọi, kết quả rỗng', async () => {
    const server = fakeServer([]);
    expect(await collectAllTagPages(server.fetchPage)).toEqual([]);
    expect(server.offsets).toEqual([0]);
  });

  it('phản hồi không kèm tổng: đọc tiếp đến khi gặp trang rỗng', async () => {
    const server = fakeServer(directory(1203), { withTotal: false });
    expect(await collectAllTagPages(server.fetchPage)).toHaveLength(1203);
    expect(server.offsets).toEqual([0, 500, 1000, 1203]);
  });

  it('server bỏ qua offset: dừng sau trang không có dòng mới, không lặp vô hạn', async () => {
    const server = fakeServer(directory(900), { ignoreOffset: true });
    const all = await collectAllTagPages(server.fetchPage);
    expect(all).toHaveLength(500);
    expect(server.offsets).toEqual([0, 500]);
  });
});

describe('tra cứu trên danh bạ lớn — tag ngoài 500 dòng đầu vẫn thấy', () => {
  const all = directory(593);

  it('kiểm trùng tên thấy tag ở vị trí 550 (bỏ khoảng trắng thừa, không phân biệt hoa thường)', () => {
    expect(findTagByName(all, '   tag   0550 ')?._id).toBe('t0550');
  });

  it('tìm theo tên thấy đúng tag ở vị trí 550', () => {
    expect(all.filter((t) => tagMatchesSearch(t, 'TAG  0550')).map((t) => t._id)).toEqual(['t0550']);
  });
});
