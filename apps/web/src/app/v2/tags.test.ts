/**
 * Hàm thuần của tag (app/v2/tags.ts): gom đủ trang danh bạ và tra tên / tìm kiếm trên danh bạ lớn
 * (> 500 tag). Không gọi mạng: server GET /tags được giả lập bằng hàm trả đúng một trang.
 */
import { describe, expect, it } from 'vitest';
import { TAG_COLOR_DEFAULT, type TagRow } from '@fingate/shared';
import {
  clampTagPage,
  collectAllTagPages,
  compareTagsForList,
  findTagByName,
  TAG_LIST_LIMIT,
  tagMatchesSearch,
  tagPageCount,
  type TagPage,
} from './tags.ts';

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

describe('bảng tag: thứ tự hiển thị và chia trang', () => {
  it('tag dùng nhiều lên đầu; cùng số phiếu thì xếp theo tên tiếng Việt (Đ sau D, trước E…)', () => {
    const rows = [
      { name: 'Vay', usage_count: 0 },
      { name: 'Đức', usage_count: 0 },
      { name: 'Dung', usage_count: 0 },
      { name: 'An', usage_count: 2 },
      { name: 'Ân', usage_count: 0 },
      { name: 'Bình', usage_count: 5 },
    ];
    expect([...rows].sort(compareTagsForList).map((t) => t.name)).toEqual(['Bình', 'An', 'Ân', 'Dung', 'Đức', 'Vay']);
  });

  it('cùng tên và cùng số phiếu thì coi là ngang nhau (không đổi thứ tự)', () => {
    expect(compareTagsForList({ name: 'Tag A', usage_count: 1 }, { name: 'Tag A', usage_count: 1 })).toBe(0);
  });

  it('số trang: danh sách rỗng vẫn có một trang; 1725 tag chia 25 dòng/trang là 69 trang', () => {
    expect(tagPageCount(0, 25)).toBe(1);
    expect(tagPageCount(25, 25)).toBe(1);
    expect(tagPageCount(26, 25)).toBe(2);
    expect(tagPageCount(1725, 25)).toBe(69);
  });

  it('trang hiện tại được kẹp khi danh sách co lại (ẩn / lọc) hoặc khi trang không hợp lệ', () => {
    expect(clampTagPage(3, 0, 25), 'danh sách rỗng → trang 1').toBe(1);
    expect(clampTagPage(2, 25, 25), 'chỉ còn một trang → trang 1').toBe(1);
    expect(clampTagPage(9, 26, 25), 'trang 9 nhưng còn 2 trang → trang 2').toBe(2);
    expect(clampTagPage(0, 60, 25), 'trang 0 → trang 1').toBe(1);
    expect(clampTagPage(2, 60, 25), 'trang hợp lệ giữ nguyên').toBe(2);
  });
});
