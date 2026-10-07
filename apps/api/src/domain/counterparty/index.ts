/**
 * Danh bạ Đối tác / Khách hàng — nghiệp vụ dùng chung.
 *
 * · Chuẩn hoá & nhận diện chuỗi 3 trường `Tên công ty - Ngân hàng - Số tài khoản`
 *   (dấu phân tách ĐÚNG ` - `; chỉ nhận khi đủ 3 phần, đều khác rỗng).
 * · `ensureCounterparty` — tạo/khớp đối tác, chống trùng theo tên công ty và theo
 *   số tài khoản ngân hàng (khi quét phiếu cũ). KHÔNG chặn nếu một số tài khoản
 *   xuất hiện ở 2 công ty khác nhau — chỉ bỏ qua, không tạo thêm bản ghi trùng.
 * · `syncCounterparties` — quét TOÀN BỘ phiếu thu/chi + phiếu công nợ đã có để tạo
 *   đối tác và đồng bộ định danh (`payee.counterparty_id` / `counterparty_id`).
 *   Chạy một lần khi khởi động backend (yêu cầu nghiệp vụ).
 */

import { COUNTERPARTY_SEPARATOR } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { detectInternalTransferTarget } from '../workflow/auto-income.ts';

export interface ParsedCounterparty {
  name: string;
  bank_name: string;
  account_number: string;
}

/** Tên chuẩn hoá dùng làm khoá chống trùng (gộp khoảng trắng + lowercase). */
export function normalizeCounterpartyName(name: string): string {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Cắt chuỗi `Tên công ty - Ngân hàng - Số tài khoản` (ĐÚNG 3 phần, đều khác rỗng). */
export function parseCounterpartyLabel(label: string | null | undefined): ParsedCounterparty | null {
  const raw = String(label ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(COUNTERPARTY_SEPARATOR);
  if (parts.length !== 3) return null;
  const [name, bankName, accountNumber] = parts.map((p) => p.trim());
  if (!name || !bankName || !accountNumber) return null;
  return { name, bank_name: bankName, account_number: accountNumber };
}

/** Ghép 3 trường chuẩn trở lại chuỗi nhãn cho select box. */
export function formatCounterpartyLabel(name: string, bankName: string, accountNumber: string): string {
  return [name.trim(), bankName.trim(), accountNumber.trim()].join(COUNTERPARTY_SEPARATOR);
}

interface CounterpartyBankLean {
  bank_name?: string;
  account_number?: string;
}

interface CounterpartyLean {
  _id: unknown;
  name?: string;
  banks?: CounterpartyBankLean[];
}

/** Số tài khoản đã thuộc một đối tác KHÁC chưa (loại trừ chính nó). */
async function accountUsedElsewhere(accountNumber: string, exceptId?: string): Promise<boolean> {
  const filter: Record<string, unknown> = { 'banks.account_number': accountNumber };
  if (exceptId) filter._id = { $ne: exceptId };
  const found = await Models.Counterparty.findOne(filter as never).select({ _id: 1 }).lean();
  return Boolean(found);
}

export interface EnsureCounterpartyInput {
  name: string;
  bank_name?: string | null;
  account_number?: string | null;
  created_by?: string | null;
}

/**
 * Tạo nếu chưa có, hoặc thêm tài khoản ngân hàng vào đối tác đã có.
 * Trả về id đối tác. Chống trùng: tên (name_key) và số tài khoản (toàn danh bạ).
 */
export async function ensureCounterparty(input: EnsureCounterpartyInput): Promise<string> {
  const name = String(input.name ?? '').trim();
  const nameKey = normalizeCounterpartyName(name);
  const bankName = String(input.bank_name ?? '').trim();
  const account = String(input.account_number ?? '').trim();

  const existing = await Models.Counterparty.findOne({ name_key: nameKey }).lean<CounterpartyLean | null>();
  if (!existing) {
    const banks: { bank_name: string; account_number: string }[] = [];
    // chỉ thêm STK nếu chưa thuộc đối tác nào khác (không tạo doc con trùng).
    if (bankName && account && !(await accountUsedElsewhere(account))) {
      banks.push({ bank_name: bankName, account_number: account });
    }
    const created = await Models.Counterparty.create({
      name,
      name_key: nameKey,
      banks,
      created_by: input.created_by ?? null,
    } as never);
    return String(created._id);
  }

  const id = String(existing._id);
  const hasBank = (existing.banks ?? []).some((b) => String(b.account_number ?? '') === account);
  if (bankName && account && !hasBank && !(await accountUsedElsewhere(account, id))) {
    await Models.Counterparty.updateOne(
      { _id: id },
      { $push: { banks: { bank_name: bankName, account_number: account } }, $set: { updated_at: new Date() } },
    ).exec();
  }
  return id;
}

/** Nhận diện & tạo đối tác từ một payee.name (chuỗi 3 trường). Trả null nếu không hợp lệ. */
export async function ensureCounterpartyFromLabel(
  label: string | null | undefined,
  createdBy?: string | null,
): Promise<string | null> {
  const parsed = parseCounterpartyLabel(label);
  if (!parsed) return null;
  // Bỏ qua tài khoản NỘI BỘ của tập đoàn (`Mã công ty - NH - STK`) để không làm bẩn danh bạ.
  if (await isInternalLabel(label)) return null;
  return ensureCounterparty({
    name: parsed.name,
    bank_name: parsed.bank_name,
    account_number: parsed.account_number,
    created_by: createdBy ?? null,
  });
}

/**
 * Nhãn `Tên - Ngân hàng - Số tài khoản` có trỏ tới tài khoản tiền NỘI BỘ của tập đoàn không.
 * Dùng chung cơ chế nhận diện với phiếu thu tự động khi thực thi phiếu chi.
 */
export async function isInternalLabel(label: string | null | undefined): Promise<boolean> {
  if (!parseCounterpartyLabel(label)) return false;
  return Boolean(await detectInternalTransferTarget(label));
}

/** Khớp đối tác theo tên (dùng cho phiếu công nợ — không tạo mới). */
export async function linkCounterpartyByName(partyName: string | null | undefined): Promise<string | null> {
  const key = normalizeCounterpartyName(String(partyName ?? ''));
  if (!key) return null;
  const cp = await Models.Counterparty.findOne({ name_key: key }).select({ _id: 1 }).lean<{ _id: unknown } | null>();
  return cp ? String(cp._id) : null;
}

const SCAN_LIMIT = 20_000;

/**
 * Dọn các đối tác "nội bộ" đã lỡ tạo từ tài khoản tiền của chính tập đoàn
 * (mọi tài khoản ngân hàng đều trỏ tài khoản nội bộ) + gỡ liên kết định danh.
 */
async function cleanupInternalCounterparties(): Promise<number> {
  const cps = await Models.Counterparty.find({ 'banks.0': { $exists: true } } as never)
    .select({ name: 1, banks: 1 })
    .limit(SCAN_LIMIT)
    .lean<{ _id: unknown; name?: string; banks?: { bank_name?: string; account_number?: string }[] }[]>();
  const internalIds: string[] = [];
  for (const cp of cps) {
    const banks = cp.banks ?? [];
    if (!banks.length) continue;
    let allInternal = true;
    for (const b of banks) {
      const label = formatCounterpartyLabel(String(cp.name ?? ''), String(b.bank_name ?? ''), String(b.account_number ?? ''));
      if (!(await isInternalLabel(label))) {
        allInternal = false;
        break;
      }
    }
    if (allInternal) internalIds.push(String(cp._id));
  }
  if (!internalIds.length) return 0;
  await Models.Counterparty.deleteMany({ _id: { $in: internalIds } } as never).exec();
  await Models.Document.updateMany(
    { 'payee.counterparty_id': { $in: internalIds } } as never,
    { $set: { 'payee.counterparty_id': null } } as never,
  ).exec();
  await Models.DebtVoucher.updateMany(
    { counterparty_id: { $in: internalIds } } as never,
    { $set: { counterparty_id: null } } as never,
  ).exec();
  return internalIds.length;
}

/**
 * Quét toàn bộ phiếu thu/chi + phiếu công nợ để tạo đối tác và đồng bộ định danh.
 * Idempotent — chạy an toàn nhiều lần. Chỉ xử lý dữ liệu hợp lệ theo chuẩn 3 trường,
 * và BỎ QUA tài khoản nội bộ của tập đoàn.
 */
export async function syncCounterparties(
  log?: (msg: string) => void,
): Promise<{ partners: number; documents: number; debts: number; removed: number }> {
  const removed = await cleanupInternalCounterparties();

  const docs = await Models.Document.find({
    kind: { $in: ['spend', 'income'] },
    'payee.name': { $type: 'string', $ne: '' },
  } as never)
    .select({ 'payee.name': 1 })
    .limit(SCAN_LIMIT)
    .lean<{ _id: unknown; payee?: { name?: string } }[]>();

  // gom nhãn duy nhất → id đối tác (giảm query/update trùng).
  const labelToId = new Map<string, string>();
  for (const d of docs) {
    const label = String(d.payee?.name ?? '').trim();
    if (!label || labelToId.has(label)) continue;
    const id = await ensureCounterpartyFromLabel(label, null);
    if (id) labelToId.set(label, id);
  }

  let documents = 0;
  for (const [label, id] of labelToId) {
    const res = await Models.Document.updateMany(
      { kind: { $in: ['spend', 'income'] }, 'payee.name': label, 'payee.counterparty_id': { $ne: id } } as never,
      { $set: { 'payee.counterparty_id': id } } as never,
    ).exec();
    documents += res.modifiedCount ?? 0;
  }

  // phiếu công nợ: chỉ khớp theo tên với danh bạ hiện có (không tạo mới).
  const debts = await Models.DebtVoucher.find({ party_name: { $type: 'string', $ne: '' } } as never)
    .select({ party_name: 1, counterparty_id: 1 })
    .limit(SCAN_LIMIT)
    .lean<{ _id: unknown; party_name?: string; counterparty_id?: unknown }[]>();
  let debtsChanged = 0;
  for (const dv of debts) {
    const id = await linkCounterpartyByName(dv.party_name);
    if (id && String(dv.counterparty_id ?? '') !== id) {
      await Models.DebtVoucher.updateOne({ _id: dv._id } as never, { $set: { counterparty_id: id } } as never).exec();
      debtsChanged++;
    }
  }

  const partners = await Models.Counterparty.countDocuments({}).exec();
  log?.(
    `[counterparty] quét ${docs.length} phiếu, ${debts.length} phiếu công nợ → ${partners} đối tác ` +
      `(cập nhật ${documents} phiếu, ${debtsChanged} công nợ, dọn ${removed} nội bộ)`,
  );
  return { partners, documents, debts: debtsChanged, removed };
}
