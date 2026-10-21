/**
 * Hội thoại & đường dẫn thao tác trên đối tác (v2/v2.md §5.3, bảng "Nút thao tác trên mỗi đối tác").
 *
 * - Thu / Chi: mở form phiếu với đối tác điền sẵn (`?partner_id=…&kind=…`; Thu của NH gợi ý `loan=borrow`).
 * - Ghi nợ: KH/NCC → chọn Phải thu / Phải trả rồi tới form công nợ; NH → form khoản nợ ngân hàng.
 * - Trả nợ: danh sách khoản còn dư + số tiền phân bổ → `POST /partners/:id/settle` tạo phiếu NHÁP đã gắn
 *   liên kết → mở phiếu đầu tiên, các phiếu còn lại báo ở thông báo.
 * - Sao chép / ngừng / kích hoạt / xoá: hộp thoại tương ứng.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  DEBT_DIRECTIONS,
  DEBT_DIRECTION_LABEL,
  PARTNER_TYPE_LABEL,
  countUnit,
  ddmmyyyy,
  docHref,
  formatMoney,
  type DebtDirection,
  type Money,
  type PartnerStatus,
} from '@fingate/shared';
import { ApiRequestError, uuid } from '../app/api.ts';
import { useAuth, useCurrentCompanyId } from '../app/store.tsx';
import {
  debtDirectionOf,
  useCopyPartners,
  useDeletePartner,
  usePartnerCopySource,
  usePartnerDebts,
  usePartnerLoans,
  useSetPartnerStatus,
  useSettlePartner,
  type PartnerCopyResult,
  type PartnerListRow,
  type PartnerSettleBody,
  type PartnerSettleDebtItem,
  type PartnerSettleLoanItem,
} from '../app/v2/partners.ts';
import type { MoneyWire } from '../app/types.ts';
import { FgCard } from '../components/cards.tsx';
import { useDebounced, useToast } from '../components/pagekit.tsx';
import { notifyPartnerWarnings } from '../components/partner-picker.tsx';
import { FgAlert, FgButton, FgField, FgInput, FgMoney, FgMoneyInput, FgSelect, FgText } from '../components/primitives.tsx';
import { FgEmptyState, FgModal, FgPagination, FgSegmented, FgSkeletonTable, FgTable, FgTag, type TableColumnsType } from '../components/uitk.tsx';

/* ================= đường dẫn Thu / Chi / Ghi nợ (query prefill) ================= */

/** Form phiếu thu/chi với đối tác điền sẵn. Thu của Ngân hàng gợi ý "Khoản vay ngân hàng" (đi vay). */
export function partnerVoucherHref(partnerId: string, kind: 'income' | 'spend', isBank: boolean): string {
  const q = new URLSearchParams({ partner_id: partnerId, kind });
  if (kind === 'income' && isBank) q.set('loan', 'borrow');
  return `${kind === 'income' ? '/thu/moi' : '/chi/moi'}?${q.toString()}`;
}

/** Form khoản công nợ mới: hướng chọn ở bước trước (`direction` v2; `side` v1 để form cũ vẫn đúng). */
export function partnerDebtHref(partnerId: string, direction: DebtDirection): string {
  const side = direction === 'receivable' ? 'debit' : 'credit';
  return `/cong-no/moi?${new URLSearchParams({ partner_id: partnerId, direction, side }).toString()}`;
}

/** Form khoản nợ ngân hàng mới với ngân hàng cho vay điền sẵn. */
export function partnerLoanHref(partnerId: string): string {
  return `/ngan-hang/khoan-vay/moi?${new URLSearchParams({ partner_id: partnerId }).toString()}`;
}

/** Thông điệp lỗi cho thông báo: ưu tiên title / detail từ server. */
export function problemTitleOf(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) return e.problem.detail ? `${e.problem.title}: ${e.problem.detail}` : e.problem.title;
  return fallback;
}

const minorOf = (w: MoneyWire | null | undefined): bigint => (w ? BigInt(w.minor) : 0n);

/* ================= Ghi nợ: chọn hướng (KH / NCC) ================= */

export function DebtDirectionDialog({ partnerId, onClose }: { partnerId: string; onClose: () => void }): ReactNode {
  const navigate = useNavigate();
  const [direction, setDirection] = useState<DebtDirection>('receivable');
  return (
    <FgModal
      open
      title="Ghi nợ — chọn hướng khoản công nợ"
      onCancel={onClose}
      width={480}
      footer={
        <>
          <FgButton onClick={onClose}>Hủy</FgButton>
          <FgButton variant="primary" onClick={() => navigate(partnerDebtHref(partnerId, direction))}>
            Tiếp tục
          </FgButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--fg-space-3)' }}>
        <FgSegmented
          value={direction}
          onChange={(v) => setDirection(v as DebtDirection)}
          options={DEBT_DIRECTIONS.map((d) => ({ value: d, label: DEBT_DIRECTION_LABEL[d] }))}
        />
        <FgText style="bodyS" color="muted">
          {direction === 'receivable'
            ? 'Đối tác còn nợ công ty — khoản phải thu. Thu bằng phiếu thu khi đến hạn.'
            : 'Công ty còn nợ đối tác — khoản phải trả. Trả bằng phiếu chi khi đến hạn.'}
        </FgText>
      </div>
    </FgModal>
  );
}

/* ================= Trả nợ: phân bổ vào các khoản còn dư ================= */

/** Một khoản còn dư để trả. `remaining` = còn lại (KH/NCC) hoặc dư nợ gốc (NH), đơn vị minor. */
interface OpenItem {
  key: string;
  target: 'debt_voucher' | 'bank_debt';
  id: string;
  code: string;
  direction: DebtDirection | 'loan';
  remaining: bigint;
  dueDate: string | null;
  overdue: boolean;
}

/** Số tiền nhập cho một khoản: `main` = số tiền phân bổ (KH/NCC) hoặc GỐC (NH); `interest` / `fee` chỉ NH. */
interface AllocDraft {
  main: Money | null;
  interest: Money | null;
  fee: Money | null;
}

const EMPTY_DRAFT: AllocDraft = { main: null, interest: null, fee: null };
const amountOf = (m: Money | null): bigint => (m ? m.minor : 0n);
const DIRECTION_TEXT: Record<OpenItem['direction'], string> = {
  receivable: 'Phải thu → phiếu thu',
  payable: 'Phải trả → phiếu chi',
  loan: 'Vay NH → phiếu chi',
};

/** Lỗi của một dòng phân bổ (null = hợp lệ). */
function allocationError(it: OpenItem, d: AllocDraft): string | null {
  if (it.target === 'debt_voucher') {
    const v = amountOf(d.main);
    if (v <= 0n) return 'Nhập số tiền phân bổ';
    if (v > it.remaining) return `Vượt số còn có thể trả ${formatMoney(it.remaining)}`;
    return null;
  }
  const principal = amountOf(d.main);
  if (principal + amountOf(d.interest) + amountOf(d.fee) <= 0n) return 'Nhập gốc, lãi hoặc phí';
  if (principal > it.remaining) return `Gốc vượt số còn có thể trả ${formatMoney(it.remaining)}`;
  return null;
}

/**
 * Trả nợ: liệt kê khoản còn dư của đối tác, chọn khoản và nhập số tiền. Gọi `POST /partners/:id/settle`
 * → phiếu NHÁP đã gắn liên kết → mở phiếu đầu tiên.
 */
export function SettlePartnerDialog({
  partner,
  onClose,
}: {
  partner: { _id: string; name: string; type: PartnerListRow['type'] };
  onClose: () => void;
}): ReactNode {
  const isBank = partner.type === 'bank';
  const navigate = useNavigate();
  const { message, notification } = useToast();
  const debts = usePartnerDebts(isBank ? undefined : partner._id);
  const loans = usePartnerLoans(isBank ? partner._id : undefined);
  const settle = useSettlePartner();
  const [picked, setPicked] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AllocDraft>>({});
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // một lần mở hộp thoại = một request_id: bấm đúp / gửi lại sau lỗi không tạo phiếu thứ hai
  const [requestId] = useState(() => uuid());

  const loading = isBank ? loans.isPending : debts.isPending;
  const loadError = isBank ? loans.error : debts.error;

  // "Còn có thể trả" = giá trị − phần đã giữ chỗ bởi phiếu CHƯA huỷ (kể cả phiếu nháp) — đúng giới hạn server kiểm.
  const openItems = useMemo<OpenItem[]>(() => {
    if (isBank) {
      return (loans.data?.items ?? [])
        .filter((l) => l.status !== 'cancelled' && l.status !== 'pending_disbursement' && minorOf(l.available_principal) > 0n)
        .map((l): OpenItem => ({
          key: `bank_debt:${l._id}`,
          target: 'bank_debt',
          id: l._id,
          code: l.code,
          direction: 'loan',
          remaining: minorOf(l.available_principal),
          dueDate: l.maturity_date,
          overdue: l.days_to_maturity < 0,
        }));
    }
    return (debts.data?.items ?? [])
      .filter((d) => d.status !== 'settled' && minorOf(d.available) > 0n)
      .map((d): OpenItem => ({
        key: `debt_voucher:${d._id}`,
        target: 'debt_voucher',
        id: d._id,
        code: d.code,
        direction: debtDirectionOf(d),
        remaining: minorOf(d.available),
        dueDate: d.due_date,
        overdue: d.overdue_days > 0,
      }));
  }, [isBank, debts.data, loans.data]);

  const chosen = openItems.filter((it) => picked.includes(it.key));
  const draftOf = (key: string): AllocDraft => drafts[key] ?? EMPTY_DRAFT;
  const patchDraft = (key: string, patch: Partial<AllocDraft>): void =>
    setDrafts((all) => ({ ...all, [key]: { ...(all[key] ?? EMPTY_DRAFT), ...patch } }));
  const totalOf = (d: AllocDraft): bigint => amountOf(d.main) + amountOf(d.interest) + amountOf(d.fee);

  // tổng nháp: phiếu thu (khoản phải thu) và phiếu chi (khoản phải trả + vay NH)
  let incomeTotal = 0n;
  let spendTotal = 0n;
  for (const it of chosen) {
    if (it.direction === 'receivable') incomeTotal += totalOf(draftOf(it.key));
    else spendTotal += totalOf(draftOf(it.key));
  }
  const anyError = chosen.length === 0 || chosen.some((it) => allocationError(it, draftOf(it.key)) !== null);

  const submit = async (): Promise<void> => {
    setAttempted(true);
    setFormError(null);
    if (anyError) return;
    const items: PartnerSettleDebtItem[] = [];
    const loanItems: PartnerSettleLoanItem[] = [];
    for (const it of chosen) {
      const d = draftOf(it.key);
      if (it.target === 'debt_voucher') {
        items.push({ debt_voucher_id: it.id, amount_minor: amountOf(d.main).toString() });
      } else {
        loanItems.push({
          bank_debt_id: it.id,
          amount_minor: totalOf(d).toString(),
          split: {
            principal: amountOf(d.main).toString(),
            interest: amountOf(d.interest).toString(),
            fee: amountOf(d.fee).toString(),
          },
        });
      }
    }
    const body: PartnerSettleBody = { items, loans: loanItems, note: note.trim() || null, request_id: requestId };
    try {
      const res = await settle.mutateAsync({ partnerId: partner._id, body });
      onClose();
      const vouchers = res.vouchers ?? [];
      if (!vouchers.length) {
        message.success('Đã ghi nhận trả nợ');
        return;
      }
      const first = vouchers[0];
      if (vouchers.length > 1) {
        notification.success({
          message: `Đã tạo ${countUnit(vouchers.length, 'phiếu nháp')}`,
          description: (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {vouchers.map((v) => (
                <li key={v.document_id}>
                  <a
                    href={docHref(v.kind, v.document_id)}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(docHref(v.kind, v.document_id));
                    }}
                  >
                    {v.code}
                  </a>{' '}
                  · {v.kind === 'income' ? 'Phiếu thu' : 'Phiếu chi'}
                </li>
              ))}
            </ul>
          ),
          duration: 10,
        });
      } else {
        message.success(`Đã tạo phiếu nháp ${first.code}`);
      }
      navigate(docHref(first.kind, first.document_id));
    } catch (e) {
      setFormError(problemTitleOf(e, 'Không tạo được phiếu trả nợ'));
    }
  };

  const columns: TableColumnsType<OpenItem> = [
    {
      title: 'Khoản',
      key: 'code',
      render: (_v, r: OpenItem) => <span className="fg-num">{r.code}</span>,
    },
    {
      title: 'Hướng',
      key: 'direction',
      render: (_v, r: OpenItem) => DIRECTION_TEXT[r.direction],
    },
    {
      title: isBank ? 'Còn có thể trả (gốc)' : 'Còn có thể trả',
      key: 'remaining',
      align: 'right',
      render: (_v, r: OpenItem) => <FgMoney value={r.remaining} />,
    },
    {
      title: 'Đến hạn',
      key: 'due',
      render: (_v, r: OpenItem) =>
        r.dueDate ? (
          <span className="fg-num">
            {ddmmyyyy(r.dueDate)} {r.overdue ? <FgTag tone="danger">Quá hạn</FgTag> : null}
          </span>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <FgModal
      open
      title={`Trả nợ — ${partner.name}`}
      onCancel={settle.isPending ? undefined : onClose}
      width={880}
      footer={
        <>
          <FgButton onClick={onClose} disabled={settle.isPending}>
            Hủy
          </FgButton>
          <FgButton variant="primary" loading={settle.isPending} disabled={chosen.length === 0} onClick={() => void submit()}>
            Tạo phiếu nháp
          </FgButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--fg-space-4)' }}>
        <FgText style="bodyS" color="muted">
          {isBank
            ? 'Chọn khoản vay còn dư, nhập gốc / lãi / phí cần trả. Hệ thống tạo phiếu chi nháp đã gắn liên kết trả nợ vay.'
            : 'Chọn khoản còn dư và số tiền phân bổ. Khoản phải thu → phiếu thu nháp; khoản phải trả → phiếu chi nháp; đã gắn liên kết cấn trừ.'}
        </FgText>

        {formError ? <FgAlert tone="danger" title={formError} /> : null}
        {loadError ? <FgAlert tone="danger" title="Không tải được khoản còn dư" description={problemTitleOf(loadError, '')} /> : null}

        {loading ? (
          <FgSkeletonTable rows={3} cols={4} />
        ) : openItems.length === 0 ? (
          <FgEmptyState glyph="✓" title="Không còn khoản nào cần trả" description="Đối tác này không có khoản công nợ hoặc nợ ngân hàng còn dư." />
        ) : (
          <FgTable<OpenItem>
            rowKey="key"
            size="small"
            dataSource={openItems}
            columns={columns}
            pagination={false}
            rowSelection={{ selectedRowKeys: picked, onChange: (keys) => setPicked(keys.map(String)) }}
          />
        )}

        {chosen.length ? (
          <div style={{ display: 'grid', gap: 'var(--fg-space-3)' }}>
            <FgText style="bodyS" strong>
              Số tiền phân bổ
            </FgText>
            {chosen.map((it) => {
              const d = draftOf(it.key);
              const err = attempted ? allocationError(it, d) : null;
              return (
                <FgCard key={it.key} padded style={{ boxShadow: 'none' }}>
                  <FgText style="bodyS" strong>
                    {it.code} · {DIRECTION_TEXT[it.direction]}
                  </FgText>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: it.target === 'bank_debt' ? 'repeat(auto-fit, minmax(170px, 1fr))' : 'minmax(220px, 1fr)',
                      gap: 'var(--fg-space-3)',
                      marginTop: 'var(--fg-space-2)',
                    }}
                  >
                    <FgField label={it.target === 'bank_debt' ? 'Gốc' : 'Số tiền phân bổ'} error={err}>
                      <FgMoneyInput
                        value={d.main}
                        onChange={(m) => patchDraft(it.key, { main: m })}
                        ariaLabel={`Số tiền ${it.code}`}
                        status={err ? 'error' : undefined}
                      />
                    </FgField>
                    {it.target === 'bank_debt' ? (
                      <>
                        <FgField label="Lãi">
                          <FgMoneyInput value={d.interest} onChange={(m) => patchDraft(it.key, { interest: m })} ariaLabel={`Lãi ${it.code}`} />
                        </FgField>
                        <FgField label="Phí">
                          <FgMoneyInput value={d.fee} onChange={(m) => patchDraft(it.key, { fee: m })} ariaLabel={`Phí ${it.code}`} />
                        </FgField>
                      </>
                    ) : null}
                  </div>
                </FgCard>
              );
            })}
          </div>
        ) : null}

        <FgField label="Diễn giải (không bắt buộc)">
          <FgInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: Thanh toán đợt 1 hợp đồng 12/2026" maxLength={500} />
        </FgField>

        <FgText style="bodyS" color="muted">
          Phiếu thu nháp: {formatMoney(incomeTotal)} · Phiếu chi nháp: {formatMoney(spendTotal)}
        </FgText>
      </div>
    </FgModal>
  );
}

/* ================= Sao chép từ công ty khác ================= */

/** Chọn công ty nguồn (người dùng có quyền xem) → chọn đối tác → tạo BẢN SAO mới trong công ty hiện tại. */
const COPY_PAGE_SIZE = 50;

export function CopyPartnersDialog({ onClose }: { onClose: () => void }): ReactNode {
  const currentCompanyId = useCurrentCompanyId();
  const { me } = useAuth();
  const { notification } = useToast();
  const [sourceId, setSourceId] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const searchDebounced = useDebounced(search.trim(), 300);
  const [page, setPage] = useState(1);
  const source = usePartnerCopySource(sourceId, { q: searchDebounced, offset: (page - 1) * COPY_PAGE_SIZE, limit: COPY_PAGE_SIZE });
  const copy = useCopyPartners();
  const [picked, setPicked] = useState<string[]>([]);
  const [result, setResult] = useState<PartnerCopyResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // một lần mở hộp thoại = một request_id: bấm lặp / gửi lại sau lỗi không sao chép đôi
  const [requestId] = useState(() => uuid());

  // Công ty nguồn = các công ty người dùng được gán (me.companies). Không dùng GET /companies: danh sách đó
  // chỉ gồm công ty ĐANG CHỌN nên với người dùng cấp công ty sẽ rỗng.
  const companyOptions = (me?.companies ?? [])
    .filter((c) => c.company_id !== currentCompanyId)
    .map((c) => ({ value: c.company_id, label: c.company_name }));

  const submit = async (): Promise<void> => {
    if (!sourceId || !picked.length) return;
    setFormError(null);
    try {
      const res = await copy.mutateAsync({
        source_company_id: sourceId,
        partner_ids: picked,
        target_company_id: currentCompanyId ?? undefined,
        request_id: requestId,
      });
      setResult(res);
      notifyPartnerWarnings(notification, res.warnings);
    } catch (e) {
      setFormError(problemTitleOf(e, 'Không sao chép được đối tác'));
    }
  };

  const columns: TableColumnsType<PartnerListRow> = [
    { title: 'Tên đối tác', key: 'name', render: (_v, r: PartnerListRow) => r.name },
    { title: 'Loại', key: 'type', render: (_v, r: PartnerListRow) => PARTNER_TYPE_LABEL[r.type] },
    {
      title: 'Ngân hàng · STK',
      key: 'bank',
      render: (_v, r: PartnerListRow) => [r.bank_name, r.account_number].filter(Boolean).join(' · ') || '—',
    },
    { title: 'MST', key: 'tax', render: (_v, r: PartnerListRow) => r.tax_code ?? '—' },
  ];

  const sourceRows = source.data?.items ?? [];
  const sourceTotal = source.data?.total ?? 0;

  return (
    <FgModal
      open
      title="Sao chép đối tác từ công ty khác"
      onCancel={copy.isPending ? undefined : onClose}
      width={820}
      footer={
        result ? (
          <FgButton variant="primary" onClick={onClose}>
            Đóng
          </FgButton>
        ) : (
          <>
            <FgButton onClick={onClose} disabled={copy.isPending}>
              Hủy
            </FgButton>
            <FgButton variant="primary" loading={copy.isPending} disabled={!sourceId || !picked.length} onClick={() => void submit()}>
              {picked.length ? `Sao chép ${countUnit(picked.length, 'đối tác')}` : 'Sao chép'}
            </FgButton>
          </>
        )
      }
    >
      {result ? (
        <div style={{ display: 'grid', gap: 'var(--fg-space-3)' }}>
          <FgAlert
            tone="success"
            title={`Đã sao chép ${countUnit(result.created.length, 'đối tác')} vào công ty hiện tại`}
            description="Mỗi bản sao là đối tác mới có mã riêng; sửa bên này không ảnh hưởng công ty nguồn."
          />
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {result.created.map((c) => (
              <li key={c.partner_id}>
                <span className="fg-num">{c.code}</span> · {c.name}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--fg-space-4)' }}>
          {formError ? <FgAlert tone="danger" title={formError} /> : null}
          <FgField label="Công ty nguồn" required>
            <FgSelect
              options={companyOptions}
              value={sourceId}
              placeholder="Chọn công ty có quyền xem"
              onChange={(v) => {
                setSourceId(v || undefined);
                setPicked([]);
                setSearch('');
                setPage(1);
              }}
              style={{ minWidth: 280, width: '100%' }}
            />
          </FgField>

          {!sourceId ? (
            <FgText style="bodyS" color="muted">
              Chọn công ty nguồn để xem danh bạ đối tác đang hoạt động.
            </FgText>
          ) : source.isPending ? (
            <FgSkeletonTable rows={3} cols={4} />
          ) : source.error ? (
            <FgAlert tone="danger" title="Không xem được danh bạ công ty này" description={problemTitleOf(source.error, '')} />
          ) : sourceRows.length === 0 && !searchDebounced ? (
            <FgEmptyState glyph="◇" title="Công ty này chưa có đối tác đang hoạt động" />
          ) : (
            <div style={{ display: 'grid', gap: 'var(--fg-space-3)' }}>
              <FgInput
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="Tìm theo tên, số tài khoản, MST…"
                aria-label="Tìm đối tác công ty nguồn"
                allowClear
              />
              {sourceRows.length === 0 ? (
                <FgEmptyState glyph="◇" title="Không có đối tác phù hợp với từ khoá" />
              ) : (
                <FgTable<PartnerListRow>
                  rowKey="_id"
                  size="small"
                  dataSource={sourceRows}
                  columns={columns}
                  pagination={false}
                  rowSelection={{ selectedRowKeys: picked, onChange: (keys) => setPicked(keys.map(String)) }}
                />
              )}
              {sourceTotal > COPY_PAGE_SIZE ? (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <FgPagination current={page} pageSize={COPY_PAGE_SIZE} total={sourceTotal} showSizeChanger={false} onChange={(p) => setPage(p)} />
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}
    </FgModal>
  );
}

/* ================= Ngừng / kích hoạt lại ================= */

export function TogglePartnerStatusDialog({
  partner,
  onClose,
  onDone,
}: {
  partner: { _id: string; name: string; status: PartnerStatus };
  onClose: () => void;
  onDone?: () => void;
}): ReactNode {
  const setStatus = useSetPartnerStatus();
  const { message } = useToast();
  const next: PartnerStatus = partner.status === 'active' ? 'inactive' : 'active';
  const stopping = next === 'inactive';
  return (
    <FgModal
      open
      title={stopping ? 'Ngừng giao dịch với đối tác?' : 'Kích hoạt lại đối tác?'}
      onCancel={setStatus.isPending ? undefined : onClose}
      width={480}
      footer={
        <>
          <FgButton onClick={onClose} disabled={setStatus.isPending}>
            Hủy
          </FgButton>
          <FgButton
            variant={stopping ? 'danger' : 'primary'}
            loading={setStatus.isPending}
            onClick={() =>
              setStatus.mutate(
                { id: partner._id, status: next },
                {
                  onSuccess: () => {
                    message.success(stopping ? 'Đã ngừng giao dịch' : 'Đã kích hoạt lại');
                    onDone?.();
                    onClose();
                  },
                  onError: (e) => message.error(problemTitleOf(e, 'Không cập nhật được đối tác')),
                },
              )
            }
          >
            {stopping ? 'Ngừng giao dịch' : 'Kích hoạt lại'}
          </FgButton>
        </>
      }
    >
      <FgText style="body">
        {stopping
          ? `“${partner.name}” sẽ không chọn được cho phiếu, công nợ hoặc khoản vay mới. Dữ liệu cũ và lịch sử vẫn giữ nguyên.`
          : `“${partner.name}” sẽ chọn lại được cho phiếu, công nợ và khoản vay mới.`}
      </FgText>
    </FgModal>
  );
}

/* ================= Xoá (chỉ khi chưa phát sinh) ================= */

export function DeletePartnerDialog({
  partner,
  onClose,
  onDeleted,
}: {
  partner: { _id: string; name: string };
  onClose: () => void;
  onDeleted?: () => void;
}): ReactNode {
  const del = useDeletePartner();
  const { message } = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  return (
    <FgModal
      open
      title="Xoá đối tác?"
      onCancel={del.isPending ? undefined : onClose}
      width={480}
      footer={
        <>
          <FgButton onClick={onClose} disabled={del.isPending}>
            Hủy
          </FgButton>
          <FgButton
            variant="danger"
            loading={del.isPending}
            onClick={() =>
              del.mutate(partner._id, {
                onSuccess: () => {
                  message.success('Đã xoá đối tác');
                  onDeleted?.();
                  onClose();
                },
                onError: (e) => setFormError(problemTitleOf(e, 'Không xoá được đối tác')),
              })
            }
          >
            Xoá
          </FgButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--fg-space-3)' }}>
        <FgText style="body">
          Xoá <strong>{partner.name}</strong> khỏi danh bạ? Chỉ xoá được đối tác chưa phát sinh phiếu, công nợ hoặc nợ ngân hàng.
        </FgText>
        {formError ? <FgAlert tone="danger" title={formError} description="Đối tác đã phát sinh chỉ có thể ngừng giao dịch." /> : null}
      </div>
    </FgModal>
  );
}
