/**
 * PARTNER-01 — Danh bạ Đối tác / Khách hàng.
 *
 * Mỗi đối tác (khoá = tên công ty) có nhiều tài khoản ngân hàng (khoá = số tài khoản).
 * Danh bạ dùng chung toàn tập đoàn; được tự động tạo từ phiếu thu/chi dạng
 * `Tên công ty - Ngân hàng - Số tài khoản`.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../app/store.tsx';
import {
  useCounterparties,
  useCreateCounterparty,
  useDeleteCounterparty,
  useUpdateCounterparty,
} from '../app/queries.ts';
import { ApiRequestError } from '../app/api.ts';
import { FgAlert, FgButton, FgField, FgInput, FgText } from '../components/primitives.tsx';
import { FgEmptyState, FgModal, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useToast } from '../components/pagekit.tsx';
import type { CounterpartyRow } from '../app/types.ts';

interface BankDraft {
  bank_name: string;
  account_number: string;
}

interface FlatRow {
  key: string;
  cp: CounterpartyRow;
  bank: { _id: string; bank_name: string; account_number: string } | null;
  first: boolean;
  span: number;
}

export function CounterpartyScreen(): ReactNode {
  const { can } = useAuth();
  const canWrite = can('partner:write');
  const [q, setQ] = useState('');
  const query = useCounterparties(q.trim() || undefined);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CounterpartyRow | null>(null);
  const [deleting, setDeleting] = useState<CounterpartyRow | null>(null);

  const rows = useMemo<FlatRow[]>(() => {
    const items = query.data?.items ?? [];
    const out: FlatRow[] = [];
    for (const cp of items) {
      if (!cp.banks.length) {
        out.push({ key: cp._id, cp, bank: null, first: true, span: 1 });
        continue;
      }
      cp.banks.forEach((b, i) => {
        out.push({
          key: `${cp._id}-${b._id}`,
          cp,
          bank: { _id: b._id, bank_name: b.bank_name, account_number: b.account_number },
          first: i === 0,
          span: i === 0 ? cp.banks.length : 0,
        });
      });
    }
    return out;
  }, [query.data]);

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (cp: CounterpartyRow) => {
    setEditing(cp);
    setOpen(true);
  };

  return (
    <>
      <FgPageHeader
        title="Đối tác / Khách hàng"
        meta="Danh bạ dùng chung toàn tập đoàn · mỗi đối tác có nhiều tài khoản ngân hàng"
        actions={
          canWrite ? (
            <FgButton variant="primary" onClick={openCreate}>
              + Tạo đối tác
            </FgButton>
          ) : null
        }
      />
      <div className="fg-filterbar">
        <FgInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm theo tên, ngân hàng, số tài khoản…"
          style={{ width: 320, maxWidth: '100%' }}
          allowClear
        />
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={4} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState
                glyph="◇"
                title="Chưa có đối tác nào"
                description="Đối tác được tạo tự động từ phiếu thu/chi dạng “Tên công ty - Ngân hàng - Số tài khoản”, hoặc bấm “Tạo đối tác”."
              />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable
                rowKey="key"
                dataSource={rows}
                pagination={false}
                columns={[
                  {
                    title: 'Tên đối tác',
                    key: 'name',
                    onCell: (r: FlatRow) => ({ rowSpan: r.span }),
                    render: (_v, r: FlatRow) =>
                      r.first ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <span style={{ fontWeight: 500 }}>{r.cp.name}</span>
                          {canWrite ? (
                            <div style={{ display: 'flex', gap: 8 }}>
                              <FgButton size="small" onClick={() => openEdit(r.cp)}>
                                Sửa
                              </FgButton>
                              <FgButton size="small" variant="danger" onClick={() => setDeleting(r.cp)}>
                                Xoá
                              </FgButton>
                            </div>
                          ) : null}
                        </div>
                      ) : null,
                  },
                  {
                    title: 'Ngân hàng',
                    key: 'bank',
                    render: (_v, r: FlatRow) => (r.bank ? r.bank.bank_name : <FgText color="muted">—</FgText>),
                  },
                  {
                    title: 'Số tài khoản',
                    key: 'account',
                    render: (_v, r: FlatRow) =>
                      r.bank ? <span className="fg-num">{r.bank.account_number}</span> : <FgText color="muted">—</FgText>,
                  },
                ]}
              />
            </div>
          )
        }
      </FgQuery>

      {open ? (
        <CounterpartyFormModal
          editing={editing}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            query.refetch();
          }}
        />
      ) : null}

      {deleting ? <DeleteCounterpartyModal cp={deleting} onClose={() => setDeleting(null)} onDeleted={() => query.refetch()} /> : null}
    </>
  );
}

function CounterpartyFormModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: CounterpartyRow | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactNode {
  const create = useCreateCounterparty();
  const update = useUpdateCounterparty(editing?._id ?? '');
  const { message } = useToast();
  const [name, setName] = useState(editing?.name ?? '');
  const [banks, setBanks] = useState<BankDraft[]>(
    editing && editing.banks.length
      ? editing.banks.map((b) => ({ bank_name: b.bank_name, account_number: b.account_number }))
      : [{ bank_name: '', account_number: '' }],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const busy = create.isPending || update.isPending;

  const setBank = (i: number, patch: Partial<BankDraft>) =>
    setBanks((list) => list.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Nhập tên công ty / đối tác';
    const cleaned = banks
      .map((b) => ({ bank_name: b.bank_name.trim(), account_number: b.account_number.trim() }))
      .filter((b) => b.bank_name || b.account_number);
    if (!cleaned.length) errs.banks = 'Nhập ít nhất 1 tài khoản ngân hàng';
    else if (cleaned.some((b) => !b.bank_name || !b.account_number)) errs.banks = 'Nhập đủ cả ngân hàng và số tài khoản';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    const body: Record<string, unknown> = {
      name: name.trim(),
      banks: cleaned,
    };
    try {
      if (editing) await update.mutateAsync(body);
      else await create.mutateAsync(body);
      message.success(editing ? 'Đã lưu đối tác' : 'Đã tạo đối tác');
      onSaved();
    } catch (e) {
      if (e instanceof ApiRequestError && e.problem.errors) setErrors(e.problem.errors);
      message.error((e as { problem?: { title?: string } }).problem?.title ?? 'Không lưu được đối tác');
    }
  };

  return (
    <FgModal
      open
      title={editing ? `Sửa đối tác — ${editing.name}` : 'Tạo đối tác / khách hàng'}
      onCancel={onClose}
      width={620}
      footer={
        <>
          <FgButton onClick={onClose} disabled={busy}>
            Hủy
          </FgButton>
          <FgButton variant="primary" loading={busy} onClick={() => void submit()}>
            {editing ? 'Lưu thay đổi' : 'Tạo đối tác'}
          </FgButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--fg-space-4)' }}>
        <FgField label="Tên công ty / đối tác *" error={errors.name}>
          <FgInput value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Công ty TNHH ABC" />
        </FgField>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-2)' }}>
          <FgText style="bodyS" strong>
            Tài khoản ngân hàng
          </FgText>
          {banks.map((b, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 'var(--fg-space-2)', alignItems: 'end' }}>
              <FgField label="Ngân hàng">
                <FgInput value={b.bank_name} onChange={(e) => setBank(i, { bank_name: e.target.value })} placeholder="VD: Vietcombank" />
              </FgField>
              <FgField label="Số tài khoản">
                <FgInput value={b.account_number} onChange={(e) => setBank(i, { account_number: e.target.value })} placeholder="VD: 123456789" />
              </FgField>
              <FgButton
                variant="ghost"
                disabled={banks.length <= 1}
                onClick={() => setBanks((list) => list.filter((_x, idx) => idx !== i))}
                aria-label="Xoá tài khoản"
                style={{ marginBottom: 2 }}
              >
                ✕
              </FgButton>
            </div>
          ))}
          {errors.banks ? <FgAlert tone="danger" title={errors.banks} /> : null}
          <div>
            <FgButton onClick={() => setBanks((list) => [...list, { bank_name: '', account_number: '' }])}>+ Thêm tài khoản</FgButton>
          </div>
        </div>
      </div>
    </FgModal>
  );
}

function DeleteCounterpartyModal({
  cp,
  onClose,
  onDeleted,
}: {
  cp: CounterpartyRow;
  onClose: () => void;
  onDeleted: () => void;
}): ReactNode {
  const del = useDeleteCounterparty();
  const { message } = useToast();
  return (
    <FgModal
      open
      title="Xoá đối tác"
      onCancel={onClose}
      width={460}
      footer={
        <>
          <FgButton onClick={onClose} disabled={del.isPending}>
            Hủy
          </FgButton>
          <FgButton
            variant="danger"
            loading={del.isPending}
            onClick={() =>
              del.mutate(cp._id, {
                onSuccess: () => {
                  message.success('Đã xoá đối tác');
                  onDeleted();
                  onClose();
                },
              })
            }
          >
            Xoá
          </FgButton>
        </>
      }
    >
      <FgText style="body">
        Xoá <strong>{cp.name}</strong> khỏi danh bạ? Các phiếu thu/chi đã gắn sẽ giữ nguyên nội dung, chỉ mất liên kết định danh.
      </FgText>
    </FgModal>
  );
}
