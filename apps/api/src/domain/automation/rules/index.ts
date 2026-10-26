/**
 * Điểm đăng ký bộ xử lý quy tắc tự động (v2/v2.md §11.3: R1–R7).
 *
 * Mỗi quy tắc là MỘT module riêng gọi `registerRule(code, { steps, occurrenceEvents? })` khi được import.
 * File này là nơi TẬP TRUNG các import đó; `server.ts` import file này một lần lúc khởi động (trước khi chu kỳ
 * tự động chạy). Quy tắc chưa đăng ký ⇒ engine bỏ qua (không tạo lượt chạy).
 *
 * Đường xử lý v1 đã được thay thế: phiếu chi có đích nội bộ → R1 (không còn `createAutoIncomeForSpend`);
 * phiếu thu cờ `create_bank_debt` → R2 (không còn `createAutoBankDebtForIncome`).
 */

import './r1-internal-transfer.ts';
import './r2-borrow-receipt.ts';
import './r3-fund-by-loan.ts';
import './r4-loan-settled.ts';
import './r5-recurring.ts';
import './r6-cancel-generated.ts';
import './r7-offset-on-approval.ts';

export {};
