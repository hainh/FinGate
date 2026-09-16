/**
 * routes.tsx — mỗi route mang screenId (comment) + yêu cầu quyền; guard theo phiên.
 * Screen lazy-load theo nhóm (budget bundle: report/admin route lazy).
 */

import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './app/store.tsx';
import { FgAppShell } from './components/shell.tsx';
import { LoginScreen, ForgotPasswordScreen, ResetPasswordScreen } from './screens/auth.tsx';
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
import { BalanceEntryScreen, BankAccountsScreen } from './screens/bank.tsx';
import { DebtsScreen, LoansScreen, RolloversScreen } from './screens/loans.tsx';
import { ForecastScreen } from './screens/forecast.tsx';
import { ReportLibraryScreen, ReportRunnerScreen } from './screens/reports.tsx';
import { PersonnelScreen, MatrixScreen, AuditLogScreen, SettingsScreen } from './screens/admin.tsx';
import { NeedsAttentionScreen, NewsletterScreen, NotificationsScreen, SearchScreen } from './screens/misc.tsx';
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
    if (status === 'anon' && !location.pathname.startsWith('/dang-nhap')) {
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

function Shell({ children }: { children: ReactNode }): ReactNode {
  return (
    <Guard>
      <FgAppShell>{children}</FgAppShell>
    </Guard>
  );
}

export function AppRoutes(): ReactNode {
  const location = useLocation();
  return (
    <Routes key={location.pathname}>
      <Route path="/dang-nhap" element={<LoginScreen />} />
      <Route path="/mat-khau/quen" element={<ForgotPasswordScreen />} />
      <Route path="/mat-khau/dat-lai" element={<ResetPasswordScreen />} />
      <Route path="/403" element={<ForbiddenScreen />} />

      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<Shell><DashboardScreen /></Shell>} /> {/* DASH-01 */}
      <Route path="/cho-toi-duyet" element={<Shell><ApprovalQueueScreen /></Shell>} /> {/* APPR-01 */}
      <Route path="/toi-da-duyet" element={<Shell><ProcessedScreen /></Shell>} /> {/* APPR-02 */}
      <Route path="/can-bo-sung" element={<Shell><ChangesRequestedScreen /></Shell>} /> {/* APPR-03 */}
      <Route path="/can-xu-ly" element={<Shell><NeedsAttentionScreen /></Shell>} /> {/* DASH-05 */}
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
      <Route path="/ngan-hang/so-du" element={<Shell><BalanceEntryScreen /></Shell>} /> {/* BANK-04 */}
      <Route path="/ngan-hang/khoan-vay" element={<Shell><LoansScreen /></Shell>} /> {/* LOAN-01 */}
      <Route path="/ngan-hang/dao-han" element={<Shell><RolloversScreen /></Shell>} /> {/* RENEW-01 */}
      <Route path="/ngan-hang/dao-han/phuong-an/moi" element={<Shell><DocumentFormScreen kind="rollover" /></Shell>} /> {/* RENEW-02 */}
      <Route path="/ngan-hang/chuyen-noi-bo" element={<Shell><InternalListScreen /></Shell>} /> {/* BANK-07 */}
      <Route path="/ngan-hang/chuyen-noi-bo/moi" element={<Shell><DocumentFormScreen kind="internal" /></Shell>} /> {/* BANK-08 */}
      <Route path="/cong-no/phai-thu" element={<Shell><DebtsScreen kind="receivable" title="Công nợ phải thu" /></Shell>} /> {/* DEBT-01 */}
      <Route path="/cong-no/phai-tra" element={<Shell><DebtsScreen kind="payable" title="Công nợ phải trả" /></Shell>} /> {/* DEBT-03 */}
      <Route path="/dong-tien" element={<Shell><ForecastScreen /></Shell>} /> {/* CASH-01 */}
      <Route path="/baocao" element={<Shell><ReportLibraryScreen /></Shell>} /> {/* RPT-00 */}
      <Route path="/baocao/:preset" element={<Shell><ReportRunnerScreen /></Shell>} /> {/* RPT-01→13 */}
      <Route path="/ban-tin/ngay" element={<Shell><NewsletterScreen /></Shell>} /> {/* DASH-03 */}
      <Route path="/thong-bao" element={<Shell><NotificationsScreen /></Shell>} /> {/* NOTI-01 */}
      <Route path="/tim-kiem" element={<Shell><SearchScreen /></Shell>} /> {/* SRCH-02 */}
      <Route path="/ho-so/:loai/:id" element={<Shell><DocumentDetailScreen /></Shell>} /> {/* DOC-01 */}
      <Route path="/quantri/nguoidung" element={<Shell><PersonnelScreen /></Shell>} /> {/* ADM-01 */}
      <Route path="/quantri/quy-trinh-duyet" element={<Shell><MatrixScreen /></Shell>} /> {/* ADM-04 */}
      <Route path="/quantri/audit" element={<Shell><AuditLogScreen /></Shell>} /> {/* ADM-12 */}
      <Route path="/ca-nhan" element={<Shell><SettingsScreen /></Shell>} /> {/* PREF-01 */}

      <Route path="*" element={<NotFoundScreen />} />
    </Routes>
  );
}
