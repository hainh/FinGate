/**
 * AUTH-01 Đăng nhập (+ chế độ 2FA cùng route) · AUTH-03 Quên mật khẩu · AUTH-04 Đặt lại.
 *
 * - Sai credentials: MỘT thông điệp duy nhất, không tiết lộ field nào sai (FG-AUTH-002).
 * - Lockout FG-AUTH-007: hiện thời gian chờ, disable nút.
 * - Không log mật khẩu/OTP; input OTP numeric tự fill.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Checkbox } from 'antd';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiRequestError, apiCall, markSignedOut } from '../app/api.ts';
import { useAuth } from '../app/store.tsx';
import { FgAlert, FgButton, FgField, FgInput, FgPassword, FgText } from '../components/primitives.tsx';
import { useColdStart } from '../components/pagekit.tsx';
import type { InviteInfo } from '../app/types.ts';

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
            style={{ width: 94, height: 44, margin: '0 auto', fontSize: 22, background: 'var(--fg-action-primary)', color: 'var(--fg-action-primary-text)' }}
            aria-hidden
          >
            FinGate
          </div>
          <FgText style="h2">{title}</FgText>
          <div>
            <FgText style="bodyS" color="muted">
              Cổng tài chính VIASG
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
  const waking = useColdStart();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(true);
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
      const r = await login(email, password, remember);
      if (r.need_2fa && r.challenge) {
        setTwoFa({ challenge: r.challenge, resendAfterS: r.resend_after_s ?? 30 });
        setCooldown(r.resend_after_s ?? 30);
      }
      // Đăng nhập thành công: `login` đã điều hướng theo quyền (xem store.tsx homeFor).
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
      // `login2fa` đã điều hướng theo quyền (store.tsx homeFor).
    } catch (err) {
      const p = err instanceof ApiRequestError ? err.problem : null;
      setError(p?.code === 'FG-AUTH-006' ? 'Mã không đúng hoặc đã hết hiệu lực. Nhập lại.' : p?.title ?? 'Xác thực thất bại.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Đăng nhập">
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
          <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)}>
            <FgText style="bodyS" color="muted">
              Ghi nhớ đăng nhập — không hết hạn phiên
            </FgText>
          </Checkbox>
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

/**
 * AUTH-05 — Kích hoạt tài khoản từ link mời có chữ ký (admin copy gửi, không qua mail).
 *
 * - GET /activate/info?token= → hiển thị "được mời vào công ty X, chức danh Y" + hạn link.
 * - Người nhận TỰ ĐẶT MẬT KHẨU (>=12 ký tự) + họ tên → POST /activate → vào hệ thống.
 * - Server gắn sẵn công ty/vai trò từ lúc mời; link chết sau một lần kích hoạt.
 * - Vai trò nhóm bắt buộc 2FA: chỉ NHẮC người dùng bật trong Cài đặt (PREF-01) sau khi đăng nhập.
 */
export function ActivateScreen(): ReactNode {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const refreshMe = useAuth().refreshMe;
  const navigate = useNavigate();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfaSuggested, setMfaSuggested] = useState(false);
  const [doneName, setDoneName] = useState<string | null>(null);
  /** link quản trị cấp để ĐẶT LẠI mật khẩu (tài khoản đã hoạt động) hay kích hoạt lần đầu. */
  const isReset = info?.mode === 'reset';

  useEffect(() => {
    if (!token) {
      setInfoError('Liên kết không hợp lệ — thiếu token. Hãy xin Quản trị link mới.');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiCall<{ data: InviteInfo }>('/activate/info', { query: { token } });
        if (!cancelled && r.data) {
          setInfo(r.data);
          if (r.data.display_name) setName(r.data.display_name);
        }
      } catch (e) {
        if (!cancelled) {
          const p = e instanceof ApiRequestError ? e.problem : null;
          setInfoError(p?.code === 'FG-AUTH-009' ? 'Liên kết không còn hiệu lực (hết hạn, đã thu hồi, hoặc đã kích hoạt). Xin Quản trị tạo link mới.' : p?.title ?? 'Không tải được thông tin lời mời.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e?: React.FormEvent): Promise<void> => {
    e?.preventDefault();
    setErr(null);
    // link đổi mật khẩu giữ nguyên họ tên hiện có — không hỏi lại
    const nameToSend = isReset
      ? info?.display_name?.trim() || info?.email?.split('@')[0] || 'Người dùng'
      : name.trim();
    if (!isReset && nameToSend.length < 2) return setErr('Vui lòng nhập họ tên của bạn.');
    if (pw.length < 12) return setErr('Mật khẩu tối thiểu 12 ký tự.');
    if (pw !== pw2) return setErr('Mật khẩu nhập lại không khớp.');
    setBusy(true);
    try {
      const r = await apiCall<{ data: { ok: boolean; user_id?: string; mfa_suggested?: boolean } }>('/activate', {
        method: 'POST',
        body: { token, password: pw, display_name: nameToSend },
      });
      setMfaSuggested(Boolean(r.data.mfa_suggested));
      markSignedOut(false);
      await refreshMe();
      setDoneName(nameToSend || String(info?.email ?? ''));
    } catch (e2) {
      const p = e2 instanceof ApiRequestError ? e2.problem : null;
      if (p?.code === 'FG-AUTH-009') setInfoError('Liên kết không còn hiệu lực. Xin Quản trị tạo link mới.');
      else setErr(p?.detail ?? p?.title ?? 'Không kích hoạt được. Thử lại.');
    } finally {
      setBusy(false);
    }
  };

  if (doneName) {
    return (
      <AuthFrame title={isReset ? 'Đổi mật khẩu thành công' : 'Kích hoạt thành công'}>
        <FgAlert
          tone="success"
          title={`Chào ${doneName}, bạn đã vào hệ thống.`}
          description={isReset ? 'Mật khẩu mới đã được thiết lập và mọi phiên đăng nhập cũ đã bị thu hồi.' : 'Mật khẩu và quyền đã được kích hoạt đúng công ty được chỉ định.'}
        />
        {mfaSuggested ? (
          <div style={{ marginTop: 'var(--fg-space-3)' }}>
            <FgAlert tone="info" title="Vai trò của bạn thuộc nhóm bắt buộc 2FA" description="Vào Cài đặt cá nhân → Xác thực 2 lớp để bật ngay sau khi đăng nhập lần đầu." />
          </div>
        ) : null}
        <div style={{ marginTop: 'var(--fg-space-4)' }}>
          <FgButton variant="primary" block onClick={() => navigate('/dashboard')}>
            Vào bảng điều khiển
          </FgButton>
        </div>
      </AuthFrame>
    );
  }

  if (infoError) {
    return (
      <AuthFrame title="Liên kết không hợp lệ">
        <FgAlert tone="danger" title={infoError} description="Quản trị của bạn có thể tạo lại link mới bất cứ lúc nào — link cũ sẽ bị vô hiệu." />
        <div style={{ marginTop: 'var(--fg-space-4)' }}>
          <Link to="/dang-nhap" className="fg-link" style={{ display: 'block', textAlign: 'center' }}>
            Về đăng nhập
          </Link>
        </div>
      </AuthFrame>
    );
  }

  if (!info) {
    return (
      <AuthFrame title="Kích hoạt tài khoản">
        <FgText color="muted">Đang kiểm tra liên kết…</FgText>
      </AuthFrame>
    );
  }

  const strength = pw.length >= 16 ? { label: 'Mạnh', tone: 'success' } : pw.length >= 12 ? { label: 'Đạt yêu cầu', tone: 'info' } : { label: 'Tối thiểu 12 ký tự', tone: pw ? 'danger' : 'neutral' };

  return (
    <AuthFrame title={isReset ? 'Đặt lại mật khẩu' : 'Đặt mật khẩu kích hoạt'}>
      <div style={{ marginBottom: 'var(--fg-space-4)', padding: '10px 12px', border: '1px solid var(--fg-border-subtle)', borderRadius: 8 }}>
        <FgText style="bodyS" color="muted">
          {isReset
            ? <>{info.invited_by_name ? `${info.invited_by_name} cấp liên kết` : 'Quản trị cấp liên kết'} đặt lại mật khẩu cho <strong>{info.company_name || 'công ty'}</strong></>
            : <>{info.invited_by_name ? `${info.invited_by_name} mời` : 'Bạn được mời'} tham gia <strong>{info.company_name || 'công ty'}</strong></>}
          {info.department_name ? ` · ${info.department_name}` : ''}
        </FgText>
        <div>
          <FgText style="bodyS" color="muted">
            Chức danh: <strong>{info.role_label}</strong> · Email: {info.email} · Hiệu lực tới: {new Date(info.expires_at).toLocaleString('vi-VN')}
          </FgText>
        </div>
      </div>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }} noValidate>
        {isReset ? null : (
          <FgField label="Họ tên của bạn" required labelFor="act-name">
            <FgInput id="act-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nguyễn Văn A" />
          </FgField>
        )}
        <FgField label="Mật khẩu mới" required labelFor="act-pw" help={<FgText style="caption" color="muted">{strength.label}</FgText>}>
          <FgPassword id="act-pw" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </FgField>
        <FgField label="Nhập lại mật khẩu" required labelFor="act-pw2">
          <FgPassword id="act-pw2" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </FgField>
        {err ? <FgAlert tone="danger" title={err} /> : null}
        <FgButton variant="primary" htmlType="submit" block loading={busy} disabled={(isReset ? false : !name.trim()) || pw.length < 8 || !pw2}>
          {isReset ? 'Đặt lại mật khẩu' : 'Kích hoạt tài khoản'}
        </FgButton>
        {info.mfa_required ? (
          <FgText style="caption" color="muted">
            Vai trò này thuộc nhóm bắt buộc 2FA — sau khi đăng nhập, hệ thống sẽ yêu cầu bật Xác thực 2 lớp trong Cài đặt.
          </FgText>
        ) : null}
        <FgText style="caption" color="muted">
          {isReset
            ? 'Liên kết chỉ dùng một lần. Sau khi đặt lại, mọi phiên đăng nhập cũ bị thu hồi — hãy đăng nhập lại bằng mật khẩu mới.'
            : 'Liên kết chỉ dùng một lần. Sau khi kích hoạt, mật khẩu là chìa khóa duy nhất — link cũ không còn giá trị.'}
        </FgText>
      </form>
    </AuthFrame>
  );
}
