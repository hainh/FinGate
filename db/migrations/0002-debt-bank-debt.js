/**
 * 0002 — thay module công nợ/vay cũ bằng phiếu công nợ + nợ ngân hàng.
 *
 * Xoá hai collection cũ `debt_items` (đã thay bằng `debt_vouchers`) và `loans`
 * (đã thay bằng `bank_debts`). Không migrate dữ liệu: đây là thay đổi mô hình
 * theo yêu cầu (bỏ code cũ, seed lại dữ liệu demo).
 */

export async function up(conn) {
  for (const name of ['debt_items', 'loans']) {
    const exists = await conn.db.listCollections({ name }).hasNext().catch(() => false);
    if (exists) {
      await conn.dropCollection(name);
      console.log(`· đã xoá collection cũ ${name}`);
    }
  }
  // index cũ nếu còn sót (collection đã drop thì vô hại)
  await conn.collection('loans').dropIndexes().catch(() => undefined);
  await conn.collection('debt_items').dropIndexes().catch(() => undefined);
}
