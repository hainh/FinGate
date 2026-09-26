/**
 * routes.tsx — mỗi route mang screenId (comment) + yêu cầu quyền; guard theo phiên.
 * Screen lazy-load theo nhóm (budget bundle: report/admin route lazy).
 */

import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './app/store.tsx';
import { FgAppShell } from './components/shell.tsx';
import { ActivateScreen, LoginScreen, ForgotPasswordScreen, ResetPasswordScreen } from './screens/auth.tsx';
import { DashboardScreen } from './screens/dashboard.tsx';
import {
  ApprovalQueueScreen,
  ChangesRequestedScreen,
  IncomeListScreen,
  IncomeOverdueScreen,
  InternalListScreen,
  ProcessedScreen,
  SpendListScreen,
  SpendPaidScreen,
  SpendPendingScreen,
} from './screens/documents.tsx';
import { DocumentDetailScreen } from './screens/document-detail.tsx';
import { BankAccountsScreen } from './screens/bank.tsx';
import { BankAccountFormScreen } from './screens/bank-account-form.tsx';
import { DebtsScreen, LoansScreen, RolloversScreen } from './screens/loans.tsx';
import { CashflowHistoryScreen } from './screens/cashflow.tsx';
import { ReportLibraryScreen, ReportRunnerScreen } from './screens/reports.tsx';
import { PersonnelScreen, MatrixScreen, AuditLogScreen, SettingsScreen, CompaniesScreen } from './screens/admin.tsx';
import { BackupScreen } from './screens/backup.tsx';
import { NewsletterScreen, NotificationsScreen, SearchScreen } from './screens/misc.tsx';
import { DocumentFormScreen } from './screens/create-form.tsx';
import { ForbiddenScreen, NotFoundScreen } from './screens/errors.tsx';
import { FgSpinner } from './components/uitk.tsx';

// Ghi chú bundle: mọi màn import tĩnh để một module graph (Vite 8 dev tạo hai bản
// react-router cho lazy chunk → RouterContext null). Bank budget vẫn đạt nhờ
// manualChunks tách antd/react — hai screen reports/admin chỉ thêm ~16 KB gzip.

function Guard({ children }: { children: ReactNode }): ReactNode {
  const { status } = useAuth();
  const location = useLocation();
  useEffect(() => {
    if (status === 'anon' && !location.pathname.startsWith('/dang-nhap') && !location.pathname.startsWith('/kich-hoat') && !location.pathname.startsWith('/mat-khau')) {
      sessionStorage.setItem('fg.returnTo', location.pathname + location.search);
    }
  }, [status, location.pathname, location.search]);
  if (status === 'loading')
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}>
        <FgSpinner center />
      </div>
    );
  if (status === 'anon') return <Navigate to="/dang-nhap" replace />;
  return <>{children}</>;
}

/**
 * Quyền tối thiểu theo tiền tố đường dẫn — để gõ URL trực tiếp vào màn không có quyền
 * cũng bị đưa về trang phù hợp, thay vì 403 lửng hoặc skeleton treo.
 * (Khu `/quantri` không khóa ở đây — từng màn tự ẩn nút và server vẫn kiểm quyền.)
 */
const PATH_PERMS: { prefix: string; perm: string | string[] }[] = [
  { prefix: '/dashboard', perm: 'doc:read' },
  { prefix: '/cho-toi-duyet', perm: ['approval:act', 'payment:mark'] },
  { prefix: '/toi-da-duyet', perm: 'approval:act' },
  { prefix: '/can-bo-sung', perm: 'approval:act' },
  { prefix: '/can-xu-ly', perm: 'doc:read' },
  { prefix: '/chi', perm: 'doc:read' },
  { prefix: '/thu', perm: 'doc:read' },
  { prefix: '/ho-so', perm: 'doc:read' },
  { prefix: '/ngan-hang/taikhoan', perm: 'bank:read' },
  { prefix: '/ngan-hang/chuyen-noi-bo', perm: 'bank:read' },
  { prefix: '/ngan-hang/khoan-vay', perm: 'loan:read' },
  { prefix: '/ngan-hang/dao-han', perm: 'loan:read' },
  { prefix: '/cong-no', perm: 'debt:read' },
  { prefix: '/dong-tien', perm: 'forecast:read' },
  { prefix: '/baocao', perm: 'report:view' },
  { prefix: '/ban-tin', perm: 'report:view' },
  { prefix: '/quantri/sao-luu', perm: 'admin:backup' },
];

function Shell({ children }: { children: ReactNode }): ReactNode {
  return (
    <Guard>
      <ShellInner>{children}</ShellInner>
    </Guard>
  );
}

function ShellInner({ children }: { children: ReactNode }): ReactNode {
  const { can } = useAuth();
  const location = useLocation();
  const need = PATH_PERMS.find((p) => location.pathname.startsWith(p.prefix))?.perm;
  const allowed = !need || (Array.isArray(need) ? need.some((p) => can(p)) : can(need));
  if (!allowed) {
    // Tài khoản quản lý thuần (không doc:read) về khu Quản trị; còn lại về Tổng quan.
    return <Navigate to={can('doc:read') ? '/dashboard' : '/quantri'} replace />;
  }
  return <FgAppShell>{children}</FgAppShell>;
}

/** Trang chủ theo quyền: tài khoản quản lý thuần (không có doc:read) vào thẳng Quản trị. */
function HomeRedirect(): ReactNode {
  const { status, can } = useAuth();
  if (status === 'loading') return <FgSpinner center />;
  if (status === 'anon') return <Navigate to="/dang-nhap" replace />;
  return <Navigate to={can('doc:read') ? '/dashboard' : '/quantri'} replace />;
}

/** Khu Quản trị → mở tab đầu tiên người dùng có quyền (KTT chỉ đọc audit → Audit log). */
function AdminHomeRedirect(): ReactNode {
  const { can } = useAuth();
  if (can('hr:invite')) return <Navigate to="/quantri/nguoidung" replace />;
  if (can('admin:settings')) return <Navigate to="/quantri/cong-ty" replace />;
  if (can('admin:matrix')) return <Navigate to="/quantri/quy-trinh-duyet" replace />;
  if (can('audit:read')) return <Navigate to="/quantri/audit" replace />;
  if (can('admin:backup')) return <Navigate to="/quantri/sao-luu" replace />;
  return <Navigate to="/403" replace />;
}

export function AppRoutes(): ReactNode {
  const location = useLocation();
  return (
    <Routes key={location.pathname}>
      <Route path="/dang-nhap" element={<LoginScreen />} />
      <Route path="/kich-hoat" element={<ActivateScreen />} /> {/* AUTH-05 — mở công khai, vào bằng link ký */}
      <Route path="/mat-khau/quen" element={<ForgotPasswordScreen />} />
      <Route path="/mat-khau/dat-lai" element={<ResetPasswordScreen />} />
      <Route path="/403" element={<ForbiddenScreen />} />

      <Route path="/" element={<HomeRedirect />} />
      <Route path="/dashboard" element={<Shell><DashboardScreen /></Shell>} /> {/* DASH-01 */}
      <Route path="/cho-toi-duyet" element={<Shell><ApprovalQueueScreen /></Shell>} /> {/* APPR-01 */}
      <Route path="/toi-da-duyet" element={<Shell><ProcessedScreen /></Shell>} /> {/* APPR-02 */}
      <Route path="/can-bo-sung" element={<Shell><ChangesRequestedScreen /></Shell>} /> {/* APPR-03 */}
      <Route path="/can-xu-ly" element={<Shell><NotificationsScreen /></Shell>} /> {/* DASH-05 — hiển thị màn Thông báo */}
      <Route path="/chi" element={<Shell><SpendListScreen /></Shell>} /> {/* CHI-01 */}
      <Route path="/chi/cho-duyet" element={<Shell><SpendPendingScreen /></Shell>} /> {/* CHI-04 */}
      <Route path="/chi/da-thanh-toan" element={<Shell><SpendPaidScreen /></Shell>} /> {/* CHI-07 */}
      <Route path="/chi/moi" element={<Shell><DocumentFormScreen kind="spend" /></Shell>} /> {/* CHI-02 */}
      <Route path="/chi/:id/sua" element={<Shell><DocumentFormScreen kind="spend" /></Shell>} /> {/* CHI-03 */}
      <Route path="/thu" element={<Shell><IncomeListScreen /></Shell>} /> {/* THU-01 */}
      <Route path="/thu/qua-han" element={<Shell><IncomeOverdueScreen /></Shell>} /> {/* THU-04 */}
      <Route path="/thu/moi" element={<Shell><DocumentFormScreen kind="income" /></Shell>} /> {/* THU-02 */}
      <Route path="/thu/:id/sua" element={<Shell><DocumentFormScreen kind="income" /></Shell>} />
      <Route path="/ngan-hang/taikhoan" element={<Shell><BankAccountsScreen /></Shell>} /> {/* BANK-01 */}
      <Route path="/ngan-hang/taikhoan/moi" element={<Shell><BankAccountFormScreen /></Shell>} /> {/* BANK-02 */}
      <Route path="/ngan-hang/taikhoan/:id/sua" element={<Shell><BankAccountFormScreen /></Shell>} />
      <Route path="/ngan-hang/khoan-vay" element={<Shell><LoansScreen /></Shell>} /> {/* LOAN-01 */}
      <Route path="/ngan-hang/dao-han" element={<Shell><RolloversScreen /></Shell>} /> {/* RENEW-01 */}
      <Route path="/ngan-hang/dao-han/phuong-an/moi" element={<Shell><DocumentFormScreen kind="rollover" /></Shell>} /> {/* RENEW-02 */}
      <Route path="/ngan-hang/dao-han/phuong-an/:id/sua" element={<Shell><DocumentFormScreen kind="rollover" /></Shell>} />
      <Route path="/ngan-hang/chuyen-noi-bo" element={<Shell><InternalListScreen /></Shell>} /> {/* BANK-07 */}
      <Route path="/ngan-hang/chuyen-noi-bo/moi" element={<Shell><DocumentFormScreen kind="internal" /></Shell>} /> {/* BANK-08 */}
      <Route path="/ngan-hang/chuyen-noi-bo/:id/sua" element={<Shell><DocumentFormScreen kind="internal" /></Shell>} />
      <Route path="/cong-no/phai-thu" element={<Shell><DebtsScreen kind="receivable" title="Công nợ phải thu" /></Shell>} /> {/* DEBT-01 */}
      <Route path="/cong-no/phai-tra" element={<Shell><DebtsScreen kind="payable" title="Công nợ phải trả" /></Shell>} /> {/* DEBT-03 */}
      <Route path="/dong-tien" element={<Shell><CashflowHistoryScreen /></Shell>} /> {/* CASH-01 */}
      <Route path="/baocao" element={<Shell><ReportLibraryScreen /></Shell>} /> {/* RPT-00 */}
      <Route path="/baocao/:preset" element={<Shell><ReportRunnerScreen /></Shell>} /> {/* RPT-01→13 */}
      <Route path="/ban-tin/ngay" element={<Shell><NewsletterScreen /></Shell>} /> {/* DASH-03 */}
      <Route path="/thong-bao" element={<Shell><NotificationsScreen /></Shell>} /> {/* NOTI-01 */}
      <Route path="/tim-kiem" element={<Shell><SearchScreen /></Shell>} /> {/* SRCH-02 */}
      <Route path="/ho-so/:loai/:id" element={<Shell><DocumentDetailScreen /></Shell>} /> {/* DOC-01 */}
      <Route path="/quantri" element={<Shell><AdminHomeRedirect /></Shell>} />
      <Route path="/quantri/nguoidung" element={<Shell><PersonnelScreen /></Shell>} /> {/* ADM-01 */}
      <Route path="/quantri/cong-ty" element={<Shell><CompaniesScreen /></Shell>} /> {/* ADM-06/07 */}
      <Route path="/quantri/quy-trinh-duyet" element={<Shell><MatrixScreen /></Shell>} /> {/* ADM-04 */}
      <Route path="/quantri/audit" element={<Shell><AuditLogScreen /></Shell>} /> {/* ADM-12 */}
      <Route path="/quantri/sao-luu" element={<Shell><BackupScreen /></Shell>} /> {/* ADM-14 */}
      <Route path="/ca-nhan" element={<Shell><SettingsScreen /></Shell>} /> {/* PREF-01 */}

      <Route path="*" element={<NotFoundScreen />} />
    </Routes>
  );
}
