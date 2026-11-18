/**
 * DOC-01/DOC-02 — card "Cảnh báo phiếu tương tự" (CẢNH BÁO trùng phiếu thu/chi, KHÔNG chặn lưu).
 *
 * Phiếu bị nghi tương tự khi: CÙNG loại (thu/chi) · CÙNG công ty · CÙNG đối tác · số tiền lệch
 * trong ±`SIMILAR_AMOUNT_TOLERANCE_PERCENT`% (cùng tiền tệ). Cùng nguyên tắc với cảnh báo trùng
 * đối tác (`usePartnerDuplicateCheck` trong partner-picker.tsx): chỉ đọc, lỗi im lặng, không form
 * nào bị chặn vì tính năng phụ này.
 *
 * Dùng ở hai nơi: cột phải form lập/sửa phiếu (DƯỚI thẻ "Nộp") và CUỐI tab "Tóm tắt" hồ sơ chi tiết.
 * Server đã sắp theo mức nghi ngờ (đúng số tiền trước) — client giữ nguyên thứ tự.
 * Đảo hạn / chuyển nội bộ không có ô đối tác nghiệp vụ ⇒ card không hiện (return null).
 */

import { type ReactNode } from 'react';
import { Link } from 'react-router';
import { SIMILAR_AMOUNT_TOLERANCE_PERCENT, ddmmyyyy, moneyFromWire } from '@fingate/shared';
import type { SimilarDocumentRow } from '@fingate/shared';
import { formatPercentVN, useSimilarDocuments } from '../app/v2/documents.ts';
import { voucherHref } from '../app/v2/debts.ts';
import { toneStyle } from '../app/theme.ts';
import { FgAlert, FgMoney, FgStatusChip, FgText } from './primitives.tsx';
import { FgCard } from './cards.tsx';
import { useDebounced } from './pagekit.tsx';

/** Số tiền đưa vào phải là chuỗi digit > 0 (khớp regex `amount_minor` của shared) — không gọi API với số hỏng. */
const POSITIVE_DIGITS = /^[1-9]\d*$/;

export function SimilarDocumentsCard({
  kind,
  companyId,
  partnerId,
  amountMinor,
  currency,
  excludeId,
  hideWhenIncomplete = false,
}: {
  kind: string;
  companyId?: string | null;
  partnerId?: string | null;
  amountMinor?: string | null;
  /** Tiền tệ của số tiền đưa vào — thiếu ⇒ server so theo VND. */
  currency?: string | null;
  excludeId?: string | null;
  /** Trang chỉ đọc (tab Tóm tắt): phiếu cũ chưa có đối tác ⇒ ẩn hẳn card thay vì Hint "nhập…". */
  hideWhenIncomplete?: boolean;
}): ReactNode {
  // Đảo hạn / chuyển nội bộ không có ô đối tác nghiệp vụ; chưa chọn công ty ⇒ không tra được.
  const supported = (kind === 'spend' || kind === 'income') && !!companyId;
  // Số tiền gõ tự do ⇒ debounce để không gửi một request mỗi phím (DS §7.11).
  const amountD = useDebounced(amountMinor ?? '', 400);
  const partnerD = useDebounced(partnerId ?? '', 400);

  const ready = supported && !!partnerD && POSITIVE_DIGITS.test(amountD);
  const query = useSimilarDocuments(
    ready && companyId
      ? { kind: kind as 'spend' | 'income', companyId, partnerId: partnerD, amountMinor: amountD, currency: currency ?? undefined, excludeId: excludeId || undefined }
      : null,
  );

  if (!supported) return null;
  if (hideWhenIncomplete && !ready) return null;
  // Lỗi tra ⇒ ẨN toàn bộ card: cảnh báo là tính năng phụ, không bao giờ được chặn form (hook đã retry: false).
  if (query.isError) return null;

  const items: SimilarDocumentRow[] | undefined = query.data?.items;

  return (
    <FgCard title="Cảnh báo phiếu tương tự">
      {!ready ? (
        <FgText style="caption" color="muted">
          Nhập số tiền và chọn đối tác để hệ thống kiểm tra phiếu tương tự (cùng loại, cùng đối tác, số tiền lệch trong ±{SIMILAR_AMOUNT_TOLERANCE_PERCENT}%).
        </FgText>
      ) : !items ? (
        <FgText style="bodyS" color="muted">
          Đang kiểm tra phiếu tương tự…
        </FgText>
      ) : items.length === 0 ? (
        <FgText style="caption" color="muted">
          ✓ Không phát hiện phiếu tương tự.
        </FgText>
      ) : (
        <>
          <FgAlert
            tone="attention"
            title={`${items.length} phiếu có thể trùng`}
            description={`Cùng loại, cùng đối tác, số tiền lệch trong ±${SIMILAR_AMOUNT_TOLERANCE_PERCENT}%. Kiểm tra lại trước khi gửi — hệ thống không chặn lưu.`}
            style={{ marginBottom: 'var(--fg-space-3)' }}
          />
          <div role="list" style={{ display: 'flex', flexDirection: 'column' }}>
            {items.map((r) => (
              <div
                key={r._id}
                role="listitem"
                style={{ display: 'grid', gap: 2, paddingBlock: 'var(--fg-space-2)', borderTop: '1px solid var(--fg-border-subtle)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--fg-space-2)', minWidth: 0 }}>
                  <Link className="fg-link" to={voucherHref(r.kind, r._id)} style={{ fontWeight: 500 }}>
                    {r.code}
                  </Link>
                  <FgStatusChip status={r.status} size="small" />
                  <span style={{ marginInlineStart: 'auto' }}>
                    <FgMoney value={moneyFromWire(r.amount)} mode="compact" />
                  </span>
                </div>
                <FgText style="caption" color="muted" ellipsis>
                  {r.title} — {r.partner_name ?? '—'} — Hạn {ddmmyyyy(r.planned_date)} — tạo bởi {r.created_by_name}
                </FgText>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="fg-chip" style={toneStyle(r.exact_amount ? 'attention' : 'neutral')}>
                    {r.exact_amount ? 'Trùng số tiền' : `Lệch ${formatPercentVN(r.amount_diff_percent)}%`}
                  </span>
                  {r.matched_by === 'payee_name' ? (
                    <span className="fg-chip" style={toneStyle('neutral')}>
                      khớp theo tên (phiếu cũ chưa gắn đối tác)
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </FgCard>
  );
}
