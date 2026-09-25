/**
 * FinGate web — apiClient (handoff §3/§6, architecture §6)
 *
 * - same-origin, cookie HttpOnly (không CORS).
 * - Lỗi luôn là `application/problem+json` → `parseProblem()` của shared → ApiRequestError.
 * - GET: `retry: 2`, backoff 2s (cold-start Render); mutation KHÔNG retry (idempotency
 *   đã có `request_id`).
 * - Mutation tự sinh `request_id` (UUID) nếu caller không truyền — double-click không tạo 2 bước.
 * - `x-company-scope` gắn tự động từ scope đang chọn; đổi scope → caller refetch mọi thứ.
 * - 401 → gọi `onUnauthorized` (AuthContext chuyển về /dang-nhap giữ ngữ cảnh).
 */

import { parseProblem, type ProblemJson } from '@fingate/shared';

export class ApiRequestError extends Error {
  readonly problem: ProblemJson;
  constructor(problem: ProblemJson) {
    super(problem.title);
    this.name = 'ApiRequestError';
    this.problem = problem;
  }
  get code() {
    return this.problem.code;
  }
  get status() {
    return this.problem.status;
  }
}

export const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;

export const API_BASE = '/api/v1';

/* --------- hooks nối vòng (tránh import vòng auth ↔ api) --------- */

let scopeProvider: () => string | null = () => null;
let unauthorizedHandler: (() => void) | null = null;
let signedOut = false;

export function setScopeProvider(fn: () => string | null): void {
  scopeProvider = fn;
}
export function setUnauthorizedHandler(fn: () => void): void {
  unauthorizedHandler = fn;
}

/* --------- cold-start UX (P0-6): request đầu > 3s → "máy chủ đang thức dậy" --------- */

export const coldStart = {
  /** true từ lúc mount tới khi request đầu tiên thành công/hết retry. */
  waking: false,
  startedAt: 0,
  listeners: new Set<() => void>(),
  set(v: boolean): void {
    if (this.waking !== v) {
      this.waking = v;
      if (v) this.startedAt = Date.now();
      this.listeners.forEach((l) => l());
    }
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | string[]>;
  signal?: AbortSignal;
  /** If-Match = version (CAS). */
  ifMatch?: number | string;
  /** ép scope khác header hiện tại (deep-link DASH-06). */
  scope?: string;
  /** bỏ giới hạn retry cho caller tự quản lý (mutation = 0). */
  retry?: number;
  /** raw response (export stream). */
  raw?: boolean;
}

export async function apiCall<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const isGet = method === 'GET';
  const retries = opts.retry ?? (isGet ? 2 : 0);

  const url = new URL(`${API_BASE}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((one) => url.searchParams.append(k, String(one)));
    else url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { accept: 'application/json' };
  // Phạm vi công ty: ưu tiên `opts.scope` (deep-link), rồi suy từ `query.scope` của chính
  // request. Suy từ query để header LUÔN khớp tham số và queryKey — nếu chỉ dựa vào
  // scopeProvider (đổi sau render qua effect) thì request có thể kịp gửi header cũ, server
  // trả nhầm dữ liệu công ty cũ (màn thu chi còn hiện phiếu công ty trước đó).
  const queryScope = opts.query?.scope;
  const scope = opts.scope ?? (typeof queryScope === 'string' ? queryScope : undefined) ?? scopeProvider();
  if (scope) headers['x-company-scope'] = scope;
  if (opts.ifMatch !== undefined) headers['if-match'] = String(opts.ifMatch);
  let payload: string | undefined;
  if (opts.body !== undefined) {
    const body = opts.body as Record<string, unknown>;
    if (!isGet && !('request_id' in body)) body.request_id = uuid();
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }

  if (isGet && !coldStart.startedAt) coldStart.set(true);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url.pathname + url.search, {
        method,
        headers,
        body: payload,
        credentials: 'same-origin',
        // Cache HTTP tắt toàn hệ thống: mọi GET đọc tươi, không dùng bản lưu của browser.
        cache: 'no-store',
        signal: opts.signal,
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      // mạng/lạnh server
      if (attempt < retries) {
        await sleep(2000);
        continue;
      }
      throw new ApiRequestError({
        type: 'network',
        title: 'Không kết nối được máy chủ',
        status: 0,
        code: 'FG-SYS-001',
        detail: 'Có thể phiên bản mới đang khởi động — thử lại sau vài giây.',
      });
    }

    // Server đã trả lời (bất kỳ status nào, kể cả 401 của /me lúc anon) → không còn "đang thức dậy".
    // Đặt ở đây thay vì chỉ nhánh res.ok để banner cold-start không kẹt trên màn đăng nhập.
    if (isGet) coldStart.set(false);

    if (res.status === 401) {
      const problem = parseProblem(401, await res.json().catch(() => null));
      // FG-AUTH-008/005 = phiên CÒN sống, chỉ cần xác thực lại (step-up) → KHÔNG đá về login
      if (problem.code !== 'FG-AUTH-008' && problem.code !== 'FG-AUTH-005') {
        if (attempt < retries && isGet) {
          await sleep(2000);
          continue;
        }
        if (!signedOut) unauthorizedHandler?.();
      }
      throw new ApiRequestError(problem);
    }

    if (!res.ok) {
      const problem = parseProblem(res.status, await res.json().catch(() => null));
      // 5xx chỉ retry với GET (backoff 2s)
      if (res.status >= 500 && attempt < retries && isGet) {
        await sleep(2000);
        continue;
      }
      throw new ApiRequestError(problem);
    }

    if (opts.raw) return res as unknown as T;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }
}

/** response envelope `{ data }` → unwrap; `{ items }` giữ nguyên. */
export async function apiData<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const r = (await apiCall<{ data: T } | T>(path, opts)) as { data?: T };
  return (r && typeof r === 'object' && 'data' in r ? r.data : r) as T;
}

export function markSignedOut(v: boolean): void {
  signedOut = v;
}

/** tải file (export Excel) — giữ nguyên stream + watermark từ server. */
export async function downloadFile(path: string, body: Record<string, unknown>, filename: string): Promise<void> {
  const res = await apiCall(path, { method: 'POST', body, raw: true });
  const blob = await (res as unknown as Response).blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Mở URL tải file bằng điều hướng trình duyệt — theo được 302 presigned của storage
 * (S3/R2) mà `fetch` không đọc được do CORS. Dùng cho sao lưu dữ liệu.
 */
export function openDownload(path: string): void {
  const a = document.createElement('a');
  a.href = `${API_BASE}${path}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
