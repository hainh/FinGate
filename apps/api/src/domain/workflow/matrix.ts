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

/** Quy trình mặc định khi chưa cấu hình gì (blueprint §XX) — vẫn là dữ liệu, không hard-code nghiệp vụ ở route. */
export const DEFAULT_STEPS: Record<DocKind, { amount: string; steps: MatrixStep[]; label: string }> = {
  spend: {
    amount: '0',
    label: 'Mặc định: KTT → PGĐ → GĐ → P.TGĐ',
    steps: [
      { order: 1, role: 'chief_accountant', sla_hours: 24, mandatory: true },
      { order: 2, role: 'deputy_director', sla_hours: 24, mandatory: true },
      { order: 3, role: 'director', sla_hours: 48, mandatory: true },
      { order: 4, role: 'deputy_chairman', sla_hours: 48, mandatory: true },
    ],
  },
  income: {
    amount: '0',
    label: 'Mặc định: KTT → GĐ → P.TGĐ',
    steps: [
      { order: 1, role: 'chief_accountant', sla_hours: 24, mandatory: true },
      { order: 2, role: 'director', sla_hours: 48, mandatory: true },
      { order: 3, role: 'deputy_chairman', sla_hours: 48, mandatory: true },
    ],
  },
  rollover: {
    amount: '0',
    label: 'Đảo hạn: KTT → PGĐ → GĐ → P.TGĐ',
    steps: [
      { order: 1, role: 'chief_accountant', sla_hours: 24, mandatory: true },
      { order: 2, role: 'deputy_director', sla_hours: 24, mandatory: true },
      { order: 3, role: 'director', sla_hours: 48, mandatory: true },
      { order: 4, role: 'deputy_chairman', sla_hours: 48, mandatory: true },
    ],
  },
  internal: {
    amount: '0',
    label: 'Chuyển nội bộ: KTT → GĐ → P.TGĐ (2 công ty)',
    steps: [
      { order: 1, role: 'chief_accountant', sla_hours: 24, mandatory: true },
      { order: 2, role: 'director', sla_hours: 48, mandatory: true },
      { order: 3, role: 'deputy_chairman', sla_hours: 48, mandatory: true },
    ],
  },
};

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

/**
 * Chọn ma trận khớp nhất: category cụ thể > doc_kind cụ thể > công ty > toàn tập đoàn,
 * rồi theo ngưỡng tiền và `effective_from` mới nhất.
 */
export async function resolveMatrix(input: {
  company_id: string;
  kind: DocKind;
  amount_minor: bigint;
  category_id?: string | null;
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

  const matchSpecificity = (r: MatrixRow): number => {
    let score = 0;
    if (r.company_id && String(r.company_id) === input.company_id) score += 2;
    if (r.category_id && String(r.category_id) === String(input.category_id ?? '')) score += 4;
    else if (!r.category_id) score += 1;
    return score;
  };

  const inRange = rows.filter((r) => {
    const min = big(r.amount_min_minor);
    const max = r.amount_max_minor === null || r.amount_max_minor === undefined ? null : big(r.amount_max_minor);
    return input.amount_minor >= min && (max === null || input.amount_minor < max);
  });

  const chairmanThreshold = await chairmanThresholdFor(input.company_id, input.kind);
  const baseSteps = DEFAULT_STEPS[input.kind].steps;

  if (inRange.length) {
    const best = inRange.sort((a, b) => matchSpecificity(b) - matchSpecificity(a))[0]!;
    const steps = sortUnique(
      best.steps
        .map((s) => ({ order: s.order, role: s.role as Role, sla_hours: s.sla_hours ?? 24, mandatory: s.mandatory !== false })),
    );
    return {
      matrix_id: best._id,
      matrix_version: best.version ?? 1,
      label: best.label ?? `Khoản ${formatRange(big(best.amount_min_minor), best.amount_max_minor === null ? null : big(best.amount_max_minor))}`,
      steps: withChairman(steps, input.amount_minor, chairmanThreshold),
    };
  }

  // chưa có matrix nào khớp → mặc định + ngưỡng chairman (vẫn báo được label để UI giải thích)
  return {
    matrix_id: null,
    matrix_version: 0,
    label: DEFAULT_STEPS[input.kind].label,
    steps: withChairman(baseSteps, input.amount_minor, chairmanThreshold),
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
