/**
 * 0003 — đồng bộ `next_due_date` của nợ ngân hàng về `maturity_date`.
 *
 * Trạng thái "Quá hạn" và bảng Đáo hạn trước đây ưu tiên `next_due_date`, nhưng field
 * này chỉ được gán một lần lúc tạo và KHÔNG được cập nhật khi sửa hạn thanh toán. Các
 * khoản đã từng đổi hạn vì thế giữ ngày cũ → hiển thị "Đang vay" dù đã qua hạn.
 *
 * Logic đọc nay đã dùng `maturity_date`; migration này dọn lại dữ liệu để field không
 * còn lệch (giữ tương thích lùi — không đổi cấu trúc, chỉ ghi field).
 */

export async function up(conn) {
  const r = await conn.collection('bank_debts').updateMany(
    { $expr: { $ne: ['$next_due_date', '$maturity_date'] } },
    [{ $set: { next_due_date: '$maturity_date' } }],
  );
  console.log(`· đồng bộ next_due_date cho ${r.modifiedCount} khoản nợ ngân hàng`);
}