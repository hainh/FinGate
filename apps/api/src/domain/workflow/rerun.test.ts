/**
 * Hồi quy cho lỗi PC-2026-00360 (phiếu chi quỹ tiền mặt đang chờ PGĐ biến mất khỏi "Chờ tôi duyệt"):
 *
 * `rerunPendingApprovals` chỉ nạp một projection của hồ sơ. Trước đây projection THIẾU `source` nên
 * `fundOfDoc(doc)` luôn trả `null` → `resolveMatrix` coi hồ sơ quỹ tiền mặt là phiếu NGÂN HÀNG và
 * dựng LẠI bước Kế toán trưởng (vừa được bỏ theo cài đặt "Duyệt tiền mặt"). Hồ sơ quay về bước KTT
 * rồi bị lưới an toàn của "Chờ tôi duyệt" ẩn khỏi mọi người.
 */
import { describe, expect, it } from 'vitest';
import { RERUN_DOC_PROJECTION } from './rerun.ts';

describe('rerunPendingApprovals — projection nạp hồ sơ đang chờ', () => {
  it('nạp `source` để `fundOfDoc`/`resolveMatrix` áp đúng cài đặt "Duyệt tiền mặt"', () => {
    expect(RERUN_DOC_PROJECTION.source).toBe(1);
  });

  it('nạp đủ các trường `rerunOne` đọc: loại, công ty, số tiền, trạng thái, version, chuỗi duyệt', () => {
    expect(RERUN_DOC_PROJECTION.kind).toBe(1);
    expect(RERUN_DOC_PROJECTION.company_id).toBe(1);
    expect(RERUN_DOC_PROJECTION.amount).toBe(1);
    expect(RERUN_DOC_PROJECTION.status).toBe(1);
    expect(RERUN_DOC_PROJECTION.version).toBe(1);
    expect(RERUN_DOC_PROJECTION.approval).toBe(1);
  });
});
