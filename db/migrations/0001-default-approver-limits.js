/**
 * 0001 — hạn mức duyệt mặc định cho assignment.
 *
 * Các luồng mời / kích hoạt / chuyển công ty trước đây ghi `amount_limit_minor = 0`
 * bất kể chức danh, khiến người duyệt bị chặn `FG-RBAC-012` với mọi khoản > 0
 * (UI ẩn nút Duyệt vì `can.approve = false`). Chỉ nâng các assignment đang ở mức 0
 * thuộc chức danh có hạn mức mặc định > 0 — không đụng mức đã cấu hình thủ công.
 *
 * Giá trị khớp `DEFAULT_AMOUNT_LIMIT_MINOR` (packages/shared/src/permissions) tại
 * thời điểm migration; cố tình hard-code để migration là ảnh chụp bất biến.
 */

const DEFAULTS = {
  chief_accountant: 50_000_000_000n,
  deputy_director: 50_000_000_000n,
  director: 50_000_000_000n,
  chairman: 999_999_999_000_000_000n,
};

export async function up(conn) {
  const assignments = conn.collection('assignments');
  let updated = 0;
  for (const [role, limit] of Object.entries(DEFAULTS)) {
    const r = await assignments.updateMany(
      { role, amount_limit_minor: { $lte: 0 } },
      { $set: { amount_limit_minor: limit } },
    );
    updated += r.modifiedCount;
  }
  console.log(`· nâng hạn mức mặc định theo chức danh cho ${updated} assignment`);
}
