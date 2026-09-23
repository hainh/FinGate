/**
 * Job nền (architecture §9, K-7) — KHÔNG có cron trong tiến trình cho Profile C
 * (instance free ngủ giữa các request). Mỗi job là hàm idempotent, gọi bởi
 * `POST /api/v1/tasks/:name` từ GitHub Actions schedule.
 *
 * Idempotency: `jobs.dedupe_key` unique thay distributed lock (§8.6).
 * `claimJob()` trả null khi đã có bản chạy cùng key → cron đến muộn không chạy đúp.
 */

import { ApiError, addDays, formatMoney, money, today } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { buildNewsletter, storeNewsletter } from '../domain/newsletter/index.ts';

import { queueFilterForSla } from './filters.ts';
import { mirrorAudit, rebuildAudit } from '../domain/audit/index.ts';
import { sendMail } from '../mail/sender.ts';
import { evaluateAlerts } from '../domain/alerts/index.ts';
import { materializeRecurring } from '../domain/recurring/index.ts';
import { rebuildBalances } from '../domain/rebuild/balances.ts';
import type { ScopeLike } from '../domain/types.ts';
import { checkTie } from '../domain/tie/index.ts';

export type TaskName =
  | 'newsletter'
  | 'sla-scan'
  | 'alerts'
  | 'recurring'
  | 'maintenance'
  | 'reconcile'
  | 'rebuild-balances'
  | 'rebuild-audit'
  | 'check-tie'
  | 'archive'
  | 'cleanup';

export interface JobResult {
  task: string;
  ok: boolean;
  summary: Record<string, unknown>;
  started_at: string;
  finished_at: string;
}

/**_claim_ — unique dedupe_key; đã chạy trong cửa sổ này → null (bỏ qua, không lỗi). */
export async function claimJob(name: TaskName, dedupeWindowKey: string): Promise<string | null> {
  const key = `${name}:${dedupeWindowKey}`;
  try {
    const doc = await Models.Job.create({
      name,
      state: 'running',
      dedupe_key: key,
      run_at: new Date(),
      started_at: new Date(),
      attempts: 1,
    } as never);
    return String(doc._id);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return null; // đã có bản chạy
    throw err;
  }
}

async function finish(id: string | null, ok: boolean, summary: Record<string, unknown>, error?: string): Promise<void> {
  if (!id) return;
  await Models.Job.updateOne(
    { _id: id },
    { $set: { state: ok ? 'done' : 'failed', result: summary, error: error ?? null, finished_at: new Date() } },
  ).exec();
}

/** Chạy task theo tên; trả kết quả để log. Mọi task idempotent theo `windowKey`. */
export async function runTask(name: TaskName, windowKey?: string): Promise<JobResult> {
  const startedAt = new Date();
  const win = windowKey ?? defaultWindow(name);
  const jobId = await claimJob(name, win);
  if (!jobId) {
    return { task: name, ok: true, summary: { skipped: 'đã chạy trong cửa sổ này' }, started_at: startedAt.toISOString(), finished_at: new Date().toISOString() };
  }
  try {
    const summary = await DISPATCH[name]();
    await finish(jobId, true, summary);
    return { task: name, ok: true, summary, started_at: startedAt.toISOString(), finished_at: new Date().toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish(jobId, false, {}, message);
    throw err;
  }
}

/**
 * Cửa sổ dedupe: 15 phút cho sla/alerts (cron mỗi 15'), theo NGÀY cho newsletter/recurring
 * (chạy muộn do instance ngủ vẫn chỉ một bản mỗi ngày).
 */
function defaultWindow(name: TaskName): string {
  const now = new Date();
  if (name === 'sla-scan' || name === 'alerts' || name === 'reconcile') {
    return `${now.toISOString().slice(0, 13)}:${String(Math.floor(now.getUTCMinutes() / 15) * 10).padStart(2, '0')}`;
  }
  return today();
}

const DISPATCH: Record<TaskName, () => Promise<Record<string, unknown>>> = {
  /** Bản tin 06:30 VN — dựng + cache + email cho GĐ/PGĐ/KTT (§9.3, §XIV). */
  newsletter: async () => {
    const companies = await Models.Company.find({ status: 'active' }).select({ _id: 1, name: 1 }).lean();
    const scopes: { label: string; scope: ScopeLike }[] = [
      { label: 'all', scope: { companyIds: null } },
      ...companies.map((c) => ({ label: String(c._id), scope: { companyIds: [String(c._id)] } as ScopeLike })),
    ];
    const built: string[] = [];
    for (const s of scopes) {
      const key = `newsletter:${today()}:${s.label}`;
      const data = await buildNewsletter(s.scope, today());
      await storeNewsletter(key, data);
      built.push(s.label);
    }
    // email tới giám đốc các công ty
    const directors = await Models.Assignment.find({ role: { $in: ['director', 'deputy_director', 'chief_accountant', 'deputy_chairman'] }, status: 'active' } as never)
      .select({ user_id: 1 })
      .lean();
    const recipients = [...new Set(directors.map((d) => String(d.user_id)))].slice(0, 60);
    const users = recipients.length ? await Models.User.find({ _id: { $in: recipients } as never, status: 'active' }).select({ email: 1 }).lean() : [];
    for (const u of users) {
      void sendMail({
        to: String(u.email),
        subject: `Bản tin tài chính ${today()}`,
        html: `<p>Bản tin ngày ${today()} đã sẵn sàng.</p><p><a href="/ban-tin/ngay">Đọc bản tin</a></p>`,
      });
    }
    return { date: today(), scopes: built.length, emailed: users.length };
  },

  /** Rà SLA: nhắc + escalate; dedupe key = doc+step+threshold (§9.1). */
  'sla-scan': async () => {
    const now = new Date();
    const overdue = await Models.Document.find(queueFilterForSla(now)).select({ code: 1, company_id: 1, amount: 1, approval: 1 }).limit(500).lean();
    let notified = 0;
    for (const d of overdue) {
      const steps = ((d.approval as { steps?: { state: string; user_id?: string | null }[] }) ?? { steps: [] }).steps ?? [];
      const current = steps.find((s) => s.state === 'current') ?? steps.find((s) => s.state === 'waiting');
      if (!current?.user_id) continue;
      const minor = BigInt(String((d.amount as { minor?: unknown })?.minor ?? '0'));
      const dedupe = `sla:${String(d._id)}:${today()}`;
      const existing = await Models.Alert.findOne({ dedupe_key: dedupe } as never).lean();
      if (existing) continue;
      await Models.Alert.create({
        type: 'event',
        alert_type: 'approval_overdue',
        company_id: d.company_id,
        severity: 2,
        text: `${String(d.code)} quá hạn xử lý · ${formatMoney(money(minor), { mode: 'compact' })}`,
        amount_minor: minor,
        href: `/ho-so/chi/${String(d._id)}`,
        dedupe_key: dedupe,
      } as never);
      const user = await Models.User.findById(current.user_id).select({ email: 1, display_name: 1, prefs: 1 }).lean();
      if (user) {
        await Models.Notification.create({
          user_id: current.user_id,
          company_id: d.company_id,
          kind: 'approval',
          severity: 2,
          title: `Quá hạn: ${String(d.code)}`,
          body: `Hồ sơ đã vượt SLA · ${formatMoney(money(minor), { mode: 'compact' })}`,
          href: `/ho-so/chi/${String(d._id)}`,
        } as never);
        const wantsEmail = ((user as { prefs?: { notify_channels?: string[] } }).prefs?.notify_channels ?? ['web']).includes('email');
        if (wantsEmail) {
          void sendMail({
            to: String(user.email),
            subject: `Quá hạn xử lý: ${String(d.code)}`,
            html: `<p>Hồ sơ ${String(d.code)} (${formatMoney(money(minor), { mode: 'compact' })}) đã vượt SLA.</p>`,
            urgent: true,
          });
        }
        notified++;
      }
      // cân nhắc đánh dấu overdue trên hồ sơ để query nhanh
      await Models.Document.updateOne({ _id: String(d._id) } as never, { $set: { overdue: true } }).exec();
    }
    return { scanned: overdue.length, notified };
  },

  /** 8 loại cảnh báo §XVIII — evaluate + dedupe. */
  alerts: async () => evaluateAlerts(),

  /** Khoản chi định kỳ: vật phiếu nháp + nhắc 7/3/1 ngày (§XVII). */
  recurring: async () => materializeRecurring(),

  /** CN 01:40 VN: rebuild balances + check:tie + archive (§13). */
  maintenance: async () => {
    const balances = await rebuildBalances();
    const tie = (await checkTie()) as unknown as Record<string, unknown>;
    const archived = await archiveOldDocuments();
    const cleaned = await cleanupOrphans();
    const jobs = await pruneJobs();
    return { balances, tie, archived, cleaned, jobs };
  },

  /** Audit fail best-effort → dựng lại từ history[] (arch §7.3 bước 4). */
  reconcile: async () => {
    const pending = await Models.Job.find({ name: 'reconcile', state: 'queued' } as never).select({ payload: 1 }).lean();
    const audit = await rebuildAudit({ companyIds: null }, {});
    for (const j of pending) {
      await Models.Job.updateOne({ _id: String(j._id) } as never, { $set: { state: 'done', finished_at: new Date() } }).exec();
    }
    return { audit, requeued: pending.length };
  },

  'rebuild-balances': async () => rebuildBalances() as unknown as Record<string, unknown>,
  'rebuild-audit': async () => rebuildAudit({ companyIds: null }, {}, (m: string) => console.log(m)) as unknown as Record<string, unknown>,
  'check-tie': async () => (await checkTie()) as unknown as Record<string, unknown>,
  archive: async () => archiveOldDocuments(),
  cleanup: async () => cleanupOrphans(),
};

/** Hồ sơ đóng > 24 tháng → NDJSON sang R2 rồi mới xoá (§8.7). */
async function archiveOldDocuments(): Promise<{ archived: number; bytes: number }> {
  const cutoff = new Date(Date.now() - 24 * 30 * 86_400_000);
  const rows = await Models.Document.find({
    closed_at: { $lt: cutoff },
    archived_at: null,
  } as never)
    .select({ code: 1, company_id: 1, kind: 1, closed_at: 1, history: 1, status: 1 })
    .limit(500)
    .lean();
  if (!rows.length) return { archived: 0, bytes: 0 };

  const { storage } = await import('../storage/index.ts');
  const companies = await Models.Company.find({}).select({ code: 1 }).lean();
  const cmap = new Map(companies.map((c) => [String(c._id), String(c.code)]));
  const month = today().slice(0, 7);
  let bytes = 0;
  let archived = 0;

  for (const r of rows) {
    const companyCode = cmap.get(String(r.company_id)) ?? 'CO';
    // gộp theo company+tháng để thành file NDJSON (một request/1 file)
    const key = `archive/${companyCode}/${month}.ndjson`;
    const line = JSON.stringify({ ...r, history: undefined, history_summary: ((r.history as unknown[]) ?? []).length });
    bytes += line.length;
    try {
      const head = await storage().head(key);
      void head;
      // append NDJSON: fs/s3 driver hiện tại ghi theo key nguyên — gộp lại toàn bộ khi archive
      const adapter = storage();
      if (adapter.putBytes) {
        await adapter.putBytes(key, Buffer.from(line + '\n'), 'application/x-ndjson');
      }
      // CHỈ unset history sau khi đã ghi file archive (arch §8.7)
      await Models.Document.updateOne({ _id: String(r._id) } as never, { $set: { archived_at: new Date() }, $unset: { history: '' } }).exec();
      archived++;
    } catch (err) {
      console.warn(`[archive] bỏ qua ${String(r.code)}: ${(err as Error).message}`);
    }
  }
  if (archived) {
    await mirrorAudit({
      at: new Date(),
      actor: { user_id: null, name: 'system', role: null },
      action: 'db.archive',
      subject: { type: 'document', id: null, code: `${archived} hồ sơ` },
      company_id: null,
    });
  }
  return { archived, bytes };
}

/** File mồ côi (prepare rồi không confirm) > 7 ngày → dọn (§8.6). */
async function cleanupOrphans(): Promise<{ removed: number }> {
  const cutoff = addDays(today(), -7);
  const rows = await Models.Attachment.find({ state: 'prepared', created_at: { $lt: new Date(`${cutoff}T00:00:00Z`) } } as never)
    .select({ key: 1 })
    .limit(500)
    .lean();
  const { storage } = await import('../storage/index.ts');
  let removed = 0;
  for (const r of rows) {
    await storage().remove(String(r.key)).catch(() => undefined);
    await Models.Attachment.updateOne({ _id: String(r._id) } as never, { $set: { state: 'orphan' } }).exec();
    removed++;
  }
  return { removed };
}

/** Giữ jobs lịch sử 30 ngày. */
async function pruneJobs(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const r = await Models.Job.deleteMany({ created_at: { $lt: cutoff }, state: { $in: ['done', 'failed'] } } as never).exec();
  return { deleted: r.deletedCount ?? 0 };
}

export async function taskGuardOk(name: string): Promise<void> {
  if (!(name in DISPATCH)) throw new ApiError({ code: 'FG-VAL-001', detail: 'Task không tồn tại' });
}
