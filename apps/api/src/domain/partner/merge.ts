/**
 * Gộp đối tác (v2/v2.md §5.1) — phần THUẦN: điều kiện được gộp và thông tin danh bạ sau gộp.
 * Không chạm DB (kiểm thử được). Phần chuyển tham chiếu và ghi DB nằm ở `mergePartners` (index.ts).
 *
 * - Đối tác NGUỒN được gộp vào đối tác ĐÍCH: mọi tham chiếu chuyển sang đích, rồi nguồn bị xoá; đích giữ lại.
 * - Chỉ gộp trong MỘT công ty, giữa hai đối tác CÙNG LOẠI.
 * - Đối tác công ty trong tập đoàn không gộp: mỗi TK gốc là một đối tác, tên / STK lấy từ TK gốc.
 * - Đích phải đang hoạt động (sẽ nhận phiếu / công nợ mới). Nguồn có thể đang ngừng giao dịch.
 */

import { ApiError, type PartnerType } from '@fingate/shared';
import type { PartnerSnapshot } from './rules.ts';

/** Thông tin tối thiểu để kiểm điều kiện gộp. */
export interface MergeCandidate {
  _id: string;
  company_id: string;
  type: PartnerType;
  status: 'active' | 'inactive';
}

/** Lỗi không gộp được theo trường (tiếng Việt). Null ⇒ được gộp. */
export function mergeProblems(source: MergeCandidate, target: MergeCandidate): Record<string, string> | null {
  if (source.type === 'internal' || target.type === 'internal') {
    return { type: 'Đối tác công ty trong tập đoàn không gộp — mỗi tài khoản gốc là một đối tác' };
  }
  if (source._id === target._id) return { target_id: 'Chọn một đối tác khác để gộp vào' };
  if (source.company_id !== target.company_id) return { target_id: 'Hai đối tác phải thuộc cùng một công ty' };
  if (source.type !== target.type) return { target_id: 'Chỉ gộp các đối tác cùng loại' };
  if (target.status !== 'active') return { target_id: 'Đối tác đích đang ngừng giao dịch — kích hoạt lại trước khi gộp' };
  return null;
}

/** Ném `FG-VAL-001` (kèm chi tiết từng trường) nếu hai đối tác không gộp được. */
export function assertMergeable(source: MergeCandidate, target: MergeCandidate): void {
  const errors = mergeProblems(source, target);
  if (errors) throw new ApiError({ code: 'FG-VAL-001', detail: Object.values(errors)[0], errors });
}

/**
 * Thông tin danh bạ của đích sau gộp (thuần). Đích giữ tên, loại, trạng thái.
 * Phần còn TRỐNG ở đích được lấy từ nguồn: MST; cặp NH + STK (chỉ khi đích chưa có STK).
 * Ghi chú của nguồn được nối vào ghi chú đích, không mất.
 */
export function mergedMasterFields(target: PartnerSnapshot, source: PartnerSnapshot, sourceLabel: string): PartnerSnapshot {
  const next: PartnerSnapshot = { ...target, tax_code: target.tax_code ?? source.tax_code };
  if (!target.account_number && source.account_number) {
    next.bank_name = source.bank_name;
    next.account_number = source.account_number;
  }
  if (source.note) next.note = target.note ? `${target.note}\nGộp từ ${sourceLabel}: ${source.note}` : source.note;
  return next;
}
