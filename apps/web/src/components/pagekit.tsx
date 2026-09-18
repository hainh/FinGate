/**
 * FinGate web — khung trạng thái màn hình (DoD §5: default · loading · empty · no-results ·
 * error · partial · 403 · stale — và 409 xử lý ở nơi mutate).
 *
 * `FgQuery` là thành phần CHUNG mọi màn dùng: screen chỉ khai skeleton đúng hình +
 * empty/no-results khác nhau + cách render dữ liệu.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import { App } from 'antd';
import { problemHint, type ProblemJson } from '@fingate/shared';
import { ApiRequestError, coldStart } from '../app/api.ts';
import { useAuth } from '../app/store.tsx';
import { FgAlert, FgButton } from './primitives.tsx';
import { FgEmptyState } from './uitk.tsx';

/* ---------------- toast (FgToast — OVL-21) ---------------- */

export function useToast() {
  const { message, notification } = App.useApp();
  return { message, notification };
}

export const toastOk = (msg: string): void => {
  // giữ một hàm duy nhất để mọi mutation báo cùng phong cách
  document.dispatchEvent(new CustomEvent('fg:toast', { detail: { type: 'success', msg } }));
};

/* ---------------- cold-start subscribe ---------------- */

export function useColdStart(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    coldStart.listeners.add(l);
    return () => {
      coldStart.listeners.delete(l);
    };
  }, []);
  // chỉ hiện thông điệp "đang thức dậy" sau 3s thật
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!coldStart.waking) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [coldStart.waking, coldStart.startedAt]);
  return slow;
}

/* ---------------- problem → màn hình (ERR-01/02/04 + handoff §4-6) ---------------- */

export interface ProblemView {
  kind: 'forbidden' | 'notfound' | 'server' | 'session' | 'network';
  problem: ProblemJson;
  explain: string;
}

export function viewForProblem(problem: ProblemJson): ProblemView {
  const hint = problemHint(problem.code);
  const kind: ProblemView['kind'] =
    problem.status === 403 ? 'forbidden' : problem.status === 404 ? 'notfound' : problem.status === 401 ? 'session' : hint === 'retry' && problem.status === 0 ? 'network' : 'server';
  let explain = problem.detail ?? '';
  if (kind === 'forbidden')
    explain =
      explain ||
      'Bạn không thấy mục này vì nó nằm ngoài phạm vi dữ liệu hoặc chức danh hiện tại. Đây là chủ ý phân quyền — liên hệ Quản trị nếu bạn cần truy cập.';
  if (kind === 'session') explain = explain || 'Phiên làm việc đã kết thúc. Đăng nhập lại để tiếp tục — bộ lọc và bản nháp của bạn được giữ.';
  return { kind, problem, explain };
}

/**
 * Wrapper trạng thái chuẩn. `skeleton` phải ĐÚNG HÌNH nội dung thật (DoD).
 */
export function FgQuery<T>({
  query,
  skeleton,
  empty,
  partial,
  staleNote,
  children,
  onRetry,
}: {
  query: UseQueryResult<T, Error>;
  skeleton: ReactNode;
  /** dữ liệu thật sự trống. */
  empty?: ReactNode;
  /** rỗng VÌ bộ lọc — khác empty (DS §7.20). */
  noResults?: ReactNode;
  /** danh sách công ty chưa đồng bộ → banner. */
  partial?: ReactNode;
  staleNote?: ReactNode;
  children: (data: T) => ReactNode;
  onRetry?: () => void;
}): ReactNode {
  const waking = useColdStart();
  const auth = useAuth();
  const status = auth?.status;
  const err = query.error as ApiRequestError | null;

  if (status === 'loading' && !query.data) return <>{skeleton}</>;
  if (err) {
    const view = viewForProblem(err.problem);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}>
        {waking ? <FgAlert tone="info" title="Máy chủ đang thức dậy, vui lòng chờ…" description="Lần khởi động đầu tiên có thể mất khoảng 1 phút." /> : null}
        {view.kind === 'forbidden' ? (
          <FgEmptyState
            glyph="⊘"
            tone="danger"
            title="Bạn không có quyền xem mục này"
            description={
              <>
                {view.explain}
                <div style={{ marginTop: 4, fontFamily: 'var(--fg-font-mono)', fontSize: 11 }}>
                  {view.problem.code} {view.problem.trace_id ? `· ${view.problem.trace_id}` : ''}
                </div>
              </>
            }
            // ERR-01: KHÔNG có CTA thử lại — quyền không tự sinh ra khi bấm
          />
        ) : view.kind === 'notfound' ? (
          <FgEmptyState glyph="?" title="Không tìm thấy" description={view.problem.title} />
        ) : (
          <FgAlert
            tone="danger"
            title={view.problem.title}
            description={
              <>
                {view.explain || view.problem.detail}
                {view.problem.trace_id ? (
                  <div style={{ marginTop: 4, fontFamily: 'var(--fg-font-mono)', fontSize: 11 }}>trace: {view.problem.trace_id}</div>
                ) : null}
              </>
            }
            action={
              <FgButton size="small" onClick={() => (onRetry ? onRetry() : void query.refetch())}>
                Thử lại
              </FgButton>
            }
          />
        )}
      </div>
    );
  }

  if (query.isPending && !query.data)
    return waking ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}>
        <FgAlert tone="info" title="Máy chủ đang thức dậy, vui lòng chờ…" description="Lần khởi động đầu tiên có thể mất khoảng 1 phút." />
        {skeleton}
      </div>
    ) : (
      <>{skeleton}</>
    );

  if (!query.data) return empty ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-3)' }}>
      {partial}
      {staleNote}
      {children(query.data)}
    </div>
  );
}

/* ================= FgFilterBar — URL là state của danh sách (handoff §0.6) ================= */

export interface FilterSpec {
  key: string;
  type: 'q' | 'select' | 'segmented' | 'switch';
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** giá trị mặc định không ghi lên URL. */
  default?: string;
  width?: number;
}

/**
 * Đọc/ghi bộ lọc lên searchParams: `?status=pending.gd&q=ABC&sort=-waiting`.
 * Deep-link từ notification mở đúng hồ sơ + giữ nguyên bộ lọc nguồn.
 */
export function useUrlFilters(specs: FilterSpec[]) {
  const [params, setParams] = useSearchParams();
  const values: Record<string, string> = {};
  for (const s of specs) values[s.key] = params.get(s.key) ?? s.default ?? '';

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    const spec = specs.find((s) => s.key === key);
    if (!value || (spec && value === spec.default)) next.delete(key);
    else next.set(key, value);
    // đổi filter → về trang 1
    next.delete('page');
    setParams(next, { replace: true });
  };

  return { values, setFilter, params, setParams };
}

/** debounce cho ô tìm (300ms — DS §7.11). */
export function useDebounced(value: string, ms = 300): string {
  const [v, setV] = useState(value);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(t.current);
    t.current = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t.current);
  }, [value, ms]);
  return v;
}

/** điều hướng có giữ return-to (deep-link từ notification). */
export function useBackToList() {
  const navigate = useNavigate();
  const params = new URLSearchParams(window.location.search);
  const back = params.get('from') ?? sessionStorage.getItem('fg.list') ?? '/cho-toi-duyet';
  return () => navigate(back);
}
