/**
 * Bootstrap — tài khoản quản trị ĐẦU TIÊN khi DB còn rỗng.
 *
 * Vì sao cần: `resolveIdentity` chỉ cấp quyền qua `assignments`, mà `assignment`
 * bắt buộc có `company_id`. Nên khi DB trắng (chưa có công ty nào) ta tạo một
 * pháp nhân cấp Tập đoàn (`companies.is_group = true`, mã `GROUP`) làm gốc, rồi
 * gắn tài khoản quản trị vào đó. Mọi công ty con thêm sau đều nằm trong tầm nhìn
 * của tài khoản này vì `role = admin` ⇒ `scope_all = true`.
 *
 * Tài khoản tạo ra có vai trò `admin` — QUẢN LÝ thuần: nhân sự · công ty/bộ phận ·
 * ma trận duyệt · cấu hình · tài khoản tập đoàn · audit. KHÔNG có quyền trên hồ sơ,
 * hoá đơn hay phiếu thu/chi (xem `ROLE_PERMISSIONS.admin` ở `@fingate/shared`).
 *
 * Idempotent: chỉ chạy khi `users` rỗng. Gọi từ `server.ts` (boot) hoặc `pnpm db:bootstrap`.
 */

import type { FastifyBaseLogger } from 'fastify';
import { getEnv } from '../env.ts';
import { hashPassword } from '../lib/password.ts';
import { Models } from './models.ts';

/** Mã pháp nhân cấp Tập đoàn — gốc của cây công ty, không phải công ty con. */
export const GROUP_COMPANY_CODE = 'GROUP';

/** Tạo (nếu chưa có) pháp nhân Tập đoàn và trả về id. */
export async function ensureGroupCompany(): Promise<string> {
  const existing = await Models.Company.findOne({ code: GROUP_COMPANY_CODE }).lean();
  if (existing) return String(existing._id);
  const doc = await Models.Company.create({
    name: 'Tập đoàn',
    code: GROUP_COMPANY_CODE,
    is_group: true,
    status: 'active',
  } as never);
  return String(doc._id);
}

/** Số hiệu quỹ tiền mặt mặc định của Tập đoàn. */
export const GROUP_CASH_ACCOUNT_NUMBER = 'CASH-GROUP';

/** Tạo (nếu chưa có) quỹ tiền mặt mặc định của Tập đoàn — công ty con thấy để chọn nguồn tiền. */
export async function ensureGroupCashAccount(): Promise<string> {
  const existing = await Models.BankAccount.findOne({ account_number: GROUP_CASH_ACCOUNT_NUMBER, company_id: null }).lean();
  if (existing) return String(existing._id);
  const doc = await Models.BankAccount.create({
    company_id: null,
    is_group: true,
    bank_name: 'Quỹ tiền mặt Tập đoàn',
    account_name: 'Quỹ tiền mặt Tập đoàn',
    account_number: GROUP_CASH_ACCOUNT_NUMBER,
    kind: 'cash',
    currency: 'VND',
    min_balance_minor: 0n,
    status: 'active',
  } as never);
  return String(doc._id);
}

/** Tạo tài khoản quản trị đầu tiên nếu DB chưa có người dùng nào. */
export async function bootstrapAdminIfEmpty(log?: FastifyBaseLogger): Promise<Record<string, unknown>> {
  const users = await Models.User.countDocuments({}).exec();
  if (users > 0) {
    log?.info(`[bootstrap] bỏ qua — đã có ${users} người dùng`);
    return { skipped: true, users };
  }

  const env = getEnv();
  const email = env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();
  const password = await hashPassword(env.BOOTSTRAP_ADMIN_PASSWORD);
  const companyId = await ensureGroupCompany();
  await ensureGroupCashAccount();

  const user = await Models.User.create({
    email,
    display_name: env.BOOTSTRAP_ADMIN_NAME,
    password,
    status: 'active',
    mfa_required: true,
  } as never);

  await Models.Assignment.create({
    user_id: user._id,
    company_id: companyId,
    department_id: null,
    role: 'admin',
    amount_limit_minor: 0n,
    scope_all: true,
    status: 'active',
  } as never);

  log?.info(
    `[bootstrap] đã tạo tài khoản quản trị đầu tiên: ${email} — đổi mật khẩu ngay sau khi đăng nhập`,
  );
  return { created: true, email, company_id: companyId, role: 'admin' };
}
