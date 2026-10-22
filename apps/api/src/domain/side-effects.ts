/**
 * Side effects sau mutation — bước 3 & 8 của arch §7.3: **best-effort**, lỗi ở đây
 * không bao giờ được làm hỏng nghiệp vụ đã commit (CAS đã xong ở bước 6).
 *
 * - `rebuildEvidence` → required/present/missing (chặn "hồ sơ thiếu chứng từ" §XVIII)
 * - `syncBalancesForDocument` → balances_daily theo doc ngày (CAS, không transaction)
 * - `notifyNextApprover` → notifications (web) + email (K-13)
 */

import {
  GROUP_ONLY_ROLES,
  STATUS_REGISTRY,
  effectivePermissions,
  formatMoney,
  money,
  type DocKind,
  type Permission,
  type Role,
  type StatusKey,
} from '@fingate/shared';
import { Models } from '../db/models.ts';
import { entriesForPayment, postCashEntries, recomputeAccountBalances, sourceAccountOf } from './ledger/index.ts';
import { cacheInvalidate } from '../lib/cache.ts';
import { mailTemplates, sendMail } from '../mail/sender.ts';
import { BADGE_CACHE_PREFIX } from './queries/badge-cache.ts';
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

/**
 * Xoá cache số liệu sau mutation. Badge "Chờ tôi duyệt" đếm phiếu của NHIỀU người (cấp kế tiếp, người thực thi)
 * theo từng phạm vi công ty, nên xoá TOÀN BỘ badge — không chỉ của người thao tác. Đếm lại khi đọc chỉ là một lượt đếm theo phạm vi.
 */
export function invalidateFor(companyId?: string | null, userId?: string | null): void {
  cacheInvalidate('dashboard:');
  cacheInvalidate('overview:');
  cacheInvalidate('dash-extras:');
  if (companyId) cacheInvalidate(`balances:${companyId}`);
  cacheInvalidate(BADGE_CACHE_PREFIX);
  void userId; // giữ để tương thích với nơi gọi; người thao tác đã nằm trong nhóm badge bị xoá ở trên
}

/* ------------------------------------------------------------------ *
 * Notifications (web) + email (best-effort) cho cấp kế tiếp (v2 §7.2)
 * ------------------------------------------------------------------ */

/** Bước tối thiểu để tính người nhận: thứ tự, chức danh, người phụ trách, trạng thái. */
interface LevelStep {
  order: number;
  role: Role;
  user_id?: unknown;
  state: string;
}

/** Phân công đang hiệu lực — chỉ các trường cần để tính quyền thanh toán. */
interface ActiveAssignment {
  user_id: unknown;
  role: string;
  extra_permissions?: string[] | null;
  denied_permissions?: string[] | null;
}

/**
 * Phân công đang hiệu lực trong công ty (kể cả chức danh cấp Tập đoàn — có quyền với mọi công ty con,
 * cùng quy tắc với `assignUsers`). `role` lọc thêm theo chức danh.
 */
async function activeAssignmentsIn(companyId: string, role?: Role): Promise<ActiveAssignment[]> {
  const rows = await Models.Assignment.find({
    status: 'active',
    ...(role ? { role } : {}),
    $or: [{ company_id: companyId }, { role: { $in: [...GROUP_ONLY_ROLES] } }],
  } as never)
    .select({ user_id: 1, role: 1, extra_permissions: 1, denied_permissions: 1 })
    .lean();
  return rows as unknown as ActiveAssignment[];
}

/** Người có quyền thực thi thanh toán (`payment:mark`) trong công ty — tính cả quyền cấp thêm / thu hồi riêng (ADM-03). */
async function paymentUserIdsIn(companyId: string): Promise<string[]> {
  const rows = await activeAssignmentsIn(companyId);
  return rows
    .filter((a) => {
      const extra = (a.extra_permissions ?? []) as Permission[];
      const denied = (a.denied_permissions ?? []) as Permission[];
      return effectivePermissions(a.role as Role, extra, denied).includes('payment:mark');
    })
    .map((a) => String(a.user_id));
}

/**
 * Người nhận "cấp kế tiếp" theo trạng thái SAU khi ghi (v2 §7.2):
 *  - gửi / duyệt tới một cấp → người phụ trách bước đang xử lý (bước thấp nhất còn chờ), KHÔNG gửi cho các cấp phía trên;
 *  - từ chối / yêu cầu bổ sung → người lập (KTV) — người phải xử lý tiếp;
 *  - duyệt xong → người có quyền thực thi thanh toán trong công ty (phương án đảo hạn không thanh toán nên không gửi).
 * Người vừa thao tác không nhận lại thông báo về chính thao tác đó (từ chối / bổ sung / duyệt xong).
 * Đưa vào hàng thanh toán, thực thi, huỷ… không có cấp kế tiếp để báo.
 */
export async function nextLevelRecipients(input: {
  doc: DomainDoc;
  status: StatusKey;
  actorId: string | null;
}): Promise<string[]> {
  const { doc, status, actorId } = input;
  const companyId = String(doc.company_id);
  const exceptActor = (ids: string[]): string[] => [...new Set(ids)].filter((id) => id !== actorId);

  if (status === 'rejected' || status === 'changes_requested') return exceptActor([String(doc.created_by)]);
  if (status === 'approved') return doc.kind === 'rollover' ? [] : exceptActor(await paymentUserIdsIn(companyId));
  if (status.startsWith('pending.')) {
    const steps = (doc.approval?.steps ?? []) as unknown as LevelStep[];
    const next = steps.filter((s) => s.state === 'current' || s.state === 'waiting').sort((a, b) => a.order - b.order)[0];
    if (!next) return [];
    if (next.user_id) return [String(next.user_id)];
    // bước chưa gán người: ai đúng chức danh trong công ty đều xử lý được (xem `myStep` trong transition)
    return [...new Set((await activeAssignmentsIn(companyId, next.role)).map((a) => String(a.user_id)))];
  }
  return [];
}

/** Cụm "… bởi <người thao tác>" trong nội dung thông báo, và ghi chú email — cho các trạng thái không phải "đang chờ bạn duyệt". */
const STATUS_VERB: Partial<Record<StatusKey, string>> = {
  rejected: 'từ chối bởi',
  changes_requested: 'yêu cầu bổ sung bởi',
  approved: 'duyệt xong bởi',
};
const STATUS_NOTE: Partial<Record<StatusKey, string>> = {
  rejected: 'Phiếu đã bị từ chối. Mở hồ sơ để xem lý do và xử lý lại.',
  changes_requested: 'Phiếu được trả về để bổ sung. Mở hồ sơ để xem yêu cầu, bổ sung rồi gửi lại.',
  approved: 'Phiếu đã duyệt xong. Mở hồ sơ để thực hiện thanh toán.',
};

/** Tên người lập hồ sơ (hiển thị trong thông báo và email). */
async function creatorNameOf(doc: DomainDoc): Promise<string> {
  const u = await Models.User.findById(doc.created_by).select({ display_name: 1, email: 1 }).lean<{ display_name?: string; email?: string } | null>();
  return String(u?.display_name ?? u?.email ?? 'Người lập');
}

export async function notifyNextApprover(input: {
  /** hồ sơ SAU khi ghi (CAS): trạng thái và chuỗi bước đã cập nhật — không phải bản nạp trước khi ghi */
  doc: DomainDoc;
  /** người vừa thao tác: không nhận lại thông báo "từ chối / bổ sung / duyệt xong" về chính mình */
  actorId?: string | null;
  actorName: string;
  /** chức danh của bước đang chờ — chỉ dùng trong email khi hồ sơ đang chờ duyệt */
  stepRole?: Role | null;
  amountMinor: bigint;
  compact: string;
  status?: StatusKey;
  statusLabel?: string;
}): Promise<void> {
  try {
    const { doc } = input;
    // Badge "Chờ tôi duyệt" đổi ngay khi bước duyệt đổi. Xoá TRƯỚC nhánh không có người nhận bên dưới:
    // duyệt xong (không còn bước) phiếu chuyển sang hàng thực thi của kế toán — badge của họ cũng phải đổi.
    invalidateFor(String(doc.company_id));
    const status = input.status ?? doc.status;
    const recipientIds = await nextLevelRecipients({ doc, status, actorId: input.actorId ?? null });
    if (!recipientIds.length) return;

    const users = await Models.User.find({ _id: { $in: recipientIds }, status: 'active' }).select({ email: 1, display_name: 1, prefs: 1 }).lean();
    if (!users.length) return;
    const href = docHref(doc.kind, String(doc._id));
    const awaitingApproval = status.startsWith('pending.');
    const title =
      status === 'rejected'
        ? `${doc.code} bị từ chối`
        : status === 'changes_requested'
          ? `${doc.code} bị yêu cầu bổ sung`
          : status === 'approved'
            ? `${doc.code} đã duyệt xong — cần thực hiện thanh toán`
            : `${input.compact} đang chờ bạn duyệt`;
    const verb = STATUS_VERB[status];
    const body = [doc.code, input.amountMinor > 0n ? input.compact : null, verb ? `${verb} ${input.actorName}` : null]
      .filter(Boolean)
      .join(' · ');
    const [company, creator] = await Promise.all([companyName(String(doc.company_id)), creatorNameOf(doc)]);
    const statusLabel = input.statusLabel ?? STATUS_REGISTRY[status]?.labelVi ?? '';

    for (const u of users) {
      const name = String(u.display_name ?? u.email);
      await Models.Notification.create({
        user_id: u._id,
        company_id: doc.company_id,
        kind: 'approval',
        severity: 2,
        title,
        body,
        href,
        document_id: doc._id,
        channels_sent: [],
      });
      const emailWanted = ((u as { prefs?: { notify_channels?: string[] } }).prefs?.notify_channels ?? ['web']).includes('email');
      if (emailWanted) {
        void sendMail({
          to: String(u.email),
          subject: `${title} · ${doc.code}`,
          html: awaitingApproval
            ? mailTemplates.approvalRequest({
                name,
                roleLabel: input.stepRole ? roleLabel(input.stepRole) : 'bạn',
                code: doc.code,
                amount: input.compact,
                company,
                href,
                actorName: creator,
                statusLabel,
                urgent: false,
              })
            : mailTemplates.docStatus({
                name,
                headline: title,
                note: STATUS_NOTE[status] ?? '',
                code: doc.code,
                amount: input.compact,
                company,
                href,
                actorName: creator,
                statusLabel,
              }),
        });
      }
    }
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
