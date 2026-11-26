/**
 * FinGate web — thanh onboarding PWA trên điện thoại (chèn NGAY TRÊN header, sticky — docs/07 §7).
 *
 * Thanh KHÔNG đóng được, vì hai việc nó đòi hỏi là điều kiện để người dùng nhận được phiếu chờ duyệt:
 *  - Mở trong tab trình duyệt ⇒ thông báo chết theo tab; iPhone còn chặn hẳn API Notification.
 *  - Đã cài app nhưng chưa cấp quyền thông báo ⇒ server không có đường nào báo tới thiết bị.
 * Xong bước nào thì thanh tự đổi nội dung hoặc ẩn hẳn (`onboardingStep` quyết định).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { enableApprovalNotifications, refreshPushPermission, usePushPermission } from '../app/push-notifications.ts';
import { useToast } from './pagekit.tsx';
import { FgButton, FgText } from './primitives.tsx';
import { installSteps, onboardingStep, useAppMode, useInstallPrompt, useIsIos, useIsMobileDevice } from '../lib/pwa-install.ts';

/**
 * Báo chiều cao thanh cho layout: `.fg-header` / `.fg-filterbar` sticky đang ghim theo
 * `--fg-header-h`, phải dịch xuống đúng `--fg-onboard-h` để thanh này không đè lên chúng.
 */
function useTopBarOffset(el: HTMLElement | null): void {
  const KEY = '--fg-onboard-h';
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const sync = (): void => {
      document.documentElement.style.setProperty(KEY, `${Math.round(el.getBoundingClientRect().height)}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty(KEY);
    };
  }, [el]);
}

export function FgMobileOnboardingBar(): ReactNode {
  const isMobile = useIsMobileDevice();
  const isIos = useIsIos();
  const appMode = useAppMode();
  const permission = usePushPermission();
  const { canPrompt, installed, prompt } = useInstallPrompt();
  const { message } = useToast();

  const step = onboardingStep({ isMobile, isAppMode: appMode, permission });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // iOS không có `beforeinstallprompt` ⇒ mở sẵn hướng dẫn, vì nút không tự cài được.
  const [showSteps, setShowSteps] = useState(isIos);
  const [barEl, setBarEl] = useState<HTMLDivElement | null>(null);
  useTopBarOffset(barEl);

  // Đổi bước (cài xong → bật thông báo) thì bỏ ghi chú của bước trước.
  useEffect(() => setNote(null), [step]);

  if (!step) return null;

  const install = step === 'install';
  const denied = !install && permission === 'denied';
  const unsupported = !install && permission === 'unsupported';

  const title = install
    ? 'Cài FinGate thành ứng dụng'
    : denied || unsupported
      ? 'FinGate chưa gửi được thông báo cho máy này'
      : 'Bật thông báo để không lỡ phiếu chờ duyệt';

  const subtitle = install
    ? isIos
      ? 'iPhone/iPad chỉ nhận được thông báo khi app đã được thêm vào Màn hình chính. Mở bằng Safari rồi làm theo hướng dẫn:'
      : 'Nhận phiếu chờ duyệt cả khi đã tắt app · mở toàn màn hình · chạy nhanh hơn.'
    : denied
      ? 'Trình duyệt đang chặn thông báo cho trang này. Vào Cài đặt hệ thống → Thông báo → FinGate (hoặc chạm biểu tượng khoá cạnh địa chỉ) → Cho phép, rồi bấm Kiểm tra lại.'
      : unsupported
        ? 'Cần iOS 16.4+ và app phải mở từ biểu tượng đã cài — tab Safari không cấp được quyền thông báo.'
        : 'Máy đã có app FinGate nhưng chưa được cấp quyền thông báo, nên phiếu chờ duyệt sẽ không hiện trên màn hình khoá.';

  const onInstall = async (): Promise<void> => {
    const outcome = await prompt();
    if (outcome === 'unavailable') setShowSteps(true);
    else if (outcome === 'dismissed') setNote('Bạn vừa huỷ hộp thoại cài app — bấm “Cài ứng dụng” bất cứ lúc nào.');
  };

  const onEnable = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const result = await enableApprovalNotifications();
      if (result === 'denied') {
        setNote('Bạn chưa chọn Cho phép. Bấm “Bật thông báo” rồi xác nhận hộp thoại của hệ thống.');
        return;
      }
      message.success(
        result === 'push'
          ? 'Đã bật thông báo — FinGate báo cả khi app đã đóng.'
          : 'Đã bật thông báo — máy chủ chưa cấu hình Web Push nên chỉ báo khi app đang mở.',
      );
    } catch (e) {
      setNote(`Không bật được thông báo: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  let action: ReactNode = null;
  if (install && !installed) {
    action = canPrompt ? (
      <FgButton variant="primary" touch onClick={() => void onInstall()} aria-label="Cài FinGate thành ứng dụng">
        Cài ứng dụng
      </FgButton>
    ) : (
      <FgButton variant={showSteps ? 'soft' : 'primary'} touch onClick={() => setShowSteps((v) => !v)}>
        {showSteps ? 'Ẩn hướng dẫn' : 'Hướng dẫn cài'}
      </FgButton>
    );
  } else if (!install && !denied && !unsupported) {
    action = (
      <FgButton variant="primary" loading={busy} touch onClick={() => void onEnable()} aria-label="Bật thông báo cho FinGate">
        Bật thông báo
      </FgButton>
    );
  } else if (denied) {
    action = (
      <FgButton touch onClick={() => refreshPushPermission()}>
        Kiểm tra lại
      </FgButton>
    );
  }

  return (
    <div ref={setBarEl} className="fg-onboard" data-step={step}>
      <div className="fg-onboard-row">
        <span className="fg-onboard-icon" aria-hidden>
          {install ? '⤓' : '🔔'}
        </span>
        <div className="fg-onboard-text">
          <FgText style="bodyS" strong>
            {install && installed ? 'Đã cài app — hãy mở FinGate từ biểu tượng ngoài Màn hình chính' : title}
          </FgText>
          {install && installed ? null : (
            <FgText style="caption" color="secondary" as="div">
              {subtitle}
            </FgText>
          )}
          {note ? (
            <div role="alert" className="fg-onboard-note">
              {note}
            </div>
          ) : null}
        </div>
        {action ? <div className="fg-onboard-action">{action}</div> : null}
      </div>
      {showSteps && install ? (
        <div className="fg-onboard-steps">
          <ol>
            {installSteps(isIos).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
