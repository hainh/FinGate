/**
 * Hệ thống: `/healthz` (K-10) · `POST /api/v1/tasks/:name` (K-7, GitHub Actions schedule)
 * · danh mục route cho OpenAPI.
 */

import type { FastifyInstance } from 'fastify';
import { ApiError } from '@fingate/shared';
import { defineRoute, requestCtx } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { getEnv } from '../env.ts';
import { runTask, type TaskName } from '../jobs/index.ts';
import { dbUp } from '../db/index.ts';
import { TASK_NAMES } from '@fingate/shared';
import { tieLocked } from '../domain/tie-lock.ts';
import { cacheStats } from '../lib/cache.ts';

/** so sánh constant-time — chặn timing attack lên TASK_TOKEN (§11). */
function tokenOk(header: string | undefined): boolean {
  const expected = getEnv().TASK_TOKEN;
  if (!header || !expected) return false;
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function systemRoutes(app: FastifyInstance): void {
  app.get('/healthz', async (_req, reply) => {
    const env = getEnv();
    const mem = process.memoryUsage().rss / 1024 / 1024;
    const up = dbUp();
    return reply.code(up ? 200 : 503).header('cache-control', 'no-store').send({
      status: up ? 'ok' : 'degraded',
      version: env.VERSION,
      uptime_s: Math.round(process.uptime()),
      db: up ? 'up' : 'down',
      memory_mb: Math.round(mem),
      profile: env.PROFILE,
    });
  });

  /**
   * Job nền từ GitHub Actions. Trả 202 ngay rồi chạy tiếp trong background
   * (proxy free timeout 30s — arch §12.3), idempotent theo dedupe_key.
   */
  app.post('/api/v1/tasks/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!tokenOk(req.headers['x-task-token'] as string | undefined)) {
      throw new ApiError({ code: 'FG-TASK-001' });
    }
    if (!(TASK_NAMES as readonly string[]).includes(name)) {
      throw new ApiError({ code: 'FG-VAL-001', detail: 'Task không tồn tại' });
    }
    const task = name as TaskName;
    void runTask(task)
      .then((r) => console.log(`[task:${name}] ok`, JSON.stringify(r.summary)))
      .catch((err: unknown) => console.error(`[task:${name}] lỗi:`, (err as Error).message));
    return reply.code(202).send({ data: { accepted: true, task: name } });
  });

  /** Trạng thái đối chiếu tiền — FE hiện banner khoá export khi lệch (§8.5). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/system/tie',
      config: { perms: [], screen: 'ERR-06', summary: 'Trạng thái đối chiếu tiền' },
      handler: async (_req, reply) => ok(reply, { data: await tieLocked(), cache: cacheStats() }, { maxAge: 15 }),
    }),
  );

  /** heartbeat để giữ UI trung thực khi instance free ngủ (§5 cold-start UX). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/system/ping',
      config: { perms: [], screen: 'ERR-04', summary: 'Ping giữ phiên sống' },
      handler: async (req) => ({ data: { alive: true, trace_id: requestCtx(req).traceId } }),
    }),
  );
}
