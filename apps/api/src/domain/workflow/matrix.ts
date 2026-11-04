/**
 * Approval Matrix resolver (architecture §9.1) — "ma trận duyệt là DỮ LIỆU",
 * resolve lúc `submit` và SNAPSHOT vào hồ sơ → đổi cấu hình ADM-04 không làm lệch
 * hồ sơ đang đi dở (§19.5-7).
 *
 * `KT` trong blueprint §XX = bước đầu luôn có ở mọi quy trình (Nhân viên kế toán lập →
 * Kế toán trưởng kiểm tra); matrix định nghĩa từ cấp duyệt trở lên.
 */

import {
  APPROVAL_ORDER,
  DEFAULT_CHAIRMAN_THRESHOLD_MINOR,
  ROLE_LABEL,
  type DocKind,
  type Role,
} from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { ApiError } from '@fingate/shared';
import { cashRequiresKttFor, isCashVoucher } from './cash-approval.ts';

export interface MatrixStep {
  order: number;
  role: Role;
  sla_hours: number;
  mandatory: boolean;
}

export interface ResolvedMatrix {
  matrix_id: string | null;
  matrix_version: number;
  label: string;
  steps: MatrixStep[];
  /**
   * `true` = chuỗi đã bị cài đặt "Duyệt tiền mặt" sửa cho phiếu QUỸ TIỀN MẶT của công ty chưa
   * tick: bỏ bước Kế toán trưởng. `false`/không có = chuỗi theo ma trận (phiếu ngân hàng, hoặc
   * công ty đang bật "qua KTT duyệt").
   */
  cash_overridden?: boolean;
}

interface MatrixRow {
  _id: string;
  company_id: string | null;
  doc_kind: string;
  category_id: string | null;
  amount_min_minor: bigint;
  amount_max_minor: bigint | null;
  steps: { order: number; role: string; sla_hours?: number; mandatory?: boolean }[];
  version: number;
  label?: string | null;
  effective_from: Date;
}

function big(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

/** Bước mặc định: SLA KTT/PGĐ 24h, GĐ/P.TGĐ 48h (blueprint §XX). */
const defaultStep = (order: number, role: Role, sla_hours: number): MatrixStep => ({ order, role, sla_hours, mandatory: true });

/** Mốc khoảng tiền của chuỗi mặc định phiếu chi (v2 §7.2; đơn vị minor = VND): 50 triệu và 5 tỷ. */
const SPEND_MEDIUM_FROM_MINOR = 50_000_000n;
const SPEND_LARGE_ABOVE_MINOR = 5_000_000_000n;

/**
 * Chuỗi mặc định của PHIẾU CHI theo khoảng tiền (v2 §7.2, bảng "Ví dụ mặc định"):
 * < 50 triệu → KTT → PGĐ · 50 triệu – 5 tỷ → KTT → PGĐ → GĐ · > 5 tỷ → KTT → PGĐ → GĐ → P.TGĐ.
 * Chủ tịch KHÔNG nằm trong chuỗi mặc định: `withChairman` thêm khi vượt ngưỡng Chủ tịch.
 * Cấp khuyết chức danh do `assignUsers` + `dropVacantSteps` xử lý (bỏ cấp đó khỏi chuỗi).
 */
export function defaultSpendSteps(amountMinor: bigint): { label: string; steps: MatrixStep[] } {
  if (amountMinor < SPEND_MEDIUM_FROM_MINOR) {
    return {
      label: 'Mặc định: dưới 50 triệu — KTT → PGĐ',
      steps: [defaultStep(1, 'chief_accountant', 24), defaultStep(2, 'deputy_director', 24)],
    };
  }
  if (amountMinor <= SPEND_LARGE_ABOVE_MINOR) {
    return {
      label: 'Mặc định: 50 triệu – 5 tỷ — KTT → PGĐ → GĐ',
      steps: [defaultStep(1, 'chief_accountant', 24), defaultStep(2, 'deputy_director', 24), defaultStep(3, 'director', 48)],
    };
  }
  return {
    label: 'Mặc định: trên 5 tỷ — KTT → PGĐ → GĐ → P.TGĐ',
    steps: [
      defaultStep(1, 'chief_accountant', 24),
      defaultStep(2, 'deputy_director', 24),
      defaultStep(3, 'director', 48),
      defaultStep(4, 'deputy_chairman', 48),
    ],
  };
}

/**
 * Quy trình mặc định cố định của các loại còn lại (blueprint §XX). Phiếu chi xem `defaultSpendSteps`.
 * Phiếu thu (`income`) CÓ bước PGĐ giống phiếu chi — không phụ thuộc số tiền; khác phiếu chi ở chỗ
 * không có khoảng tiền riêng và GĐ luôn nằm trong chuỗi.
 */
const DEFAULT_STEPS: Record<Exclude<DocKind, 'spend'>, { label: string; steps: MatrixStep[] }> = {
  // Phiếu thu đi qua PGĐ giống phiếu chi (không phụ thuộc số tiền): KTT → PGĐ → GĐ → P.TGĐ.
  income: {
    label: 'Mặc định: KTT → PGĐ → GĐ → P.TGĐ',
    steps: [
      defaultStep(1, 'chief_accountant', 24),
      defaultStep(2, 'deputy_director', 24),
      defaultStep(3, 'director', 48),
      defaultStep(4, 'deputy_chairman', 48),
    ],
  },
  rollover: {
    label: 'Đảo hạn: KTT → PGĐ → GĐ → P.TGĐ',
    steps: [
      defaultStep(1, 'chief_accountant', 24),
      defaultStep(2, 'deputy_director', 24),
      defaultStep(3, 'director', 48),
      defaultStep(4, 'deputy_chairman', 48),
    ],
  },
  internal: {
    label: 'Chuyển nội bộ: KTT → GĐ → P.TGĐ (2 công ty)',
    steps: [defaultStep(1, 'chief_accountant', 24), defaultStep(2, 'director', 48), defaultStep(3, 'deputy_chairman', 48)],
  },
};

/** Chuỗi mặc định khi chưa có dòng ma trận khớp: phiếu chi theo khoảng tiền (§7.2), các loại khác cố định. */
export function defaultStepsFor(kind: DocKind, amountMinor: bigint): { label: string; steps: MatrixStep[] } {
  return kind === 'spend' ? defaultSpendSteps(amountMinor) : DEFAULT_STEPS[kind];
}

/** Ngưỡng Chairman mặc định > 5 tỷ — thêm bước cuối nếu vượt (blueprint §XX, cấu hình được qua matrix). */
function withChairman(steps: MatrixStep[], amountMinor: bigint, thresholdMinor: bigint): MatrixStep[] {
  if (amountMinor <= thresholdMinor) return steps;
  if (steps.some((s) => s.role === 'chairman')) return steps;
  return [...steps, { order: (steps.at(-1)?.order ?? 0) + 1, role: 'chairman', sla_hours: 72, mandatory: true }];
}

function sortUnique(steps: MatrixStep[]): MatrixStep[] {
  const byRole = new Map<string, MatrixStep>();
  for (const s of steps) if (!byRole.has(s.role)) byRole.set(s.role, s);
  const ordered = [...byRole.values()].sort(
    (a, b) => APPROVAL_ORDER.indexOf(a.role) - APPROVAL_ORDER.indexOf(b.role) || a.order - b.order,
  );
  return ordered.map((s, i) => ({ ...s, order: i + 1 }));
}

/** Một dòng ma trận khớp `(company_id, kind, amount, category?)` — đủ để chọn "dòng khớp nhất". */
export interface MatrixCandidate {
  company_id: string | null;
  category_id: string | null;
  amount_min_minor: bigint | string | number;
  amount_max_minor: bigint | string | number | null | undefined;
}

/** Dòng có điểm cụ thể cao nhất — dùng CHUNG với `resolveMatrix` để xem trước đúng dòng resolver sẽ chọn. */
export function matchSpecificity(r: MatrixCandidate, input: { company_id: string; category_id?: string | null }): number {
  let score = 0;
  if (r.company_id && String(r.company_id) === input.company_id) score += 2;
  if (r.category_id && String(r.category_id) === String(input.category_id ?? '')) score += 4;
  else if (!r.category_id) score += 1;
  return score;
}

/** Dải tiền `[min, max)` có chứa `amount_minor` không (`max` null = không chặn trên). */
export function amountInRange(r: MatrixCandidate, amountMinor: bigint): boolean {
  const min = big(r.amount_min_minor);
  const max = r.amount_max_minor === null || r.amount_max_minor === undefined ? null : big(r.amount_max_minor);
  return amountMinor >= min && (max === null || amountMinor < max);
}

/**
 * Xem trước dòng ma trận SẼ được áp dụng nếu các dòng trong `excludeIds` ngừng hiệu lực — chính là
 * dòng resolver chọn, chỉ bỏ qua các dòng đang xét. `null` = rơi về chuỗi mặc định (§7.2).
 */
export async function nextMatrixInLine(input: {
  company_id: string | null;
  kind: DocKind;
  amount_minor: bigint;
  category_id?: string | null;
  excludeIds: string[];
}): Promise<{ _id: string; label: string | null; company_id: string | null; version: number; roles: Role[] } | null> {
  const rows = (await Models.ApprovalMatrix.find({
    company_id: input.company_id,
    doc_kind: input.kind,
    category_id: input.category_id ?? null,
    active: true,
    _id: { $nin: input.excludeIds },
  })
    .sort({ effective_from: -1 })
    .lean()) as unknown as MatrixRow[];
  const inRange = rows.filter((r) => amountInRange(r, input.amount_minor));
  if (!inRange.length) return null;
  const where = { company_id: input.company_id ?? '', category_id: input.category_id ?? null };
  const best = inRange.sort((a, b) => matchSpecificity(b, where) - matchSpecificity(a, where))[0]!;
  return {
    _id: String(best._id),
    label: best.label ?? null,
    company_id: best.company_id ? String(best.company_id) : null,
    version: Number(best.version ?? 1),
    roles: best.steps.map((s) => s.role as Role),
  };
}

/**
 * Áp cài đặt "Duyệt tiền mặt" (ADM-04, tab "Duyệt tiền mặt") lên chuỗi bước — hàm THUẦN.
 *
 * `requiresKtt = true` (công ty đang bật) → giữ NGUYÊN chuỗi ma trận.
 * `requiresKtt = false` (mặc định) → bỏ bước Kế toán trưởng và đánh số lại `order` từ 1, phiếu đi
 * thẳng tới cấp duyệt kế tiếp. Chuỗi CHỈ có bước KTT thì giữ nguyên để không tạo chuỗi rỗng
 * (tránh `FG-WF-006` — hồ sơ không còn ai duyệt).
 */
export function applyCashPolicy(steps: MatrixStep[], requiresKtt: boolean): { steps: MatrixStep[]; cash_overridden: boolean } {
  if (requiresKtt) return { steps, cash_overridden: false };
  const rest = steps.filter((s) => s.role !== 'chief_accountant');
  if (!rest.length || rest.length === steps.length) return { steps, cash_overridden: false };
  return { steps: rest.map((s, i) => ({ ...s, order: i + 1 })), cash_overridden: true };
}

/**
 * Chọn ma trận khớp nhất: category cụ thể > doc_kind cụ thể > công ty > toàn tập đoàn,
 * rồi theo ngưỡng tiền và `effective_from` mới nhất.
 *
 * `fund` (loại tài khoản nguồn của phiếu: `bank` | `cash` | `fund`) để áp cài đặt "Duyệt tiền mặt":
 * phiếu THU/CHI quỹ tiền mặt của công ty CHƯA tick đi tiếp không qua bước KTT. Bỏ trống → coi như
 * phiếu thường (chuỗi ma trận nguyên vẹn), giữ tương thích với nơi gọi cũ.
 */
export async function resolveMatrix(input: {
  company_id: string;
  kind: DocKind;
  amount_minor: bigint;
  category_id?: string | null;
  fund?: string | null;
}): Promise<ResolvedMatrix> {
  const now = new Date();
  const rows = (await Models.ApprovalMatrix.find({
    active: true,
    doc_kind: input.kind,
    effective_from: { $lte: now },
    $or: [{ company_id: null }, { company_id: input.company_id }],
  })
    .sort({ effective_from: -1 })
    .lean()) as unknown as MatrixRow[];

  const inRange = rows.filter((r) => amountInRange(r, input.amount_minor));

  const chairmanThreshold = await chairmanThresholdFor(input.company_id, input.kind);
  // Cài đặt "Duyệt tiền mặt" đọc MỘT lần cho cả hai nhánh (ma trận khớp / chuỗi mặc định);
  // chỉ phiếu quỹ tiền mặt mới cần đọc, phiếu ngân hàng giữ nguyên chuỗi.
  const cashVoucher = isCashVoucher({ kind: input.kind, fund: input.fund });
  const requiresKtt = cashVoucher ? await cashRequiresKttFor(input.company_id) : true;

  if (inRange.length) {
    const best = inRange.sort((a, b) => matchSpecificity(b, input) - matchSpecificity(a, input))[0]!;
    const steps = sortUnique(
      best.steps
        .map((s) => ({ order: s.order, role: s.role as Role, sla_hours: s.sla_hours ?? 24, mandatory: s.mandatory !== false })),
    );
    const cash = applyCashPolicy(withChairman(steps, input.amount_minor, chairmanThreshold), requiresKtt);
    return {
      matrix_id: best._id,
      matrix_version: best.version ?? 1,
      label: best.label ?? `Khoản ${formatRange(big(best.amount_min_minor), best.amount_max_minor === null ? null : big(best.amount_max_minor))}`,
      steps: cash.steps,
      cash_overridden: cash.cash_overridden,
    };
  }

  // chưa có matrix nào khớp → mặc định theo khoảng tiền (§7.2) + ngưỡng chairman (vẫn báo được label để UI giải thích)
  const fallback = defaultStepsFor(input.kind, input.amount_minor);
  const cash = applyCashPolicy(withChairman(fallback.steps, input.amount_minor, chairmanThreshold), requiresKtt);
  return {
    matrix_id: null,
    matrix_version: 0,
    label: fallback.label,
    steps: cash.steps,
    cash_overridden: cash.cash_overridden,
  };
}

/** Key Setting cho ngưỡng Chairman (giá trị là cấu hình đa chiều bên dưới). */
export const CHAIRMAN_THRESHOLD_KEY = 'approval.chairman_threshold_minor';

/**
 * Cấu hình ngưỡng Chairman — MỘT document Setting (unique key), giá trị đa chiều:
 * mặc định chung · theo loại hồ sơ · override theo công ty (kèm theo loại hồ sơ).
 */
export interface ChairmanThresholdConfig {
  /** ngưỡng chung mọi công ty, mọi loại hồ sơ. */
  amount_minor?: string | null;
  /** ngưỡng chung theo loại hồ sơ (khi công ty không override). */
  by_kind?: Partial<Record<DocKind, string | null>>;
  /** override theo công ty (khoá = company_id). */
  companies?: Record<string, { amount_minor?: string | null; by_kind?: Partial<Record<DocKind, string | null>> }>;
  /** @deprecated dữ liệu cũ: giới hạn `amount_minor` cho một công ty. */
  company_id?: string | null;
}

const pickMinor = (v: string | null | undefined): bigint | null => (v === null || v === undefined || v === '' ? null : big(v));

/**
 * Chọn ngưỡng hiệu lực theo thứ tự cụ thể dần:
 * (công ty, loại hồ sơ) → (công ty) → (loại hồ sơ) → chung → hằng số mặc định.
 */
export function resolveChairmanThreshold(
  config: ChairmanThresholdConfig | null | undefined,
  companyId: string | null,
  kind: DocKind,
  fallbackMinor: bigint = big(DEFAULT_CHAIRMAN_THRESHOLD_MINOR),
): bigint {
  const company = companyId ? config?.companies?.[companyId] : undefined;
  // dữ liệu cũ: doc toàn cục bị khoá vào 1 công ty → chỉ áp cho đúng công ty đó
  const legacyGlobal = config?.company_id && config.company_id !== companyId ? null : config?.amount_minor;
  return (
    pickMinor(company?.by_kind?.[kind]) ??
    pickMinor(company?.amount_minor) ??
    pickMinor(config?.by_kind?.[kind]) ??
    pickMinor(legacyGlobal) ??
    fallbackMinor
  );
}

/** Đọc cấu hình ngưỡng Chairman từ Setting rồi chọn theo (công ty, loại hồ sơ). */
export async function chairmanThresholdFor(companyId: string | null, kind: DocKind): Promise<bigint> {
  const s = await Models.Setting.findOne({ key: CHAIRMAN_THRESHOLD_KEY }).lean<{ value?: ChairmanThresholdConfig } | null>();
  return resolveChairmanThreshold(s?.value, companyId, kind);
}

function formatRange(min: bigint, max: bigint | null): string {
  const fmt = (v: bigint) => (v >= 1_000_000_000n ? `${trim(v, 1_000_000_000n)} tỷ` : `${trim(v, 1_000_000n)} tr`);
  const trim = (v: bigint, unit: bigint) => {
    const s = (v / unit).toString();
    return s === '0' ? '0' : s;
  };
  if (max === null) return `≥ ${fmt(min)}`;
  if (min === 0n) return `< ${fmt(max)}`;
  return `${fmt(min)} – ${fmt(max)}`;
}

/** Nhãn "Quy trình áp dụng: khoản > 5 tỷ" cho FgApprovalTimeline (DS §7.13). */
export function matrixLabelForTimeline(label: string | null | undefined): string {
  return label ? `Quy trình áp dụng: ${label}` : 'Quy trình áp dụng: mặc định';
}

export function stepRoleLabel(role: string): string {
  return ROLE_LABEL[role as Role] ?? role;
}

/** Validate body ADM-04: không cho matrix rỗng/trùng vai trò. */
export function assertMatrixSteps(steps: MatrixStep[]): void {
  if (!steps.length) throw new ApiError({ code: 'FG-WF-006' });
  const roles = steps.map((s) => s.role);
  if (new Set(roles).size !== roles.length) {
    throw new ApiError({ code: 'FG-VAL-001', errors: { steps: 'Mỗi cấp chỉ xuất hiện một lần trong quy trình' } });
  }
  for (const s of steps) {
    if (!APPROVAL_ORDER.includes(s.role)) {
      throw new ApiError({ code: 'FG-VAL-001', errors: { steps: `${s.role} không phải cấp duyệt hợp lệ` } });
    }
  }
}
