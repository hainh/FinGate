/**
 * FinGate web — Tag v2 (v2/v2.md §6.2, §13): kiểu, khoá cache, hook và hàm thuần dùng chung
 * cho `components/tag-input.tsx` (TagInput · TagFilter · TagPicker · TagChips) và màn
 * `screens/tags.tsx` (Quản lý tag). Hợp đồng API: packages/shared `contracts/tags.ts`.
 *
 * Tag thuộc danh bạ TỪNG công ty: khoá cache và mọi request đều mang `companyId`
 * (scope của request = công ty đó, không phải "Toàn tập đoàn").
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  TAG_COLOR_DEFAULT,
  TAG_COLOR_RE,
  normalizeNameKey,
  type TagCreateBody,
  type TagMergeBody,
  type TagRow,
  type TagUpdateBody,
} from '@fingate/shared';
import { apiCall, apiData } from '../api.ts';

export type { TagRow };

/** Thông tin tag đã gắn trên phiếu (vd `documentDetail.tags`) — chỉ các trường hiển thị. */
export interface TagRef {
  _id: string;
  name: string;
  color?: string | null;
  hidden?: boolean;
}

/** Cỡ một trang khi tải danh bạ: trần `limit` của GET /tags (contract `tagListQuery.limit` ≤ 500). */
export const TAG_LIST_LIMIT = 500;

/** Khoá cache danh bạ tag của một công ty. queryKey[1] là công ty (xem keepDataWithinScope). */
export const tagsQueryKey = (companyId: string | null | undefined) => ['tags', companyId ?? '', 'all'] as const;

/* ---------------- hàm thuần (không gọi mạng) ---------------- */

/** Giá trị đặc biệt trong danh sách gợi ý: chọn "+ Tạo tag …" (không bao giờ lưu vào phiếu). */
export const CREATE_TAG_TOKEN = '__fg-create-tag__:';

/** Tag trùng tên đã chuẩn hoá (DB unique `(company_id, name_key)`), tính cả tag đã ẩn. */
export function findTagByName(tags: readonly TagRow[], name: string): TagRow | undefined {
  const key = normalizeNameKey(name);
  if (!key) return undefined;
  return tags.find((t) => normalizeNameKey(t.name) === key);
}

/** Khớp gõ tìm: chứa chuỗi đã chuẩn hoá, không phân biệt hoa thường, bỏ khoảng trắng thừa. */
export function tagMatchesSearch(tag: Pick<TagRow, 'name'>, search: string): boolean {
  const q = normalizeNameKey(search);
  return !q || normalizeNameKey(tag.name).includes(q);
}

/** Màu hợp lệ (#RRGGBB) hoặc màu mặc định của hệ thống. */
export function tagColorOf(color: string | null | undefined): string {
  return color && TAG_COLOR_RE.test(color) ? color : TAG_COLOR_DEFAULT;
}

/**
 * Bộ so sánh tiếng Việt dùng chung. `localeCompare(…, 'vi')` tạo bộ so sánh mới mỗi lần gọi, nên sắp
 * một danh bạ hàng nghìn tag chậm rõ rệt; một `Intl.Collator` dựng sẵn cho cùng kết quả nhanh hơn nhiều.
 */
const VI_COLLATOR = new Intl.Collator('vi');

/** Thứ tự hiển thị danh bạ: tag dùng nhiều lên đầu, cùng số phiếu thì theo tên (tiếng Việt). */
export function compareTagsForList(a: Pick<TagRow, 'name' | 'usage_count'>, b: Pick<TagRow, 'name' | 'usage_count'>): number {
  return b.usage_count - a.usage_count || VI_COLLATOR.compare(a.name, b.name);
}

/** Số trang của một danh sách (luôn ít nhất 1 trang, kể cả khi rỗng). */
export function tagPageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Trang hợp lệ sau khi danh sách đổi (lọc / ẩn làm ngắn đi): không nhỏ hơn 1, không vượt số trang. */
export function clampTagPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), tagPageCount(total, pageSize));
}

/* eslint-disable no-restricted-syntax -- bảng màu là DỮ LIỆU của tag (server lưu #RRGGBB), không phải token giao diện */
/** Bảng màu gợi ý khi đổi màu tag. Màu đầu tiên là mặc định của hệ thống. */
export const TAG_COLOR_PRESETS: readonly string[] = [
  TAG_COLOR_DEFAULT,
  '#2563eb',
  '#0891b2',
  '#059669',
  '#65a30d',
  '#d97706',
  '#ea580c',
  '#dc2626',
  '#db2777',
  '#7c3aed',
];
/* eslint-enable no-restricted-syntax */

/** Thân lỗi API (`ApiRequestError.problem`) — an toàn với mọi kiểu lỗi. */
export function problemOf(e: unknown): { code?: string; detail?: string; title?: string } | undefined {
  return (e as { problem?: { code?: string; detail?: string; title?: string } } | null | undefined)?.problem;
}

/**
 * Thông điệp lỗi tag cho người dùng. Lỗi FG-TAG-001 (trùng tên) đã kèm lời giải thích từ server
 * ("Đã có tag … Muốn dùng chung thì gộp hai tag" / "… đang bị ẩn. Nhờ kế toán trưởng hiện lại").
 */
export function tagErrorMessage(e: unknown, fallback: string): string {
  const problem = problemOf(e);
  if (problem?.code === 'FG-TAG-001') return problem.detail ?? 'Công ty đã có tag cùng tên';
  return problem?.detail ?? problem?.title ?? fallback;
}

/** Một trang GET /tags: các dòng và `total` (số dòng khớp bộ lọc; null nếu phản hồi không kèm tổng). */
export interface TagPage {
  items: TagRow[];
  total: number | null;
}

/**
 * Gom đủ mọi trang của danh bạ (mỗi trang tối đa `TAG_LIST_LIMIT` dòng, sắp theo tên). Dừng khi đã đủ
 * `total`, trang rỗng, hoặc trang không có dòng mới (server bỏ qua `offset`). Không cắt âm thầm: danh bạ
 * có bao nhiêu tag thì trả đủ bấy nhiêu, để tìm / tra tên / kiểm trùng tên luôn đúng.
 */
export async function collectAllTagPages(fetchPage: (offset: number) => Promise<TagPage>): Promise<TagRow[]> {
  const all: TagRow[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (;;) {
    const page = await fetchPage(offset);
    if (!page.items.length) break;
    let fresh = 0;
    for (const t of page.items) {
      if (seen.has(t._id)) continue;
      seen.add(t._id);
      all.push(t);
      fresh++;
    }
    offset += page.items.length;
    if (!fresh || (page.total !== null && all.length >= page.total)) break;
  }
  return all;
}

/* ---------------- đọc / ghi (React Query) ---------------- */

/** Chấp nhận mảng thuần, `{items}` hoặc envelope `{data: …}`. */
function unwrapTags(raw: unknown): TagRow[] {
  if (Array.isArray(raw)) return raw as TagRow[];
  if (raw && typeof raw === 'object') {
    const o = raw as { items?: unknown; data?: unknown };
    if (Array.isArray(o.items)) return o.items as TagRow[];
    if (o.data !== undefined) return unwrapTags(o.data);
  }
  return [];
}

/** Phản hồi GET /tags thành một trang: `{items, total}`, envelope `{data: …}` hoặc mảng thuần. */
function unwrapTagPage(raw: unknown): TagPage {
  const total = raw && typeof raw === 'object' ? (raw as { total?: unknown }).total : undefined;
  return { items: unwrapTags(raw), total: typeof total === 'number' ? total : null };
}

/**
 * Toàn bộ tag của MỘT công ty, KỂ CẢ tag đã ẩn: để nhận diện trùng tên và tra tên/màu của tag
 * đã gắn. Việc lọc gợi ý theo `hidden` do giao diện quyết định. GET /tags trả tối đa 500 dòng mỗi
 * lần, nên hook tải đủ mọi trang: tag ở bất kỳ vị trí nào đều tìm / sửa / gộp / ẩn được.
 */
export function useCompanyTags(companyId: string | null | undefined) {
  return useQuery({
    queryKey: tagsQueryKey(companyId),
    enabled: !!companyId,
    staleTime: 30_000,
    // Không bắc cầu danh sách tag của công ty khác khi đổi công ty (tag không dùng chung giữa công ty).
    placeholderData: undefined,
    queryFn: async (): Promise<TagRow[]> => {
      if (!companyId) return [];
      return collectAllTagPages((offset) =>
        apiCall<unknown>('/tags', {
          query: { company_id: companyId, scope: companyId, include_hidden: 'true', limit: TAG_LIST_LIMIT, offset },
        }).then(unwrapTagPage),
      );
    },
  });
}

/** Sau khi đổi tag: làm mới danh bạ và mọi nơi hiển thị tag trên phiếu (tên/màu nằm trong dữ liệu phiếu). */
function refreshTagConsumers(qc: QueryClient, companyId: string | null | undefined): void {
  void qc.invalidateQueries({ queryKey: tagsQueryKey(companyId) });
  void qc.invalidateQueries({ queryKey: ['documents'] });
  void qc.invalidateQueries({ queryKey: ['document'] });
}

/** Kết quả tạo tag: `created = false` khi tên đã có và đang hiện (server trả chính tag đó). */
export interface TagCreateResult {
  tag: TagRow;
  created: boolean;
}

/**
 * Tạo tag (cần `tag:create`). Trùng tên đang hiện → server trả tag đã có (created = false), không tạo trùng.
 * Chèn ngay vào danh bạ đang cache để chip hiện tên ngay lập tức.
 */
export function useCreateTag(companyId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Omit<TagCreateBody, 'company_id'>): Promise<TagCreateResult> => {
      const res = await apiCall<{ data?: TagRow; created?: boolean }>('/tags', {
        method: 'POST',
        body: { ...body, ...(companyId ? { company_id: companyId } : {}) },
        scope: companyId ?? undefined,
      });
      if (!res?.data) throw new Error('Phản hồi tạo tag không hợp lệ');
      return { tag: res.data, created: res.created !== false };
    },
    onSuccess: ({ tag }) => {
      if (tag?._id) {
        qc.setQueryData<TagRow[]>(tagsQueryKey(companyId), (old) =>
          old ? [...old.filter((t) => t._id !== tag._id), tag] : old,
        );
      }
      void qc.invalidateQueries({ queryKey: tagsQueryKey(companyId) });
    },
  });
}

/** Đổi tên / màu / ẩn tag (cần `tag:manage`). Sửa được cả sau khi duyệt — không ảnh hưởng tiền. */
export function useUpdateTag(companyId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    // apiCall gắn request_id vào body: gửi bản sao để không làm bẩn đối tượng đã đưa vào cache.
    mutationFn: ({ id, body }: { id: string; body: TagUpdateBody }) =>
      apiData<TagRow>(`/tags/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...body }, scope: companyId ?? undefined }),
    onSuccess: (_row, vars) => {
      qc.setQueryData<TagRow[]>(tagsQueryKey(companyId), (old) =>
        old?.map((t) => (t._id === vars.id ? { ...t, ...vars.body } : t)),
      );
      refreshTagConsumers(qc, companyId);
    },
  });
}

/** Kết quả gộp (POST /tags/merge): số phiếu đã chuyển sang tag đích. Tag nguồn được ẩn, không xoá. */
export interface TagMergeResult {
  source_id: string;
  target_id: string;
  documents_changed: number;
  target: TagRow;
}

/**
 * Gộp tag nguồn vào tag đích (cần `tag:manage`): mọi phiếu đang gắn nguồn chuyển sang đích,
 * rồi tag nguồn bị ẩn. Tag đích phải đang hiện.
 */
export function useMergeTags(companyId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TagMergeBody) =>
      apiData<TagMergeResult>('/tags/merge', { method: 'POST', body: { ...body }, scope: companyId ?? undefined }),
    onSuccess: () => refreshTagConsumers(qc, companyId),
  });
}
