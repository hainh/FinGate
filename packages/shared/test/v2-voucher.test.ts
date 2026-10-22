import { describe, expect, it } from 'vitest';
import {
  documentCreateBody,
  documentLinkCreateBody,
  documentLinkItem,
  documentListQuery,
  documentTagsBody,
  documentUpdateBody,
  queueProcessedQuery,
} from '../src/contracts/documents.js';

const OID = 'a'.repeat(24);
const OID2 = 'b'.repeat(24);
const UUID = '123e4567-e89b-42d3-a456-426614174000';

/** Phiếu chi tối thiểu (không đối tác) — để kiểm riêng quy tắc đối tác. */
const spend = {
  kind: 'spend',
  title: 'Thanh toán NCC',
  purpose: 'Mua vật tư',
  amount: { amount_minor: '1000000', currency: 'VND' },
  source: { fund: 'bank', account_id: OID },
  planned_date: '2026-10-21',
};

describe('v2 — phiếu thu/chi: đối tác theo ID là bắt buộc khi lập', () => {
  it('phiếu chi không có partner_id bị chặn, kể cả khi còn gửi payee tự do (payee bị bỏ qua)', () => {
    expect(documentCreateBody.safeParse(spend).success).toBe(false);
    expect(documentCreateBody.safeParse({ ...spend, payee: { name: 'Tự do' } }).success).toBe(false);
    expect(documentCreateBody.safeParse({ ...spend, partner_id: OID }).success).toBe(true);
  });

  it('phiếu thu cũng bắt buộc partner_id', () => {
    const income = { ...spend, kind: 'income' };
    expect(documentCreateBody.safeParse(income).success).toBe(false);
    expect(documentCreateBody.safeParse({ ...income, partner_id: OID }).success).toBe(true);
  });

  it('phiếu chuyển nội bộ không bị buộc đối tác (vẫn cần công ty nhận)', () => {
    const internal = { ...spend, kind: 'internal' };
    expect(documentCreateBody.safeParse({ ...internal, target: { company_id: OID2 } }).success).toBe(true);
    expect(documentCreateBody.safeParse({ ...internal, transfer_target: { company_id: OID2, account_id: OID } }).success).toBe(true);
    expect(documentCreateBody.safeParse(internal).success).toBe(false);
  });

  it('tối đa 50 tag cho một phiếu', () => {
    expect(documentCreateBody.safeParse({ ...spend, partner_id: OID, tag_ids: Array(50).fill(OID) }).success).toBe(true);
    expect(documentCreateBody.safeParse({ ...spend, partner_id: OID, tag_ids: Array(51).fill(OID) }).success).toBe(false);
  });
});

describe('v2 — chuyển nội bộ theo ID: phải chọn cả công ty và TK đích khi lưu (§11.6)', () => {
  const internal = { ...spend, kind: 'internal' };

  it('tạo phiếu: TK đích thiếu hoặc null bị chặn; đủ công ty + TK thì qua; không chuyển nội bộ (null) vẫn qua', () => {
    expect(documentCreateBody.safeParse({ ...internal, transfer_target: { company_id: OID2, account_id: null } }).success).toBe(false);
    expect(documentCreateBody.safeParse({ ...internal, transfer_target: { company_id: OID2 } }).success).toBe(false);
    expect(documentCreateBody.safeParse({ ...internal, transfer_target: { company_id: OID2, account_id: OID } }).success).toBe(true);
    expect(documentCreateBody.safeParse({ ...spend, partner_id: OID, transfer_target: null }).success).toBe(true);
  });

  it('sửa phiếu: không nhận TK đích null; bỏ chuyển nội bộ (null) vẫn được', () => {
    expect(documentUpdateBody.safeParse({ transfer_target: { company_id: OID2, account_id: null }, if_match: 3, request_id: UUID }).success).toBe(false);
    expect(documentUpdateBody.safeParse({ transfer_target: { company_id: OID2, account_id: OID }, if_match: 3, request_id: UUID }).success).toBe(true);
    expect(documentUpdateBody.safeParse({ transfer_target: null, if_match: 3, request_id: UUID }).success).toBe(true);
  });
});

describe('v2 — lọc danh sách theo đối tác và tag', () => {
  it('partner_id phải là ObjectId; tag_ids nhận chuỗi phân tách dấu phẩy hoặc mảng', () => {
    expect(documentListQuery.parse({ partner_id: OID }).partner_id).toBe(OID);
    expect(documentListQuery.safeParse({ partner_id: 'khong-hop-le' }).success).toBe(false);
    expect(documentListQuery.parse({ tag_ids: `${OID},${OID2}` }).tag_ids).toBe(`${OID},${OID2}`);
    expect(documentListQuery.parse({ tag_ids: [OID, OID2] }).tag_ids).toEqual([OID, OID2]);
  });
});

describe('v2 — sửa tag của phiếu (PATCH /documents/:id/tags)', () => {
  it('cần if_match và request_id; tag rỗng là hợp lệ (gỡ hết tag)', () => {
    expect(documentTagsBody.safeParse({ tag_ids: [OID], if_match: 3, request_id: UUID }).success).toBe(true);
    expect(documentTagsBody.safeParse({ tag_ids: [], if_match: 3, request_id: UUID }).success).toBe(true);
    expect(documentTagsBody.safeParse({ tag_ids: [OID], request_id: UUID }).success).toBe(false);
    expect(documentTagsBody.safeParse({ tag_ids: [OID] }).success).toBe(false);
    expect(documentTagsBody.safeParse({ tag_ids: Array(51).fill(OID), if_match: 3, request_id: UUID }).success).toBe(false);
  });
});

describe('v2 — liên kết thủ công từ phiếu (POST /documents/:id/links)', () => {
  it('cấn trừ chỉ nối tới khoản công nợ; trả nợ / giải ngân nối tới khoản nợ NH', () => {
    expect(documentLinkCreateBody.safeParse({ relation: 'offset', to_id: OID, amount_minor: '100' }).success).toBe(true);
    expect(documentLinkCreateBody.safeParse({ relation: 'offset', to_type: 'bank_debt', to_id: OID, amount_minor: '100' }).success).toBe(false);
    expect(documentLinkCreateBody.safeParse({ relation: 'repayment', to_type: 'bank_debt', to_id: OID, amount_minor: '100' }).success).toBe(true);
    expect(documentLinkCreateBody.safeParse({ relation: 'disbursement', to_type: 'debt_voucher', to_id: OID, amount_minor: '100' }).success).toBe(false);
  });

  it('chỉ tách gốc/lãi/phí khi trả nợ, và tổng tách phải bằng số tiền', () => {
    const repay = { relation: 'repayment', to_id: OID };
    expect(documentLinkCreateBody.safeParse({ ...repay, amount_minor: '95', split: { principal: '60', interest: '30', fee: '5' } }).success).toBe(true);
    expect(documentLinkCreateBody.safeParse({ ...repay, amount_minor: '100', split: { principal: '60', interest: '30', fee: '5' } }).success).toBe(false);
    expect(documentLinkCreateBody.safeParse({ relation: 'offset', to_id: OID, split: { principal: '1' } }).success).toBe(false);
  });

  it('phải có số tiền phân bổ (hoặc tách)', () => {
    expect(documentLinkCreateBody.safeParse({ relation: 'disbursement', to_type: 'bank_debt', to_id: OID }).success).toBe(false);
    expect(documentLinkCreateBody.safeParse({ relation: 'repayment', to_id: OID, split: { principal: '5' } }).success).toBe(true);
  });
});

describe('v2 — liên kết trong chi tiết phiếu (hai chiều)', () => {
  it('mục liên kết mang hướng và đối tượng bên kia (có thể bị ẩn ngoài phạm vi)', () => {
    const item = documentLinkItem.parse({
      _id: OID,
      company_id: OID2,
      from_type: 'document',
      from_id: OID,
      to_type: 'bank_debt',
      to_id: OID2,
      relation: 'repayment',
      amount_minor: '95',
      split: { principal: '60', interest: '30', fee: '5' },
      origin: 'manual',
      run_id: null,
      status: 'active',
      note: null,
      created_by: OID,
      created_at: '2026-10-21T00:00:00.000Z',
      removed_by: null,
      removed_at: null,
      removed_reason: null,
      direction: 'out',
      counterpart: { type: 'bank_debt', id: OID2, code: null, status: null, total_minor: null, partner_id: null, partner_name: null, visible: false },
    });
    expect(item.direction).toBe('out');
    expect(item.counterpart.visible).toBe(false);
  });
});

describe('phân trang danh sách phiếu (FgPagination: page + limit, không cursor)', () => {
  it('documentListQuery: trang mặc định 1, cỡ trang mặc định 50; page đọc từ chuỗi (URL)', () => {
    const d = documentListQuery.parse({});
    expect(d.page).toBe(1);
    expect(d.limit).toBe(50);
    expect(documentListQuery.parse({ page: '3', limit: '100' })).toMatchObject({ page: 3, limit: 100 });
    expect(documentListQuery.safeParse({ page: '0' }).success).toBe(false);
    expect(documentListQuery.safeParse({ limit: '500' }).success).toBe(false);
  });

  it('queueProcessedQuery (tôi đã duyệt): ô tìm + trang + cỡ trang', () => {
    expect(queueProcessedQuery.parse({})).toMatchObject({ page: 1, limit: 50 });
    expect(queueProcessedQuery.parse({ q: 'PC', page: '2', limit: '20' })).toMatchObject({ q: 'PC', page: 2, limit: 20 });
  });
});
