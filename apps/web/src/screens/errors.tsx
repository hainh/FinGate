/**
 * ERR-01 403 · ERR-02 404 · ERR-04 500 — các trang lỗi độc lập + ErrorBoundary.
 */

import { Component, type ReactNode } from 'react';
import { Link } from 'react-router';
import { FgButton, FgText } from '../components/primitives.tsx';
import { FgEmptyState } from '../components/uitk.tsx';
import { queryClient } from '../app/store.tsx';

function Frame({ children }: { children: ReactNode }): ReactNode {
  return (
    <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', background: 'var(--fg-bg-page)', padding: 16 }}>
      <div className="fg-card" style={{ maxWidth: 520, width: '100%' }}>
        {children}
      </div>
    </div>
  );
}

/** ERR-01 — KHÔNG có CTA "thử lại" vì quyền không tự sinh ra khi bấm (DS §7.20). */
export function ForbiddenScreen(): ReactNode {
  return (
    <Frame>
      <FgEmptyState
        glyph="⊘"
        tone="danger"
        title="Bạn không có quyền mở mục này"
        description="Đây là chủ ý phân quyền: hồ sơ nằm ngoài phạm vi công ty hoặc chức danh hiện tại của bạn. Nếu bạn cần truy cập, liên hệ Quản trị — đừng nhờ người khác duyệt hộ."
      />
      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <Link to="/dashboard">
          <FgButton variant="primary">Về dashboard</FgButton>
        </Link>
      </div>
    </Frame>
  );
}

export function NotFoundScreen(): ReactNode {
  return (
    <Frame>
      <FgEmptyState
        glyph="?"
        title="Không tìm thấy trang"
        description="Đường dẫn không tồn tại, hoặc hồ sơ đã bị xóa mềm (giữ liệu lưu trữ)."
      />
      <div style={{ textAlign: 'center', marginTop: 16 }}>
        <Link to="/dashboard">
          <FgButton variant="primary">Về dashboard</FgButton>
        </Link>
      </div>
    </Frame>
  );
}

export function ServerErrorScreen({ error, reset }: { error?: Error; reset?: () => void }): ReactNode {
  return (
    <Frame>
      <FgEmptyState
        glyph="⚠"
        tone="danger"
        title="Hệ thống đang gặp sự cố"
        description={
          <>
            <FgText style="bodyS" color="muted">
              Vui lòng thử lại. Nếu vẫn lỗi, gửi mã sau cho helpdesk:
            </FgText>
            <div className="fg-mono" style={{ fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>
              {error?.message?.slice(0, 160) ?? 'FG-SYS-001'}
            </div>
          </>
        }
        action={
          <>
            <FgButton
              variant="primary"
              onClick={() => {
                queryClient.clear();
                reset?.();
              }}
            >
              Thử lại
            </FgButton>{' '}
            <Link to="/dashboard">
              <FgButton>Về dashboard</FgButton>
            </Link>
          </>
        }
      />
    </Frame>
  );
}

export class FgErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render(): ReactNode {
    if (this.state.error) return <ServerErrorScreen error={this.state.error} reset={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
