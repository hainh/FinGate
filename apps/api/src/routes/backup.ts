/**
 * Sao lưu dữ liệu (ADM-14) — chỉ tài khoản quản trị hệ thống (`admin:backup`).
 *
 * Bản sao lưu do `mongodump` ghi ra thư mục NGOÀI app (`BACKUP_DIR`) — xem domain/backup.
 *
 * · GET  /system/backups          — danh sách bản còn giữ (≤ 30 ngày)
 * · POST /system/backups          — tạo bản sao lưu ngay
 * · GET  /system/backups/:file    — tải 1 bản (đọc trực tiếp từ BACKUP_DIR)
 */

import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApiError, type Permission } from '@fingate/shared';
import { defineRoute, requireActor, requestCtx } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { BACKUP_FILE_RE, BACKUP_RETAIN_MS, backupPath, createBackup, listBackups } from '../domain/backup/index.ts';
import { mirrorAudit } from '../domain/audit/index.ts';

/** Trả file sao lưu dạng đính kèm — đọc trực tiếp bytes từ `BACKUP_DIR`. */
async function sendBackup(reply: FastifyReply, file: string): Promise<FastifyReply> {
  const bytes = await readFile(backupPath(file)).catch(() => null);
  if (!bytes) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy bản sao lưu' });
  return reply
    .header('cache-control', 'private, no-store')
    .header('content-disposition', `attachment; filename="${file}"`)
    .type('application/gzip')
    .send(bytes);
}

export function backupRoutes(app: FastifyInstance): void {
  app.route(
    defineRoute({
      method: 'GET',
      url: '/system/backups',
      config: { perms: ['admin:backup'] as Permission[], screen: 'ADM-14', summary: 'Danh sách bản sao lưu (giữ 30 ngày)' },
      handler: async (_req, reply) =>
        ok(reply, { data: { items: await listBackups(), retain_days: BACKUP_RETAIN_MS / 86_400_000 } }),
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/system/backups',
      config: { perms: ['admin:backup'] as Permission[], screen: 'ADM-14', summary: 'Tạo bản sao lưu ngay' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const created = await createBackup();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'db.backup',
          subject: { type: 'database', id: null, code: created.file },
          company_id: null,
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: created }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/system/backups/:file',
      config: { perms: ['admin:backup'] as Permission[], screen: 'ADM-14', summary: 'Tải một bản sao lưu' },
      handler: async (req, reply) => {
        const { file } = req.params as { file: string };
        if (!BACKUP_FILE_RE.test(file)) throw new ApiError({ code: 'FG-VAL-001', detail: 'Tên bản sao lưu không hợp lệ' });
        return sendBackup(reply, file);
      },
    }),
  );
}
