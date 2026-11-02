/**
 * Sắp xếp danh sách phía máy chủ (bảng phân trang): tham số `sort=<trường>` (tăng dần) hoặc `sort=-<trường>` (giảm dần).
 * Chỉ nhận trường nằm trong danh sách cho phép; giá trị lạ → null (dùng thứ tự mặc định của màn).
 */

export interface SortSpec {
  field: string;
  /** 1 = tăng dần, -1 = giảm dần */
  dir: 1 | -1;
}

export function parseSort(raw: string | undefined | null, allowed: readonly string[]): SortSpec | null {
  const s = (raw ?? '').trim().replace(/^\+/, '');
  if (!s) return null;
  const dir = s.startsWith('-') ? -1 : 1;
  const field = dir === -1 ? s.slice(1) : s;
  return allowed.includes(field) ? { field, dir } : null;
}

export type SortKey = string | number | bigint | null | undefined;

function compareKeys(a: SortKey, b: SortKey): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'vi', { numeric: true });
}

/**
 * Sắp xếp mảng trong bộ nhớ theo `spec` (ổn định: dòng bằng nhau giữ thứ tự cũ); giá trị trống luôn xuống cuối,
 * bất kể chiều. `getters` ánh xạ trường → khoá so sánh.
 */
export function sortRows<T>(rows: readonly T[], spec: SortSpec | null, getters: Record<string, (row: T) => SortKey>): T[] {
  const get = spec ? getters[spec.field] : undefined;
  if (!spec || !get) return [...rows];
  const keyed = rows.map((row, i) => ({ row, i, key: get(row) }));
  const empty = (k: SortKey): boolean => k === null || k === undefined || k === '';
  keyed.sort((x, y) => {
    const xe = empty(x.key);
    const ye = empty(y.key);
    if (xe || ye) return xe && ye ? x.i - y.i : xe ? 1 : -1;
    return compareKeys(x.key, y.key) * spec.dir || x.i - y.i;
  });
  return keyed.map((k) => k.row);
}

/** Số tiền dạng chuỗi minor (`{ minor: '123' }` hoặc `'123'`) → bigint để so sánh đúng với số rất lớn. */
export function minorKey(v: unknown): bigint | null {
  const raw = v && typeof v === 'object' && 'minor' in v ? (v as { minor: unknown }).minor : v;
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'bigint') return raw;
  const s = String(raw);
  return /^-?\d+$/.test(s) ? BigInt(s) : null;
}
