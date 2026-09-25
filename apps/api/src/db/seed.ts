/**
 * Seed dữ liệu (architecture §17 P0 T-6) — DỮ LIỆU DEMO ĐÚNG NGHIỆP VỤ, không "Lorem"
 * (Design System §13.4 / Phụ lục B): Công ty Minh Phúc · 2,50 tỷ · VCB •••• 4521 · đảo hạn.
 *
 * Chạy idempotent: chỉ seed khi `users` rỗng. Bản CLI: `pnpm db:seed`.
 * BA-11: demo/UAT phải là dữ liệu ẩn danh — không dùng số liệu tiền thật của công ty.
 */

import { hashPassword } from '../lib/password.ts';
import { DEFAULT_AMOUNT_LIMIT_MINOR } from '@fingate/shared';
import type { FastifyBaseLogger } from 'fastify';
import { Models } from './models.ts';
import { resolveMatrix } from '../domain/workflow/matrix.ts';
import { nextDocumentCode } from '../domain/numbering/index.ts';
import { rebuildLedgerAndBalances } from '../domain/rebuild/balances.ts';

const DAY = 86_400_000;
const iso = (offsetDays: number): string => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const moneyMinor = (ty: number): bigint => BigInt(Math.round(ty * 1_000_000_000));

interface SeedPlan {
  companies: { name: string; code: string; tax_code: string; min_balance: number }[];
  departments: { company: string; name: string }[];
  accounts: { company: string | null; bank: string; number: string; name: string; balance: number; blocked?: number; is_group?: boolean }[];
  users: { email: string; name: string; role: string; company: string | null; limitTy: number }[];
  categories: { name: string; group: string; kind: string; required: string[]; order: number }[];
  loans: { company: string; bank: string; contract: string; limit: number; outstanding: number; dueInDays: number; rate: string }[];
  debts: { company: string; kind: string; party: string; value: number; settled: number; dueInDays: number }[];
  recurring: { company: string; title: string; amount: number; cadence: string; day: number }[];
  /** hồ sơ mẫu phủ các trạng thái để UI có đủ 8 trạng thái (DoD §23) */
  docs: { company: string; kind: string; title: string; purpose: string; payee: string; amountTy: number; status: string; plannedOffset: number; category: string }[];
}

const PLAN: SeedPlan = {
  companies: [
    { name: 'Công ty TNHH Xây dựng Minh Phúc', code: 'MP', tax_code: '0301234567', min_balance: 2_000_000_000 },
    { name: 'Công ty CP Thương mại An Phú', code: 'AP', tax_code: '0302345678', min_balance: 1_500_000_000 },
    { name: 'Công ty TNHH Dịch vụ Happy Home', code: 'HH', tax_code: '0303456789', min_balance: 800_000_000 },
  ],
  departments: [
    { company: 'MP', name: 'Kế toán' },
    { company: 'MP', name: 'Thi công' },
    { company: 'AP', name: 'Kế toán' },
    { company: 'AP', name: 'Kinh doanh' },
    { company: 'HH', name: 'Vận hành' },
  ],
  accounts: [
    { company: 'MP', bank: 'Vietcombank', number: '0071000452100', name: 'Công ty TNHH Xây dựng Minh Phúc', balance: 10_000_000_000 },
    { company: 'MP', bank: 'BIDV', number: '12710000889901', name: 'Công ty TNHH Xây dựng Minh Phúc', balance: 5_000_000_000, blocked: 500_000_000 },
    { company: 'AP', bank: 'VietinBank', number: '10987001234501', name: 'Công ty CP Thương mại An Phú', balance: 20_000_000_000 },
    { company: 'AP', bank: 'MB Bank', number: '08801234567801', name: 'Công ty CP Thương mại An Phú', balance: 1_200_000_000 },
    { company: 'HH', bank: 'Techcombank', number: '19130001234501', name: 'Công ty TNHH Dịch vụ Happy Home', balance: 900_000_000 },
    { company: 'MP', bank: 'Quỹ tiền mặt công ty', number: 'CASH-MP', name: 'Quỹ tiền mặt', balance: 350_000_000 },
    { company: null, bank: 'Vietcombank', number: '072100099887700', name: 'Tập đoàn — Tài khoản chính', balance: 30_000_000_000, is_group: true },
    { company: null, bank: 'Quỹ tiền mặt Tập đoàn', number: 'CASH-GROUP', name: 'Quỹ tiền mặt Tập đoàn', balance: 2_000_000_000, is_group: true },
  ],
  users: [
    { email: 'chairman@fingate.local', name: 'Trần Đình Sơn', role: 'chairman', company: 'GROUP', limitTy: 999_999 },
    { email: 'ptgd@fingate.local', name: 'Vũ Minh Khoa', role: 'deputy_chairman', company: 'GROUP', limitTy: 999_999 },
    { email: 'admin@fingate.local', name: 'Hệ thống Quản trị', role: 'admin', company: 'GROUP', limitTy: 0 },
    { email: 'giám đốc.mp@fingate.local', name: 'Nguyễn Văn Minh', role: 'director', company: 'MP', limitTy: 50 },
    { email: 'pgd.mp@fingate.local', name: 'Lê Thị Hương', role: 'deputy_director', company: 'MP', limitTy: 20 },
    { email: 'ktt.mp@fingate.local', name: 'Phạm Quang Đức', role: 'chief_accountant', company: 'MP', limitTy: 10 },
    { email: 'kt.mp@fingate.local', name: 'Hoàng Văn Tuấn', role: 'staff', company: 'MP', limitTy: 0 },
    { email: 'director.ap@fingate.local', name: 'Đặng Quốc Bảo', role: 'director', company: 'AP', limitTy: 50 },
    { email: 'ktt.ap@fingate.local', name: 'Bùi Ngọc Hà', role: 'chief_accountant', company: 'AP', limitTy: 10 },
    { email: 'staff.ap@fingate.local', name: 'Đỗ Tiến Đạt', role: 'staff', company: 'AP', limitTy: 0 },
    { email: 'director.hh@fingate.local', name: 'Ngô Thanh Thảo', role: 'director', company: 'HH', limitTy: 30 },
    { email: 'ktt.hh@fingate.local', name: 'Lý Hồng Nhung', role: 'chief_accountant', company: 'HH', limitTy: 5 },
  ],
  categories: [
    { name: 'Lương', group: 'hoat_dong', kind: 'spend', required: [], order: 1 },
    { name: 'Thuê văn phòng', group: 'hoat_dong', kind: 'spend', required: [], order: 2 },
    { name: 'Điện nước', group: 'hoat_dong', kind: 'spend', required: [], order: 3 },
    { name: 'Mua hàng / nguyên vật liệu', group: 'hoat_dong', kind: 'spend', required: ['goods_receipt'], order: 4 },
    { name: 'Chi phí quản lý', group: 'hoat_dong', kind: 'spend', required: [], order: 5 },
    { name: 'Xây dựng', group: 'dau_tu', kind: 'spend', required: ['acceptance'], order: 10 },
    { name: 'Máy móc thiết bị', group: 'dau_tu', kind: 'spend', required: [], order: 11 },
    { name: 'Trả gốc vay', group: 'tai_chinh', kind: 'spend', required: ['loan_schedule'], order: 20 },
    { name: 'Trả lãi vay', group: 'tai_chinh', kind: 'spend', required: ['bank_order'], order: 21 },
    { name: 'Phí ngân hàng', group: 'tai_chinh', kind: 'spend', required: [], order: 22 },
    { name: 'Thu dịch vụ', group: 'hoat_dong', kind: 'income', required: [], order: 30 },
    { name: 'Thu bán hàng', group: 'hoat_dong', kind: 'income', required: [], order: 31 },
  ],
  loans: [
    { company: 'MP', bank: 'BIDV', contract: 'HĐTD/2024/MP-01', limit: 30, outstanding: 20, dueInDays: 0, rate: '9,50' },
    { company: 'MP', bank: 'Vietcombank', contract: 'HĐTD/2025/MP-02', limit: 20, outstanding: 15, dueInDays: 6, rate: '8,70' },
    { company: 'AP', bank: 'MB Bank', contract: 'HĐTD/2025/AP-03', limit: 40, outstanding: 30, dueInDays: 21, rate: '10,20' },
    { company: 'AP', bank: 'VietinBank', contract: 'HĐTD/2024/AP-01', limit: 25, outstanding: 8, dueInDays: 55, rate: '9,10' },
  ],
  debts: [
    { company: 'MP', kind: 'receivable', party: 'Công ty CP Đầu tư Nhà Xanh', value: 12, settled: 4.5, dueInDays: -18 },
    { company: 'MP', kind: 'receivable', party: 'Ban QLDA Quận 7', value: 8, settled: 8, dueInDays: 12 },
    { company: 'MP', kind: 'payable', party: 'Công ty VLXD Thành Trung', value: 9.5, settled: 3, dueInDays: 4 },
    { company: 'AP', kind: 'receivable', party: 'Siêu thị Miền Đông', value: 5.5, settled: 0.5, dueInDays: -6 },
    { company: 'AP', kind: 'payable', party: 'Nhà cung cấp Bao bì Hưng Thịnh', value: 3.2, settled: 0, dueInDays: 9 },
    { company: 'HH', kind: 'payable', party: 'Công ty Vệ sinh Công nghiệp', value: 0.45, settled: 0, dueInDays: -41 },
  ],
  recurring: [
    { company: 'MP', title: 'Lương bộ phận thi công', amount: 1.4, cadence: 'monthly', day: 5 },
    { company: 'MP', title: 'Thuê văn phòng tầng 3', amount: 0.12, cadence: 'monthly', day: 10 },
    { company: 'AP', title: 'Trả lãi vay MB', amount: 0.26, cadence: 'quarterly', day: 20 },
    { company: 'HH', title: 'Bảo hiểm trách nhiệm dân sự', amount: 0.08, cadence: 'annual', day: 15 },
  ],
  docs: [
    { company: 'MP', kind: 'spend', title: 'Thanh toán NCC Thành Trung đợt 2', purpose: 'Thanh toán giai đoạn 2 hợp đồng cung cấp vật liệu theo biên bản nghiệm thu 24/2026', payee: 'Công ty VLXD Thành Trung', amountTy: 2.5, status: 'pending.gd', plannedOffset: 1, category: 'Mua hàng / nguyên vật liệu' },
    { company: 'MP', kind: 'spend', title: 'Chi phí thi công hạng mục móng', purpose: 'Thuê đội thi công cọc khoan nhồi đại trà', payee: 'Công ty CP Ep cọc nền móng Trường Phát', amountTy: 4.8, status: 'pending.pgd', plannedOffset: 2, category: 'Xây dựng' },
    { company: 'AP', kind: 'spend', title: 'Lương tháng 8 bộ phận kinh doanh', purpose: 'Chi trả lương và phụ cấp tháng 8 cho 32 nhân sự', payee: 'Phòng Kế toán — bảng lương T8', amountTy: 1.5, status: 'pending.ktt', plannedOffset: 0, category: 'Lương' },
    { company: 'HH', kind: 'spend', title: 'Điện nước tháng 8', purpose: 'Thanh toán hóa đơn điện nước tòa nhà VP', payee: 'EVN TP.HCM', amountTy: 0.042, status: 'pending.ktt', plannedOffset: 3, category: 'Điện nước' },
    { company: 'MP', kind: 'spend', title: 'Mua thiết bị văn phòng', purpose: 'Mua 6 máy tính cho phòng kỹ thuật theo báo giá 03/2026', payee: 'Công ty CP Tin học Hoa Sua', amountTy: 0.18, status: 'draft', plannedOffset: 7, category: 'Máy móc thiết bị' },
    { company: 'AP', kind: 'spend', title: 'Thanh toán hợp đồng quảng cáo', purpose: 'Giải ngân đợt 1 gói truyền thông ra mắt sản phẩm mới', payee: 'Công ty Media Bright', amountTy: 6.2, status: 'pending.chairman', plannedOffset: 5, category: 'Chi phí quản lý' },
    { company: 'MP', kind: 'spend', title: 'Trả gốc vay BIDV HĐTD/2024/MP-01', purpose: 'Trả nợ gốc theo kỳ của hợp đồng tín dụng', payee: 'BIDV Chi nhánh TP.HCM', amountTy: 5, status: 'approved', plannedOffset: 0, category: 'Trả gốc vay' },
    { company: 'AP', kind: 'spend', title: 'Phí thường niên tài khoản', purpose: 'Phí dịch vụ tài khoản doanh số', payee: 'MB Bank', amountTy: 0.002, status: 'paid', plannedOffset: -3, category: 'Phí ngân hàng' },
    { company: 'MP', kind: 'income', title: 'Thu tiền dự án Nhà Xanh đợt 3', purpose: 'Nghiệm thu hoàn thiện tầng 5-8 theo phụ lục hợp đồng 03', payee: 'Công ty CP Đầu tư Nhà Xanh', amountTy: 3.5, status: 'pending.ktt', plannedOffset: 2, category: 'Thu dịch vụ' },
    { company: 'AP', kind: 'income', title: 'Thu bán hàng tháng 8', purpose: 'Đối chiếu công nợ phải thu siêu thị Miền Đông', payee: 'Siêu thị Miền Đông', amountTy: 1.1, status: 'paid', plannedOffset: -1, category: 'Thu bán hàng' },
    { company: 'MP', kind: 'rollover', title: 'Phương án đảo hạn BIDV 20 tỷ', purpose: 'Đảo hạn toàn bộ dư nợ HĐTD/2024/MP-01 đến hạn hôm nay', payee: 'BIDV Chi nhánh TP.HCM', amountTy: 20, status: 'pending.gd', plannedOffset: 0, category: 'Trả gốc vay' },
    { company: 'AP', kind: 'internal', title: 'Chuyển vốn điều hành AP → MP', purpose: 'Tạm ứng cho công ty mẹ thanh toán lô vật liệu', payee: 'Nội bộ tập đoàn', amountTy: 5, status: 'approved', plannedOffset: 1, category: '' },
    { company: 'HH', kind: 'spend', title: 'Sửa chữa máy photocopy', purpose: 'Hồ sơ đã gửi nhưng thiếu hóa đơn nhà cung cấp', payee: 'Công ty TNHH TM DV Tân Đại Thành', amountTy: 0.014, status: 'changes_requested', plannedOffset: 4, category: 'Chi phí quản lý' },
    { company: 'MP', kind: 'spend', title: 'Đặt cọc thuê kho', purpose: 'Bị từ chối do vượt kế hoạch quý không có trong ngân sách', payee: 'Công ty CP Kho vận Sài Gòn', amountTy: 0.9, status: 'rejected', plannedOffset: -6, category: 'Thuê văn phòng' },
  ],
};

/** Seed khi DB rỗng. Trả về thống kê để log. */
export async function seedIfEmpty(log?: FastifyBaseLogger): Promise<Record<string, unknown>> {
  const existing = await Models.User.countDocuments().exec();
  for (const c of PLAN.companies) void c;
  if (existing > 0) {
    log?.info(`[seed] bỏ qua — đã có ${existing} người dùng`);
    return { skipped: true, users: existing };
  }
  return seedAll(log);
}

export async function seedAll(log?: FastifyBaseLogger): Promise<Record<string, unknown>> {
  const stats: Record<string, number> = {};
  log?.info('[seed] tạo dữ liệu demo (ẩn danh — BA-11)');

  /* companies + departments + accounts */
  const companyIds = new Map<string, string>();
  for (const c of PLAN.companies) {
    const doc = await Models.Company.create({
      name: c.name,
      code: c.code,
      tax_code: c.tax_code,
      min_balance_minor: BigInt(Math.round(c.min_balance)),
      working_calendar: { workdays: [1, 2, 3, 4, 5, 6], holidays: ['2026-09-02', '2027-01-01', '2027-02-08'] },
    } as never);
    companyIds.set(c.code, String(doc._id));
    companyCodes.push(c.code);
  }
  // Pháp nhân Tập đoàn DUY NHẤT — tạo sẵn, chỉ sửa không tạo thêm (yêu cầu mới).
  {
    const existing = await Models.Company.findOne({ code: 'GROUP' }).lean();
    const group = existing ?? (await Models.Company.create({
      name: 'Tập đoàn',
      code: 'GROUP',
      is_group: true,
      min_balance_minor: 0n,
      status: 'active',
    } as never));
    companyIds.set('GROUP', String((group as { _id: unknown })._id));
  }
  stats.companies = companyIds.size;

  const deptIds = new Map<string, string>();
  for (const d of PLAN.departments) {
    const company = companyIds.get(d.company);
    if (!company) continue;
    const doc = await Models.Department.create({ company_id: company, name: d.name } as never);
    deptIds.set(`${d.company}|${d.name}`, String(doc._id));
  }
  stats.departments = deptIds.size;

  for (const a of PLAN.accounts) {
    const acctDoc = await Models.BankAccount.create({
      company_id: a.company ? companyIds.get(a.company) ?? null : null,
      is_group: Boolean(a.is_group),
      bank_name: a.bank,
      account_name: a.name,
      account_number: a.number,
      kind: a.number.startsWith('CASH-') ? 'cash' : 'bank',
      currency: 'VND',
      min_balance_minor: a.company ? BigInt(Math.round((PLAN.companies.find((c) => c.code === a.company)?.min_balance ?? 0) / 2)) : 0n,
      status: 'active',
    } as never);
    accountIds.set(a.number, String((acctDoc as { _id: unknown })._id));
  }
  stats.bank_accounts = PLAN.accounts.length;

  /* users + assignments — mật khẩu demo chung, cố định để dev/E2E lặp lại được */
  const demoPassword = await hashPassword('fingate-demo-2026');
  const userIds = new Map<string, string>();
  /** email→{role,company} đã lưu lúc tạo: tra trực tiếp, không suy từ chuỗi (địa chỉ có dấu) */
  const byRole = new Map<string, string[]>();
  const record = (role: string, company: string | null, id: string): void => {
    const key = company ? `${role}|${company}` : role;
    byRole.set(key, [...(byRole.get(key) ?? []), id]);
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.set(role, [...(byRole.get(role) as string[]), id]);
  };
  for (const u of PLAN.users) {
    const doc = await Models.User.create({
      email: u.email,
      display_name: u.name,
      password: demoPassword,
      status: 'active',
      mfa_required: ['chief_accountant', 'deputy_director', 'director', 'deputy_chairman', 'chairman', 'admin'].includes(u.role),
    } as never);
    userIds.set(u.email, String(doc._id));
    record(u.role, u.company, String(doc._id));
    const companies = u.company ? [u.company] : [...companyIds.keys()];
    for (const code of companies) {
      const id = companyIds.get(code);
      if (!id) continue;
      await Models.Assignment.create({
        user_id: doc._id,
        company_id: id,
        department_id: deptIds.get(`${code}|Kế toán`) ?? null,
        role: u.role,
        amount_limit_minor: u.limitTy > 0 ? moneyMinor(u.limitTy) : BigInt(DEFAULT_AMOUNT_LIMIT_MINOR[u.role as keyof typeof DEFAULT_AMOUNT_LIMIT_MINOR] ?? '0'),
        scope_all: !u.company,
        status: 'active',
      } as never);
    }
  }
  stats.users = userIds.size;

  /* categories */
  const catIds = new Map<string, string>();
  for (const c of PLAN.categories) {
    const doc = await Models.Category.create({
      name: c.name,
      group: c.group,
      doc_kind: c.kind,
      required_evidence: c.required,
      order: c.order,
      active: true,
    } as never);
    catIds.set(`${c.kind}|${c.name}`, String(doc._id));
  }
  stats.categories = catIds.size;

  /* approval matrix — khớp blueprint §XX: <50tr / 50tr–5tỷ / >5tỷ */
  for (const c of PLAN.companies) {
    const id = companyIds.get(c.code) as string;
    const tiers = [
      { min: 0, max: moneyMinor(0.05), steps: ['chief_accountant', 'deputy_director'] },
      { min: moneyMinor(0.05), max: moneyMinor(5), steps: ['chief_accountant', 'deputy_director', 'director', 'deputy_chairman'] },
      { min: moneyMinor(5), max: null, steps: ['chief_accountant', 'deputy_director', 'director', 'deputy_chairman'] },
    ];
    for (const t of tiers) {
      await Models.ApprovalMatrix.create({
        company_id: id,
        doc_kind: 'spend',
        amount_min_minor: t.min,
        amount_max_minor: t.max,
        currency: 'VND',
        steps: t.steps.map((role, i) => ({ order: i + 1, role, sla_hours: 24, mandatory: true })),
        version: 1,
        effective_from: new Date('2026-01-01T00:00:00Z'),
        label: t.max === null ? 'Khoản > 5 tỷ — qua Tổng Giám đốc' : t.min === 0n ? 'Khoản < 50 triệu' : 'Khoản 50 triệu – 5 tỷ',
        active: true,
      } as never);
    }
    await Models.ApprovalMatrix.create({
      company_id: id,
      doc_kind: 'income',
      amount_min_minor: 0n,
      steps: [
        { order: 1, role: 'chief_accountant', sla_hours: 24, mandatory: true },
        { order: 2, role: 'director', sla_hours: 48, mandatory: true },
        { order: 3, role: 'deputy_chairman', sla_hours: 48, mandatory: true },
      ],
      version: 1,
      effective_from: new Date('2026-01-01T00:00:00Z'),
      label: 'Khoản thu — KTT → GĐ → P.TGĐ',
      active: true,
    } as never);
    await Models.ApprovalMatrix.create({
      company_id: id,
      doc_kind: 'rollover',
      amount_min_minor: 0n,
      steps: [
        { order: 1, role: 'chief_accountant', sla_hours: 12, mandatory: true },
        { order: 2, role: 'deputy_director', sla_hours: 24, mandatory: true },
        { order: 3, role: 'director', sla_hours: 24, mandatory: true },
        { order: 4, role: 'deputy_chairman', sla_hours: 48, mandatory: true },
      ],
      version: 1,
      effective_from: new Date('2026-01-01T00:00:00Z'),
      label: 'Đảo hạn — KTT → PGĐ → GĐ → P.TGĐ',
      active: true,
    } as never);
  }
  stats.approval_matrix = PLAN.companies.length * 5;

  /* settings — ngưỡng chairman, yêu cầu chứng từ mặc định */
  const settings = [
    { key: 'approval.chairman_threshold_minor', value: { amount_minor: moneyMinor(5).toString() }, description: 'Hồ sơ > ngưỡng phải qua Tổng Giám đốc (Chủ tịch) (§XX)' },
    { key: 'evidence.required.spend', value: { types: [] }, description: 'Chứng từ bắt buộc phiếu chi — hoá đơn/hợp đồng không còn bắt buộc' },
    { key: 'evidence.required.income', value: { types: [] }, description: 'Chứng từ bắt buộc phiếu thu — hoá đơn/hợp đồng không còn bắt buộc' },
    { key: 'newsletter.recipients', value: { roles: ['director', 'deputy_director', 'chief_accountant'] }, description: 'Người nhận bản tin 06:30' },
    { key: 'app.demo', value: { seeded_at: new Date().toISOString(), note: 'Dữ liệu demo ẩn danh — chưa phải số liệu thật (BA-0, BA-11)' }, description: 'Cờ dữ liệu demo' },
  ];
  for (const s of settings) {
    await Models.Setting.updateOne({ key: s.key }, { $set: s as never }, { upsert: true }).exec();
  }
  stats.settings = settings.length;

  /* loans */
  const loanIds = new Map<string, string>();
  for (const l of PLAN.loans) {
    const company = companyIds.get(l.company);
    if (!company) continue;
    const due = iso(l.dueInDays);
    const doc = await Models.Loan.create({
      company_id: company,
      bank_name: l.bank,
      contract_code: l.contract,
      limit_minor: moneyMinor(l.limit),
      outstanding_minor: moneyMinor(l.outstanding),
      currency: 'VND',
      disbursed_at: iso(l.dueInDays - 365),
      maturity_date: due,
      next_due_date: due,
      interest_rate: l.rate,
      interest_period: 'quarterly',
      principal_period: 'bullet',
      collateral: 'Dự án đang thi công + bảo lãnh giám đốc',
      status: 'active',
    } as never);
    loanIds.set(l.contract, String(doc._id));
  }
  stats.loans = loanIds.size;

  /* debt items */
  for (const d of PLAN.debts) {
    const company = companyIds.get(d.company);
    if (!company) continue;
    await Models.DebtItem.create({
      kind: d.kind,
      company_id: company,
      counterparty_name: d.party,
      value_minor: moneyMinor(d.value),
      settled_minor: moneyMinor(d.settled),
      due_date: iso(d.dueInDays),
      priority: d.dueInDays < 0 ? 'high' : 'normal',
      status: d.settled >= d.value ? 'settled' : d.settled > 0 ? 'partial' : 'open',
    } as never);
  }
  stats.debt_items = PLAN.debts.length;

  /* recurring rules */
  for (const r of PLAN.recurring) {
    const company = companyIds.get(r.company);
    if (!company) continue;
    await Models.RecurringRule.create({
      company_id: company,
      title: r.title,
      purpose: `${r.title} — khoản định kỳ`,
      payee: { name: 'Theo hợp đồng dịch vụ' },
      amount_minor: moneyMinor(r.amount),
      currency: 'VND',
      source: { fund: 'bank', account_id: null },
      cadence: r.cadence,
      day_of_period: r.day,
      remind_days: [7, 3, 1],
      effective_from: iso(-90),
      status: 'active',
    } as never);
  }
  stats.recurring_rules = PLAN.recurring.length;

  /** chọn người theo vai trò, ưu tiên đúng công ty, rồi tới công ty khác (luồng không treo). */
  const pick = (role: string, company: string | null): string | null =>
    (company ? byRole.get(`${role}|${company}`)?.[0] : undefined) ?? byRole.get(role)?.[0] ?? null;
  const approver = (role: string, company: string | null): string | null => pick(role, company);
  const anyUser = [...userIds.values()][0] as string;

  /* documents — phủ nhiều trạng thái để test hàng chờ + fast-track */
  const statusStepState: Record<string, number> = {
    draft: 0,
    'pending.ktt': 1,
    'pending.pgd': 2,
    'pending.gd': 3,
    'pending.ptg': 4,
    'pending.chairman': 5,
    processing: 99,
    approved: 99,
    paid: 99,
    rejected: -1,
    changes_requested: 0,
  };
  let docCount = 0;
  for (const d of PLAN.docs) {
    const company = companyIds.get(d.company);
    const kind = d.kind as 'spend' | 'income' | 'rollover' | 'internal';
    if (!company) continue;
    const matrix = await resolveMatrix({ company_id: company, kind, amount_minor: moneyMinor(d.amountTy) });
    const reached = statusStepState[d.status] ?? 0;
    const account = PLAN.accounts.find((a) => a.company === d.company && !a.number.startsWith('CASH-'));
    const creator = pick('staff', d.company) ?? anyUser;
    const code = await nextDocumentCode(kind);
    const required = (PLAN.categories.find((c) => c.name === d.category)?.required as string[] | undefined) ?? [];
    const steps = matrix.steps.map((s, i) => ({
      order: s.order,
      role: s.role,
      user_id: approver(s.role, d.company),
      state: d.status === 'paid' || d.status === 'approved' || d.status === 'processing' ? 'done' : i + 1 < reached ? 'done' : i + 1 === reached ? 'current' : 'waiting',
      decided_at: null,
      opinion: null,
      sla_deadline: new Date(Date.now() + (s.order * 12 - 6) * DAY),
    }));

    await Models.Document.create({
      code,
      kind,
      company_id: company,
      department_id: deptIds.get(`${d.company}|Kế toán`) ?? null,
      created_by: creator,
      status: d.status,
      version: 1,
      title: d.title,
      purpose: d.purpose,
      category_id: catIds.get(`${kind}|${d.category}`) ?? null,
      payee: { name: d.payee, is_internal: kind === 'internal' },
      amount: { minor: moneyMinor(d.amountTy), currency: 'VND', decimals: 0 },
      source: { fund: 'bank', account_id: account ? accountIds.get(account.number) ?? null : null },
      planned_date: `${iso(d.plannedOffset)}T09:00`,
      business_date: iso(d.plannedOffset),
      priority: d.amountTy >= 5 ? 'high' : 'normal',
      contract: { code: `HĐ/2026/${d.company}-${String(docCount + 7).padStart(2, '0')}` },
      loan_id: kind === 'rollover' ? loanIds.get('HĐTD/2024/MP-01') ?? null : null,
      rollover: kind === 'rollover' ? { need_amount: { minor: moneyMinor(d.amountTy), currency: 'VND', decimals: 0 }, plan: 'Vay ngắn hạn kỳ mới, giữ nguyên tài sản bảo đảm', new_rate: '9,20' } : null,
      target: kind === 'internal' ? { company_id: companyIds.get('MP') ?? null, account_id: accountIds.get('0071000452100') ?? null } : null,
      approval: { matrix_id: null, matrix_version: matrix.matrix_version, matrix_label: matrix.label, steps },
      evidence: { required, present: d.status === 'rejected' ? [] : required, missing: d.status === 'rejected' ? required : [] },
      execution: d.status === 'paid' ? { paid_at: iso(d.plannedOffset), bank_ref: `UNC-${2400 + docCount}`, actual_amount: { minor: moneyMinor(d.amountTy), currency: 'VND', decimals: 0 } } : null,
      submitted_at: d.status === 'draft' ? null : new Date(Date.now() - (d.amountTy > 4 ? 4 : 1) * DAY),
      sla_deadline: steps.find((s) => s.state === 'current')?.sla_deadline ?? null,
      history: [
        {
          at: new Date(Date.now() - 5 * DAY),
          actor: { user_id: creator, role: 'staff', name: 'Hệ thống seed' },
          action: 'create',
          from: null,
          to: 'draft',
          request_id: `seed-${docCount}`,
        },
        ...(d.status === 'draft'
          ? []
          : [
              {
                at: new Date(Date.now() - 4 * DAY),
                actor: { user_id: creator, role: 'staff', name: 'Hệ thống seed' },
                action: 'submit',
                from: 'draft',
                to: d.status,
                request_id: `seed-${docCount}-submit`,
              },
            ]),
      ],
    } as never);
    docCount++;
  }
  stats.documents = docCount;

  /* tạo thêm bộ hồ sơ nháp/ chờ để danh sách đủ "dày" như dự kiến ~300 phiếu/năm demo */
  const extras = 60;
  const parties = ['Công ty CP Xây dựng Đại An', 'Nhà cung cấp Nội thất Gỗ Việt', 'Công ty TNHH Vận tải Liên Á', 'Ban Quản lý dự án huyện Nhà Bè', 'Công ty CP Công nghệ Tin học_lambda'];
  for (let i = 0; i < extras; i++) {
    const companyCode = PLAN.companies[i % PLAN.companies.length]?.code as string;
    const company = companyIds.get(companyCode);
    if (!company) continue;
    const kind = (i % 7 === 0 ? 'income' : 'spend') as 'spend' | 'income';
    const amountTy = 0.05 + ((i * 37) % 900) / 100;
    const statusPool = ['draft', 'pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'approved', 'processing', 'paid', 'changes_requested'];
    const status = statusPool[i % statusPool.length] as string;
    const matrix = await resolveMatrix({ company_id: company, kind, amount_minor: moneyMinor(amountTy) });
    const creator = pick('staff', companyCode) ?? anyUser;
    const code = await nextDocumentCode(kind);
    const account = PLAN.accounts.find((a) => a.company === companyCode && !a.number.startsWith('CASH-'));
    await Models.Document.create({
      code,
      kind,
      company_id: company,
      department_id: deptIds.get(`${companyCode}|Kế toán`) ?? null,
      created_by: creator ?? null,
      status,
      version: 1,
      title: `${kind === 'income' ? 'Thu' : 'Chi'} ${parties[i % parties.length] ?? 'đối tác'} · hồ sơ ${i + 1}`,
      purpose: 'Hồ sơ demo phục vụ UAT — đối chiếu theo hợp đồng năm 2026',
      payee: { name: parties[i % parties.length] ?? 'Đối tác', is_internal: false },
      amount: { minor: moneyMinor(amountTy), currency: 'VND', decimals: 0 },
      source: { fund: 'bank', account_id: account ? accountIds.get(account.number) ?? null : null },
      planned_date: `${iso(((i * 3) % 40) - 10)}T${String(8 + (i % 9)).padStart(2, '0')}:00`,
      business_date: iso(0),
      priority: 'normal',
      approval: {
        matrix_id: null,
        matrix_version: matrix.matrix_version,
        matrix_label: matrix.label,
        steps: matrix.steps.map((s, idx) => ({
          order: s.order,
          role: s.role,
          user_id: approver(s.role, companyCode),
          // TRƯỚC: luôn đặt step 1 'current' bất kể status → không user nào là người xử lý
          // hiện tại hợp lệ (can.approve=false toàn bộ). Nay đồng bộ theo statusStepState như hồ sơ PLAN.
          state: (() => {
            const reached = statusStepState[status] ?? 0;
            if (reached >= 99) return 'done' as const;
            if (idx + 1 < reached) return 'done' as const;
            if (idx + 1 === reached) return 'current' as const;
            return 'waiting' as const;
          })(),
          sla_deadline: new Date(Date.now() + ((i % 5) - 2) * DAY),
        })),
      },
      evidence: { required: [], present: [], missing: [] },
      submitted_at: status === 'draft' ? null : new Date(Date.now() - ((i % 9) + 1) * DAY),
      history: [{ at: new Date(Date.now() - 10 * DAY), actor: { user_id: creator ?? null, role: 'staff', name: 'Hệ thống seed' }, action: 'create', to: 'draft' }],
    } as never);
    docCount++;
  }
  stats.documents = docCount;

  /* ledger + balances ban đầu để dashboard có số */
  await rebuildLedgerAndBalances();
  log?.info(`[seed] xong: ${JSON.stringify(stats)}`);
  return stats;
}

const companyCodes: string[] = [];
const accountIds = new Map<string, string>();

/**
 * Module thuần — KHÔNG tự kết nối khi import. Entry điểm CLI là db/seed.js
 * (gọi `pnpm db:seed`), để tránh hai runner dùng chung một mongoose connection.
 */
