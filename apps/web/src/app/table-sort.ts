/**
 * Sắp xếp bảng phía máy chủ. Bảng phân trang chỉ giữ MỘT trang trong bộ nhớ, nên `sorter` kiểu hàm của antd chỉ
 * xếp lại trang đang xem. Ở đây tiêu đề cột chỉ hiển thị mũi tên (sorter: true, sortOrder điều khiển), còn thứ tự
 * thật do máy chủ trả theo tham số `sort=<cột>` (tăng) / `sort=-<cột>` (giảm) — cùng quy ước với `apps/api/src/lib/sort.ts`.
 */
import type { TableColumnsType } from 'antd';

export type SortDirection = 'ascend' | 'descend';
export interface SortState {
  key: string;
  order: SortDirection;
}

/** `-amount` → { key: 'amount', order: 'descend' }; rỗng → null. */
export function parseSort(value: string | null | undefined): SortState | null {
  const s = (value ?? '').trim().replace(/^\+/, '');
  if (!s) return null;
  return s.startsWith('-') ? { key: s.slice(1), order: 'descend' } : { key: s, order: 'ascend' };
}

export function serializeSort(state: SortState | null): string {
  if (!state) return '';
  return state.order === 'descend' ? `-${state.key}` : state.key;
}

type AntdSorter = { columnKey?: unknown; field?: unknown; order?: SortDirection | null };

/** Kết quả `onChange(_, _, sorter)` của antd Table → SortState (null khi bỏ sắp xếp). */
export function sortFromTable(sorter: AntdSorter | AntdSorter[] | undefined): SortState | null {
  const s = Array.isArray(sorter) ? sorter[0] : sorter;
  if (!s?.order) return null;
  const key = s.columnKey ?? s.field;
  return typeof key === 'string' && key ? { key, order: s.order } : null;
}

/**
 * Gắn trạng thái sắp xếp lên cột: cột có `key` thuộc `sortable` nhận `sorter: true` + `sortOrder` theo `sort`.
 * `fallback` là thứ tự mặc định của màn (khi `sort` rỗng) — mũi tên hiển thị đúng cột đang được xếp.
 */
export function withServerSort<T>(
  columns: TableColumnsType<T>,
  sortable: readonly string[],
  sort: string | null | undefined,
  fallback?: string,
): TableColumnsType<T> {
  const active = parseSort(sort) ?? parseSort(fallback);
  const apply = (cols: TableColumnsType<T>): TableColumnsType<T> =>
    cols.map((col) => {
      const key = typeof col.key === 'string' ? col.key : undefined;
      const next = { ...col } as TableColumnsType<T>[number] & { children?: TableColumnsType<T> };
      if ('children' in col && col.children) next.children = apply(col.children);
      if (key && sortable.includes(key)) {
        next.sorter = true;
        next.sortOrder = active?.key === key ? active.order : null;
      }
      return next;
    });
  return apply(columns);
}

/** Tham số `onChange` của bảng: gọi `set(serialized)` khi người dùng bấm tiêu đề cột (bỏ qua đổi trang). */
export function onSortChange(set: (sort: string) => void) {
  return (_p: unknown, _f: unknown, sorter: AntdSorter | AntdSorter[], extra: { action: string }): void => {
    if (extra.action !== 'sort') return;
    set(serializeSort(sortFromTable(sorter)));
  };
}
