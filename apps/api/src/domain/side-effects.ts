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
import { entriesForPayment, postCashEntries, recomputeAccountBalances, sourceAccountOf } from './ledger/index.ts';
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

/** Hoá đơn/hợp đồng không còn bắt buộc — chỉ là chứng từ khuyến khích, không chặn gửi/duyệt. */
const OPTIONAL_EVIDENCE = new Set<string>(['contract', 'invoice']);

function withoutOptional(types: string[] | null | undefined): string[] {
  return (types ?? []).filter((t) => !OPTIONAL_EVIDENCE.has(t));
}

export async function requiredEvidenceFor(doc: {
  kind: DocKind;
  category_id?: string | null;
  company_id: string;
}): Promise<string[]> {
  if (doc.category_id) {
    const cat = await Models.Category.findById(doc.category_id).select({ required_evidence: 1 }).lean();
    if (cat?.required_evidence?.length) return withoutOptional(cat.required_evidence);
  }
  const rule = await Models.Setting.findOne({ key: `evidence.required.${doc.kind}` }).lean<{ value?: { types?: string[] } } | null>();
  if (rule?.value?.types?.length) return withoutOptional(rule.value.types);
  // mặc định nghiệp vụ (BA-3 sẽ seed bản chính thức)
  switch (doc.kind) {
    case 'spend':
      return withoutOptional(['contract', 'invoice']);
    case 'income':
      return withoutOptional(['contract']);
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
 * Sổ cái dòng tiền — ghi actual khi thực thi (arch §8.3, ledger append-only)
 * ------------------------------------------------------------------ */

export async function syncBalancesForDocument(input: {
  doc: DomainDoc;
  from: StatusKey;
  to: StatusKey;
  execution?: { paid_at?: string | null; actual_amount_minor?: bigint | null } | null;
  /** tài khoản mới khi cấp duyệt đổi tài khoản đích/nguồn (null = giữ nguyên). */
  newAccountId?: string | null;
  /**
   * Phiếu chi từng phần: số tiền thực chi của KỲ NÀY — ghi thẳng vào sổ cái của tài
   * khoản nguồn/đích ngay cả khi trạng thái chưa đổi sang `paid` (phiếu còn mở).
   */
  actualDelta?: { amount: bigint; date: string } | null;
  /** chỉ số kỳ chi (0 = phiếu thường) — bảo đảm `dedupe_key` ổn định & idempotent. */
  installmentIndex?: number;
}): Promise<void> {
  try {
    const { doc, to } = input;
    void input.from; // giữ signature cũ; ledger chỉ quan tâm tiền đã thực sự dịch chuyển
    const oldAccountId = sourceAccountOf(doc);
    const newAccountId = input.newAccountId ? String(input.newAccountId) : oldAccountId;
    const accountId = newAccountId ?? oldAccountId;
    if (!accountId) return; // không gắn tài khoản → không có dòng tiền

    let amount: bigint | null = null;
    let date: string | null = null;
    if (input.actualDelta && input.actualDelta.amount > 0n) {
      amount = input.actualDelta.amount;
      date = input.actualDelta.date;
    } else if (input.execution && to === 'paid') {
      amount = input.execution.actual_amount_minor ?? doc.amount?.minor ?? 0n;
      date = String(input.execution.paid_at ?? doc.planned_date);
    }

    // Chuyển trạng thái KHÔNG kèm tiền thật (submit/duyệt/từ chối/đổi tài khoản) → ledger không đổi.
    if (!amount || !date || amount <= 0n) return;

    const entries = entriesForPayment({
      doc,
      accountId,
      amountMinor: amount,
      date,
      installmentIndex: input.installmentIndex ?? 0,
      currency: doc.amount?.currency,
    });
    await postCashEntries(entries);
    await recomputeAccountBalances(entries.map((e) => e.account_id));
    invalidateFor(String(doc.company_id));
  } catch (err) {
    console.warn('[ledger] sync thất bại (sẽ reconcile lại):', (err as Error).message);
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
    staff: 'Kế toán viên',
    chief_accountant: 'Kế toán trưởng',
    deputy_director: 'Phó Giám đốc',
    director: 'Giám đốc',
    deputy_chairman: 'Phó Tổng Giám đốc',
    chairman: 'Tổng Giám đốc (Chủ tịch)',
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
