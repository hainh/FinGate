/**
 * ADM-14 — Sao lưu dữ liệu: job nền mỗi 30' giữ 30 ngày + tạo/tải bản sao lưu ngay.
 * Chỉ tài khoản quản trị hệ thống (`admin:backup`).
 */

import { type ReactNode } from 'react';
import { dateTimeLabel } from '@fingate/shared';
import { useBackups, useCreateBackup } from '../app/queries.ts';
import { openDownload } from '../app/api.ts';
import type { BackupFile } from '../app/types.ts';
import { FgButton, FgText } from '../components/primitives.tsx';
import { FgEmptyState, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, toastOk, useToast } from '../components/pagekit.tsx';
import { AdminNav } from './admin.tsx';

const sizeLabel = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function BackupScreen(): ReactNode {
  const query = useBackups();
  const create = useCreateBackup();
  const { message } = useToast();

  const runNow = async (): Promise<void> => {
    try {
      const created = await create.mutateAsync();
      toastOk('Đã tạo bản sao lưu — đang tải về…');
      openDownload(`/system/backups/${encodeURIComponent(created.file)}`);
    } catch (e) {
      message.error((e as { problem?: { title?: string } }).problem?.title ?? 'Không tạo được bản sao lưu');
    }
  };

  return (
    <>
      <AdminNav />
      <FgPageHeader
        title="Sao lưu dữ liệu"
        meta="Hệ thống tự sao lưu mỗi 30 phút · giữ bản trong 30 ngày · tải bất kỳ lúc nào"
        actions={
          <FgButton variant="primary" loading={create.isPending} onClick={() => void runNow()}>
            ⤓ Tạo &amp; tải bản sao lưu
          </FgButton>
        }
      />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={4} cols={4} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState
                glyph="⤓"
                title="Chưa có bản sao lưu nào"
                description="Bấm “Tạo & tải bản sao lưu” để tạo bản đầu tiên."
              />
            </div>
          ) : (
            <>
              <FgText style="caption" color="muted">
                {data.items.length} bản còn giữ · tối đa {data.retain_days} ngày
              </FgText>
              <div className="fg-card" style={{ padding: 0 }}>
                <FgTable<BackupFile>
                  rowKey="file"
                  dataSource={data.items}
                  columns={[
                    { title: 'Tệp', dataIndex: 'file', key: 'file' },
                    { title: 'Dung lượng', key: 'size', width: 140, render: (_v, r) => <span className="fg-num">{sizeLabel(r.size)}</span> },
                    { title: 'Tạo lúc', key: 'at', width: 200, render: (_v, r) => dateTimeLabel(r.created_at) },
                    {
                      title: '',
                      key: 'act',
                      width: 120,
                      render: (_v, r) => (
                        <FgButton size="small" onClick={() => openDownload(`/system/backups/${encodeURIComponent(r.file)}`)}>
                          Tải về
                        </FgButton>
                      ),
                    },
                  ]}
                />
              </div>
            </>
          )
        }
      </FgQuery>
    </>
  );
}
