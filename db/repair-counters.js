#!/usr/bin/env node
/**
 * `pnpm db:repair-counters` — đồng bộ bộ đếm mã `counters` theo mã LỚN NHẤT đã có trong dữ liệu.
 *
 * Vì sao cần: mã phiếu / đối tác / khoản vay sinh bằng `$inc` trên collection `counters` (`nextSequentialCode`).
 * Khi dữ liệu được khôi phục từ bản dump mà `counters` KHÔNG được khôi phục cùng (hoặc khôi phục từ bản cũ hơn),
 * bộ đếm nằm SAU mã lớn nhất đang có ⇒ lần tạo kế tiếp sinh mã trùng ⇒ Mongo E11000 ⇒ API trả 500
 * "Hệ thống đang gặp sự cố. Vui lòng thử lại." cho MỌI lần tạo (đối tác / phiếu / khoản vay / công nợ),
 * không liên quan đến nghiệp vụ đang làm.
 *
 * Việc làm: quét `code` của `documents` (PC/PT/DH/CN), `partners` (DT), `bank_debts` (NHD), `debt_vouchers` (CN);
 * với mỗi khoá `<PREFIX>-<YYYY>`, đặt `counters.seq` = số thứ tự lớn nhất tìm được (mã kế tiếp = max + 1).
 *
 * Nguyên tắc:
 *  - Chỉ TIẾN bộ đếm, không bao giờ lùi: seq hiện tại ≥ max ⇒ giữ nguyên.
 *  - Idempotent: chạy lại không đổi gì.
 *  - Không xoá / không sửa mã đã có trong dữ liệu; chỉ ghi `counters`.
 *
 * Chạy: `pnpm build` rồi `pnpm db:repair-counters` (thêm `--dry-run` để chỉ in ra, không ghi).
 */
import { withDb } from './_common.js';

const dryRun = process.argv.includes('--dry-run');
/** `PC-2026-00123` / `DT-2026-00001` — tiền tố chữ, năm 4 số, số thứ tự ≥ 5 số. */
const CODE_RE = /^([A-Za-z]{2,4})-(\d{4})-(\d{5,})$/;

await withDb(async (env, log) => {
  void env;
  const { Models } = await import('../apps/api/dist/db/models.js');

  /** Các collection có `code` dùng chung bộ đếm `counters` (xem domain/numbering/index.ts). */
  const collections = [
    ['documents', Models.Document],
    ['partners', Models.Partner],
    ['bank_debts', Models.BankDebt],
    ['debt_vouchers', Models.DebtVoucher],
  ];

  /** `<PREFIX>-<YYYY>` → số thứ tự lớn nhất đang có trong dữ liệu. */
  const maxByKey = new Map();
  for (const [name, model] of collections) {
    const rows = await model.aggregate([{ $match: { code: { $regex: '^[A-Za-z]{2,4}-[0-9]{4}-[0-9]{5,}$' } } }, { $group: { _id: '$code' } }]).exec();
    let count = 0;
    for (const row of rows) {
      const m = CODE_RE.exec(String(row._id));
      if (!m) continue;
      const key = `${m[1].toUpperCase()}-${m[2]}`;
      const seq = Number(m[3]);
      if (!Number.isInteger(seq)) continue;
      const current = maxByKey.get(key) ?? 0;
      if (seq > current) maxByKey.set(key, seq);
      count++;
    }
    log(`· ${name}: ${count} mã đúng dạng`);
  }

  const changes = [];
  for (const [key, max] of [...maxByKey.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const counter = await Models.Counter.findById(key).select({ seq: 1 }).lean();
    const seq = Number(counter?.seq ?? 0);
    if (seq >= max) continue;
    changes.push({ key, from: seq, to: max });
    if (!dryRun) {
      await Models.Counter.updateOne({ _id: key }, { $max: { seq: max }, $set: { updated_at: new Date() } }, { upsert: true }).exec();
    }
  }

  if (!changes.length) {
    log('✓ bộ đếm đã khớp dữ liệu — không cần sửa');
    return { changed: 0, dry_run: dryRun };
  }
  for (const c of changes) log(`${dryRun ? '[dry-run] ' : ''}${c.key}: seq ${c.from} → ${c.to} (mã kế tiếp ${c.key}-${String(c.to + 1).padStart(5, '0')})`);
  log(`· ${changes.length} bộ đếm ${dryRun ? 'sẽ được sửa' : 'đã sửa'}`);
  return { changed: changes.length, dry_run: dryRun };
});
