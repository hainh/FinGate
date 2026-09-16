/**
 * Side effects sau mutation — bước 3 & 8 của arch §7.3: **best-effort**, lỗi ở đây
 * không bao giờ được làm hỏng nghiệp vụ đã commit (CAS đã xong ở bước 6).
 *
 * - `rebuildEvidence` → required/present/missing (chặn "hồ sơ thiếu chứng từ" §XVIII)
 * - `syncBalancesForDocument` → balances_daily theo doc ngày (CAS, không transaction)
 * - `notifyNextApprover` → notifications (web) + email (K-13)
 */

import { STATUS_REGISTRY, formatMoney, money, type DocKind, type Role, type StatusKey } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { bumpBalance } from '../db/cas.ts';
import { cacheInvalidate } from '../lib/cache.ts';
import { mailTemplates, sendMail } from '../mail/sender.ts';
import type { DomainDoc } from './types.ts';

/* ------------------------------------------------------------------ *
 * Evidence — chứng từ bắt buộc theo LOẠI PHIẾU/DANH MỤC, cấu hình được (§XXX.2, Q-04)
 * ------------------------------------------------------------------ */

export interface EvidenceState {
  required: string[];
  present: string[];
  missing: string[];
}

export async function requiredEvidenceFor(doc: {
  kind: DocKind;
  category_id?: string | null;
  company_id: string;
}): Promise<string[]> {
  if (doc.category_id) {
    const cat = await Models.Category.findById(doc.category_id).select({ required_evidence: 1 }).lean();
    if (cat?.required_evidence?.length) return cat.required_evidence;
  }
  const rule = await Models.Setting.findOne({ key: `evidence.required.${doc.kind}` }).lean<{ value?: { types?: string[] } } | null>();
  if (rule?.value?.types?.length) return rule.value.types;
  // mặc định nghiệp vụ (BA-3 sẽ seed bản chính thức)
  switch (doc.kind) {
    case 'spend':
      return ['contract', 'invoice'];
    case 'income':
      return ['contract'];
    case 'rollover':
      return ['loan_schedule'];
    case 'internal':
      return ['bank_order'];
    default:
      return [];
  }
}

export async function rebuildEvidence(doc: DomainDoc): Promise<EvidenceState> {
  const required = await requiredEvidenceFor({
    kind: doc.kind,
    category_id: doc.category_id ? String(doc.category_id) : null,
    company_id: String(doc.company_id),
  });
  const present = [...new Set((doc.attachments ?? []).map((a) => String(a.type)))];
  return { required, present, missing: required.filter((t) => !present.includes(t)) };
}

/* ------------------------------------------------------------------ *
 * balances_daily — "tính khi đọc" + ghi dự toán khi submit/track (arch §8.3)
 * ------------------------------------------------------------------ */

export async function syncBalancesForDocument(input: {
  doc: DomainDoc;
  from: StatusKey;
  to: StatusKey;
  execution?: { paid_at?: string | null; actual_amount_minor?: bigint | null } | null;
}): Promise<void> {
  try {
    const { doc, from, to } = input;
    const accountId = doc.source?.account_id ? String(doc.source.account_id) : null;
    if (!accountId) return; // quỹ tiền mặt → không có dòng ngân hàng

    const amount = doc.amount?.minor ?? 0n;
    const counted = (s: StatusKey) => !['draft', 'rejected', 'cancelled', 'changes_requested'].includes(s);
    const was = counted(from);
    const is = counted(to);
    if (was === is && !input.execution) return;

    const date = to === 'paid' ? (input.execution?.paid_at ?? doc.planned_date) : doc.planned_date;
    const isIn = doc.kind === 'income';

    let plannedDelta: { in: bigint; out: bigint } = { in: 0n, out: 0n };
    if (!was && is) plannedDelta = isIn ? { in: amount, out: 0n } : { in: 0n, out: amount };
    else if (was && !is) plannedDelta = isIn ? { in: -amount, out: 0n } : { in: 0n, out: -amount };

    const actual = to === 'paid' ? (input.execution?.actual_amount_minor ?? amount) : 0n;
    const account = await Models.BankAccount.findById(accountId).select({ min_balance_minor: 1 }).lean();

    await bumpBalance({
      company_id: String(doc.company_id),
      account_id: accountId,
      date,
      min_balance_minor: account?.min_balance_minor,
      plannedIn: plannedDelta.in || undefined,
      plannedOut: plannedDelta.out || undefined,
      actualIn: isIn && to === 'paid' ? actual : undefined,
      actualOut: !isIn && to === 'paid' ? actual : undefined,
    });

    // chuyển tiền nội bộ: ghi đối ứng cho công ty B, KHÔNG tính doanh thu/chi phí (§XXI)
    if (doc.kind === 'internal' && to === 'paid' && doc.target?.company_id && doc.target?.account_id) {
      await bumpBalance({
        company_id: String(doc.target.company_id),
        account_id: String(doc.target.account_id),
        date: input.execution?.paid_at ?? doc.planned_date,
        actualIn: actual,
      });
    }
    invalidateFor(String(doc.company_id));
  } catch (err) {
    console.warn('[balances] sync thất bại (sẽ reconcile lại):', (err as Error).message);
    await Models.Job.updateOne(
      { name: 'reconcile', dedupe_key: `reconcile:balance:${input.doc._id}` },
      { $setOnInsert: { name: 'reconcile', state: 'queued', run_at: new Date(), dedupe_key: `reconcile:balance:${input.doc._id}`, payload: { document_id: String(input.doc._id) } } },
      { upsert: true },
    ).exec();
  }
}

export function invalidateFor(companyId?: string | null, userId?: string | null): void {
  cacheInvalidate('dashboard:');
  cacheInvalidate('overview:');
  if (companyId) cacheInvalidate(`balances:${companyId}`);
  if (userId) cacheInvalidate(`badge:${userId}`);
}

/* ------------------------------------------------------------------ *
 * Notifications (web) + email (best-effort) cho cấp kế tiếp
 * ------------------------------------------------------------------ */

export async function notifyNextApprover(input: {
  doc: DomainDoc;
  actorName: string;
  stepRole: Role | null;
  amountMinor: bigint;
  compact: string;
  status?: StatusKey;
  statusLabel?: string;
}): Promise<void> {
  try {
    const { doc } = input;
    const steps = (doc.approval?.steps ?? []) as { order: number; role: Role; user_id: string | null; state: string }[];
    const recipients = [...new Set(steps.filter((s) => (s.state === 'current' || s.state === 'waiting') && s.user_id).map((s) => s.user_id as string))];
    if (!recipients.length) return;

    const users = await Models.User.find({ _id: { $in: recipients }, status: 'active' }).select({ email: 1, display_name: 1, prefs: 1 }).lean();
    const href = docHref(doc.kind, String(doc._id));
    const kind = 'approval';
    const title =
      input.status === 'rejected'
        ? `${doc.code} bị từ chối`
        : input.status === 'approved'
          ? `${doc.code} đã duyệt xong — cần thực hiện thanh toán`
          : `${input.compact} đang chờ bạn duyệt`;

    for (const u of users) {
      await Models.Notification.create({
        user_id: u._id,
        company_id: doc.company_id,
        kind,
        severity: 2,
        title,
        body: `${doc.code} · ${input.amountMinor > 0n ? input.compact : ''} · người lập ${input.actorName}`,
        href,
        document_id: doc._id,
        channels_sent: [],
      });
      const emailWanted = ((u as { prefs?: { notify_channels?: string[] } }).prefs?.notify_channels ?? ['web']).includes('email');
      if (emailWanted) {
        void sendMail({
          to: String(u.email),
          subject: `${title} · ${doc.code}`,
          html: mailTemplates.approvalRequest({
            name: String(u.display_name ?? u.email),
            roleLabel: input.stepRole ? roleLabel(input.stepRole) : 'bạn',
            code: doc.code,
            amount: input.compact,
            company: await companyName(String(doc.company_id)),
            href,
            actorName: input.actorName,
            statusLabel: input.statusLabel ?? STATUS_REGISTRY[input.status ?? 'draft']?.labelVi ?? '',
            urgent: false,
          }),
        });
      }
    }
    invalidateFor(String(doc.company_id));
  } catch (err) {
    console.warn('[notify] thất bại (bỏ qua — web vẫn còn qua poll 30s):', (err as Error).message);
  }
}

const KIND_SEGMENT: Record<DocKind, string> = { spend: 'chi', income: 'thu', rollover: 'dao-han', internal: 'noi-bo' };

export function docHref(kind: DocKind, id: string): string {
  return `/ho-so/${KIND_SEGMENT[kind]}/${id}`;
}

function roleLabel(role: Role): string {
  const map: Record<Role, string> = {
    staff: 'Nhân viên kế toán',
    accountant: 'Chuyên viên kế toán',
    chief_accountant: 'Kế toán trưởng',
    deputy_director: 'Phó Giám đốc',
    director: 'Giám đốc',
    chairman: 'Chủ tịch HĐQT',
    admin: 'Quản trị hệ thống',
  };
  return map[role] ?? role;
}

const nameCache = new Map<string, string>();
export async function companyName(companyId: string): Promise<string> {
  const hit = nameCache.get(companyId);
  if (hit) return hit;
  const c = await Models.Company.findById(companyId).select({ name: 1 }).lean();
  const name = String(c?.name ?? 'Công ty');
  nameCache.set(companyId, name);
  return name;
}

export const moneyCompact = (minor: bigint, currency = 'VND') =>
  formatMoney(money(minor, currency), { mode: 'compact' });
