/**
 * AUTH-01 Đăng nhập (+ chế độ 2FA cùng route) · AUTH-03 Quên mật khẩu · AUTH-04 Đặt lại.
 *
 * - Sai credentials: MỘT thông điệp duy nhất, không tiết lộ field nào sai (FG-AUTH-002).
 * - Lockout FG-AUTH-007: hiện thời gian chờ, disable nút.
 * - Không log mật khẩu/OTP; input OTP numeric tự fill.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiRequestError, apiCall } from '../app/api.ts';
import { useAuth } from '../app/store.tsx';
import { FgAlert, FgButton, FgField, FgInput, FgPassword, FgText } from '../components/primitives.tsx';
import { useColdStart } from '../components/pagekit.tsx';

function AuthFrame({ children, title }: { children: ReactNode; title: string }): ReactNode {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--fg-bg-page)',
        padding: 'var(--fg-space-4)',
      }}
    >
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div style={{ textAlign: 'center', marginBottom: 'var(--fg-space-6)' }}>
          <div
            className="fg-rail-mark"
            style={{ width: 44, height: 44, margin: '0 auto', fontSize: 22, background: 'var(--fg-action-primary)', color: 'var(--fg-action-primary-text)' }}
            aria-hidden
          >
            F
          </div>
          <FgText style="h2">{title}</FgText>
          <div>
            <FgText style="bodyS" color="muted">
              Quản trị dòng tiền tập đoàn
            </FgText>
          </div>
        </div>
        <div className="fg-card">{children}</div>
      </div>
    </div>
  );
}

export function LoginScreen(): ReactNode {
  const { login, login2fa } = useAuth();
  const navigate = useNavigate();
  const waking = useColdStart();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const [twoFa, setTwoFa] = useState<{ challenge: string; resendAfterS: number } | null>(null);
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (twoFa) {
      codeRef.current?.focus();
      const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
      return () => clearInterval(t);
    }
  }, [twoFa]);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(email, password);
      if (r.need_2fa && r.challenge) {
        setTwoFa({ challenge: r.challenge, resendAfterS: r.resend_after_s ?? 30 });
        setCooldown(r.resend_after_s ?? 30);
      } else {
        navigate(sessionStorage.getItem('fg.returnTo') ?? '/dashboard');
      }
    } catch (err) {
      const p = err instanceof ApiRequestError ? err.problem : null;
      if (p?.code === 'FG-AUTH-007') setError(p.title);
      else if (p?.code === 'FG-AUTH-003' || p?.code === 'FG-AUTH-004') setError(`${p.title} — liên hệ Quản trị của bạn.`);
      else setError(p?.title ?? 'Không đăng nhập được. Kiểm tra kết nối và thử lại.');
    } finally {
      setBusy(false);
    }
  };

  const submit2fa = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!twoFa) return;
    setBusy(true);
    setError(null);
    try {
      await login2fa(twoFa.challenge, code.trim());
      navigate('/dashboard');
    } catch (err) {
      const p = err instanceof ApiRequestError ? err.problem : null;
      setError(p?.code === 'FG-AUTH-006' ? 'Mã không đúng hoặc đã hết hiệu lực. Nhập lại.' : p?.title ?? 'Xác thực thất bại.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Đăng nhập FinGate">
      {twoFa ? (
        <form onSubmit={submit2fa} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }} noValidate>
          <FgField label="Mã xác thực 2 lớp" help="Nhập 6 số từ ứng dụng xác thực, hoặc 1 recovery code." required labelFor="otp">
            <FgInput
              id="otp"
              ref={codeRef as never}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={16}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="000000"
              style={{ letterSpacing: 6, textAlign: 'center', fontFamily: 'var(--fg-font-mono)' }}
            />
          </FgField>
          {error}
          <FgButton variant="primary" htmlType="submit" block loading={busy} disabled={code.length < 6}>
            Xác nhận
          </FgButton>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <FgButton variant="ghost" size="small" disabled={cooldown > 0} onClick={() => void submit()}>
              {cooldown > 0 ? `Gửi lại sau ${cooldown}s` : 'Gửi lại mã'}
            </FgButton>
            <FgButton variant="ghost" size="small" onClick={() => setTwoFa(null)}>
              Không phải bạn? Đổi tài khoản
            </FgButton>
          </div>
        </form>
      ) : (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }} noValidate>
          {waking ? <FgAlert tone="info" title="Máy chủ đang thức dậy, vui lòng chờ…" /> : null}
          <FgField label="Email công việc" required labelFor="email">
            <FgInput id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ban@congty.vn" />
          </FgField>
          <FgField label="Mật khẩu" required labelFor="pass">
            <FgPassword id="pass" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </FgField>
          {typeof error === 'string' || error ? (
            <FgAlert tone={String(error).includes('nhiều lần') ? 'warning' : 'danger'} title={error ?? ''} />
          ) : null}
          <FgButton variant="primary" htmlType="submit" block loading={busy} disabled={!email || password.length < 8}>
            Đăng nhập
          </FgButton>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Link to="/mat-khau/quen" className="fg-link" style={{ fontSize: 'var(--fg-font-body-s-size)' }}>
              Quên mật khẩu?
            </Link>
            <FgText style="bodyS" color="muted">
              Tài khoản do Quản trị mời — không có đăng ký mở
            </FgText>
          </div>
        </form>
      )}
    </AuthFrame>
  );
}

export function ForgotPasswordScreen(): ReactNode {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AuthFrame title="Quên mật khẩu">
      {sent ? (
        <FgAlert
          tone="success"
          title="Nếu email tồn tại trong hệ thống, chúng tôi đã gửi liên kết đặt lại."
          description="Kiểm tra hộp thư (kể cả thư rác). Liên kết hết hạn sau 30 phút."
        />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await apiCall('/auth/password-forgot', { method: 'POST', body: { email } });
            } catch {
              /* chống dò: luôn trả cùng thông điệp */
            }
            setBusy(false);
            setSent(true);
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}
        >
          <FgField label="Email công việc" required labelFor="femail">
            <FgInput id="femail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </FgField>
          <FgButton variant="primary" htmlType="submit" block loading={busy}>
            Gửi liên kết đặt lại
          </FgButton>
          <Link to="/dang-nhap" className="fg-link" style={{ textAlign: 'center' }}>
            Về đăng nhập
          </Link>
        </form>
      )}
    </AuthFrame>
  );
}

export function ResetPasswordScreen(): ReactNode {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const navigate = useNavigate();
  const strength = pw.length >= 16 ? { label: 'Mạnh', tone: 'success' } : pw.length >= 12 ? { label: 'Đạt yêu cầu', tone: 'info' } : { label: 'Tối thiểu 12 ký tự', tone: pw ? 'danger' : 'neutral' };
  return (
    <AuthFrame title="Đặt lại mật khẩu">
      {done ? (
        <>
          <FgAlert tone="success" title="Mật khẩu mới đã được thiết lập." />
          <div style={{ marginTop: 'var(--fg-space-4)' }}>
            <FgButton variant="primary" block onClick={() => navigate('/dang-nhap')}>
              Đăng nhập
            </FgButton>
          </div>
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            if (pw.length < 12) return setErr('Mật khẩu tối thiểu 12 ký tự.');
            if (pw !== pw2) return setErr('Mật khẩu nhập lại không khớp.');
            try {
              await apiCall('/auth/password-reset', { method: 'POST', body: { token, new_password: pw } });
              setDone(true);
            } catch (e2) {
              setErr(e2 instanceof ApiRequestError ? e2.problem.title : 'Liên kết không còn hiệu lực.');
            }
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}
        >
          <FgField label="Mật khẩu mới" required error={err && err.includes('12') ? err : null} help={<FgText style="caption" color="muted">{strength.label}</FgText>}>
            <FgPassword autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </FgField>
          <FgField label="Nhập lại mật khẩu" required error={err && err.includes('khớp') ? err : null}>
            <FgPassword autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </FgField>
          {err && !err.includes('12') && !err.includes('khớp') ? <FgAlert tone="danger" title={err} /> : null}
          <FgButton variant="primary" htmlType="submit" block>
            Đặt lại
          </FgButton>
        </form>
      )}
    </AuthFrame>
  );
}
