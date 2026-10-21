import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_RULE_CODES,
  AUTOMATION_RULE_LABEL,
  BANK_DEBT_STATUS_KEYS,
  BANK_DEBT_STATUS_REGISTRY,
  BUSINESS_LINK_RELATION_LABEL,
  BUSINESS_LINK_RELATIONS,
  PARTNER_TYPE_LABEL,
  PARTNER_TYPES,
  bankDebtStatusLabel,
  bankDebtStatusTone,
} from '../src/status/index.js';
import { PERMISSIONS, PERMISSION_LABEL, ROLE_PERMISSIONS, buildEntitlements, permissionsForRole } from '../src/permissions/index.js';
import { normalizeNameKey } from '../src/contracts/common.js';
import { partnerCreateBody, partnerSearchQuery, partnerUpdateBody } from '../src/contracts/partners.js';
import { tagCreateBody, tagMergeBody } from '../src/contracts/tags.js';
import { linkCreateBody, linkSplit } from '../src/contracts/links.js';
import { automationRuleUpdateBody, automationRunRow } from '../src/contracts/automation.js';
import { documentCreateBody, documentDetail } from '../src/contracts/documents.js';
import { bankDebtRow, bankDebtStatus, debtListQuery, debtVoucherUpsertBody } from '../src/contracts/finance.js';
import { TASK_NAMES } from '../src/contracts/admin.js';
import { PROBLEM_CATALOG } from '../src/errors/index.js';

const OID = 'a'.repeat(24);
const OID2 = 'b'.repeat(24);

describe('v2 — quyền mặc định theo chức danh (v2/v2.md §3.2)', () => {
  it('tag:create = ai có doc:create (staff, KTT, GĐ)', () => {
    for (const role of ['staff', 'chief_accountant', 'director'] as const) {
      expect(permissionsForRole(role)).toContain('tag:create');
    }
    expect(permissionsForRole('deputy_director')).not.toContain('tag:create');
    expect(permissionsForRole('chairman')).not.toContain('tag:create');
  });

  it('tag:manage chỉ Kế toán trưởng', () => {
    expect(permissionsForRole('chief_accountant')).toContain('tag:manage');
    expect(permissionsForRole('staff')).not.toContain('tag:manage');
    expect(permissionsForRole('director')).not.toContain('tag:manage');
  });

  it('automation:config chỉ Chủ tịch và Admin', () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]) {
      const has = permissionsForRole(role).includes('automation:config');
      expect(has).toBe(role === 'chairman' || role === 'admin');
    }
  });

  it('link:manage = KTV và KTT', () => {
    expect(permissionsForRole('staff')).toContain('link:manage');
    expect(permissionsForRole('chief_accountant')).toContain('link:manage');
    expect(permissionsForRole('director')).not.toContain('link:manage');
  });

  it('partner:read: cấp điều hành được xem đối tác (§3.2 "xem")', () => {
    for (const role of ['deputy_director', 'director', 'deputy_chairman', 'chairman'] as const) {
      expect(permissionsForRole(role)).toContain('partner:read');
      expect(permissionsForRole(role)).not.toContain('partner:write');
    }
  });

  it('mọi quyền đều có nhãn tiếng Việt và entitlement trả quyền mới', () => {
    for (const p of PERMISSIONS) expect(PERMISSION_LABEL[p].length).toBeGreaterThan(3);
    const e = buildEntitlements({ role: 'staff', company_id: OID });
    expect(e.actions['link:manage']).toBe(true);
    expect(e.actions['automation:config']).toBe(false);
  });
});

describe('v2 — registry trạng thái & nhãn', () => {
  it('khoản nợ NH có đủ 6 trạng thái, chờ giải ngân không phải danger', () => {
    expect(BANK_DEBT_STATUS_KEYS).toEqual(expect.arrayContaining(['pending_disbursement', 'active', 'overdue', 'settled', 'archived', 'cancelled']));
    expect(bankDebtStatusLabel('pending_disbursement')).toBe('Chờ giải ngân');
    expect(bankDebtStatusLabel('cancelled')).toBe('Đã huỷ');
    expect(bankDebtStatusTone('pending_disbursement')).not.toBe('danger');
    expect(bankDebtStatusLabel('weird')).toBe('weird');
    expect(BANK_DEBT_STATUS_REGISTRY.settled.terminal).toBe(true);
  });

  it('quan hệ liên kết, loại đối tác, quy tắc đều có nhãn', () => {
    for (const r of BUSINESS_LINK_RELATIONS) expect(BUSINESS_LINK_RELATION_LABEL[r].length).toBeGreaterThan(3);
    for (const t of PARTNER_TYPES) expect(PARTNER_TYPE_LABEL[t].length).toBeGreaterThan(3);
    expect(AUTOMATION_RULE_CODES).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    expect(AUTOMATION_RULE_LABEL.R3).toBe('Vay ngân hàng để chi');
  });

  it('mã lỗi v2 có status + tiêu đề', () => {
    for (const code of ['FG-PARTNER-001', 'FG-PARTNER-002', 'FG-PARTNER-003', 'FG-TAG-001', 'FG-LINK-001', 'FG-LINK-002', 'FG-LINK-003', 'FG-AUTO-001'] as const) {
      expect(PROBLEM_CATALOG[code].titleVi.length).toBeGreaterThan(3);
    }
  });

  it("TASK_NAMES có 'automation' để GitHub Actions gọi được", () => {
    expect(TASK_NAMES).toContain('automation');
  });
});

describe('v2 — contract đối tác / tag / liên kết / quy tắc', () => {
  it('nhận đối tác ngân hàng, cắt khoảng trắng tên; từ chối loại lạ và tên quá ngắn', () => {
    const ok = partnerCreateBody.parse({ type: 'bank', name: '  BIDV – CN Đông Đô ', bank_name: 'BIDV', account_number: '1234' });
    expect(ok.name).toBe('BIDV – CN Đông Đô');
    expect(ok.status).toBe('active');
    expect(partnerCreateBody.safeParse({ type: 'foo', name: 'Abc' }).success).toBe(false);
    expect(partnerCreateBody.safeParse({ type: 'customer', name: 'A' }).success).toBe(false);
  });

  it('cập nhật đối tác cho phép đổi một trường; tìm kiếm nhận một hoặc nhiều loại', () => {
    expect(partnerUpdateBody.parse({ note: 'ghi chú' })).toEqual({ note: 'ghi chú' });
    expect(partnerSearchQuery.parse({ type: 'bank' }).type).toBe('bank');
    expect(partnerSearchQuery.parse({ type: ['customer', 'supplier'] }).type).toEqual(['customer', 'supplier']);
    expect(partnerSearchQuery.parse({}).limit).toBe(20);
  });

  it('chuẩn hoá khoá tên: gộp khoảng trắng, không phân biệt hoa thường', () => {
    expect(normalizeNameKey('  Cty   ABC ')).toBe('cty abc');
    expect(normalizeNameKey('Cty ABC')).toBe(normalizeNameKey('cty  abc'));
  });

  it('tag: tên rỗng và màu sai bị chặn; gộp hai tag khác nhau', () => {
    expect(tagCreateBody.safeParse({ name: '   ' }).success).toBe(false);
    expect(tagCreateBody.safeParse({ name: 'Dự án X', color: 'red' }).success).toBe(false);
    expect(tagCreateBody.parse({ name: 'Dự án X', color: '#22aa33' }).name).toBe('Dự án X');
    expect(tagMergeBody.safeParse({ source_id: OID, target_id: OID }).success).toBe(false);
    expect(tagMergeBody.safeParse({ source_id: OID, target_id: OID2 }).success).toBe(true);
  });

  it('liên kết: tổng gốc + lãi + phí phải bằng số tiền; offset cần số tiền; không liên kết chính nó', () => {
    expect(linkSplit.parse({ principal: '100' })).toEqual({ principal: '100', interest: '0', fee: '0' });
    const base = { from_type: 'document', from_id: OID, to_type: 'bank_debt', to_id: OID2 };
    expect(linkCreateBody.safeParse({ ...base, relation: 'repayment', amount_minor: '100', split: { principal: '60', interest: '30', fee: '5' } }).success).toBe(false);
    expect(linkCreateBody.safeParse({ ...base, relation: 'repayment', amount_minor: '95', split: { principal: '60', interest: '30', fee: '5' } }).success).toBe(true);
    expect(linkCreateBody.safeParse({ from_type: 'document', from_id: OID, to_type: 'debt_voucher', to_id: OID2, relation: 'offset' }).success).toBe(false);
    expect(linkCreateBody.safeParse({ from_type: 'document', from_id: OID, to_type: 'document', to_id: OID, relation: 'generated' }).success).toBe(false);
    expect(linkCreateBody.safeParse({ ...base, relation: 'funded_by', amount_minor: '-5' }).success).toBe(false);
  });

  it('bản ghi automation_run và rule update hợp lệ; cập nhật rỗng bị chặn', () => {
    expect(automationRuleUpdateBody.safeParse({}).success).toBe(false);
    expect(automationRuleUpdateBody.parse({ enabled: false }).enabled).toBe(false);
    const row = automationRunRow.parse({
      _id: OID,
      rule_code: 'R3',
      company_id: OID2,
      source_type: 'spend',
      source_id: OID,
      event_type: 'voucher.approved',
      idem_key: `R3:${OID}:voucher.approved`,
      status: 'failed',
      steps: [{ name: 'create_loan', status: 'done', output_type: 'bank_debt', output_id: OID2, error: null, at: null }],
      error: 'boom',
      attempts: 1,
      created_at: '2026-10-21T00:00:00.000Z',
      updated_at: '2026-10-21T00:00:00.000Z',
    });
    expect(row.steps[0]?.status).toBe('done');
  });
});

describe('v2 — mở rộng hợp đồng cũ (tương thích v1)', () => {
  const v1Spend = {
    kind: 'spend',
    title: 'Thanh toán NCC',
    purpose: 'Mua vật tư',
    payee: { name: 'Công ty ABC' },
    amount: { amount_minor: '1000000', currency: 'VND' },
    source: { fund: 'bank', account_id: OID },
    planned_date: '2026-10-21',
  };

  it('body v1 (payee tự do) không còn đủ: phiếu thu/chi cần đối tác theo ID (payee bị bỏ qua)', () => {
    expect(documentCreateBody.safeParse(v1Spend).success).toBe(false);
    expect(documentCreateBody.safeParse({ ...v1Spend, partner_id: OID }).success).toBe(true);
  });

  it('phiếu vay để chi (R3) bắt buộc NH cho vay và TK nhận giải ngân', () => {
    const missing = documentCreateBody.safeParse({ ...v1Spend, options: { loan: { kind: 'fund', mode: 'new' } } });
    expect(missing.success).toBe(false);
    const ok = documentCreateBody.safeParse({
      ...v1Spend,
      partner_id: OID,
      tag_ids: [OID2],
      options: { loan: { kind: 'fund', mode: 'new', lender_partner_id: OID2, receive_account_id: OID, terms: { term_months: 12 } } },
      transfer_target: null,
    });
    expect(ok.success).toBe(true);
  });

  it('phiếu thu đi vay (R2) chọn chế độ "để sau" không cần ngân hàng', () => {
    const r = documentCreateBody.safeParse({ ...v1Spend, kind: 'income', partner_id: OID, options: { loan: { kind: 'borrow', mode: 'later' } } });
    expect(r.success).toBe(true);
  });

  it('công nợ và khoản nợ NH nhận partner_id, hướng công nợ và trạng thái mới', () => {
    expect(debtVoucherUpsertBody.parse({ party_type: 'customer', party_name: 'Khách A', partner_id: OID, direction: 'payable', side: 'credit', value: { amount_minor: '5', currency: 'VND' }, due_date: '2026-11-01' }).direction).toBe('payable');
    expect(debtListQuery.parse({ direction: 'receivable' }).direction).toBe('receivable');
    expect(bankDebtStatus.parse('pending_disbursement')).toBe('pending_disbursement');
    expect(bankDebtStatus.safeParse('unknown').success).toBe(false);
    const row = bankDebtRow.safeParse({
      _id: OID,
      company_id: OID2,
      company_name: 'Cty',
      code: 'NHD-2026-00001',
      bank_name: 'BIDV',
      principal: { minor: '100', currency: 'VND', decimals: 0 },
      credit_limit: { minor: '0', currency: 'VND', decimals: 0 },
      outstanding: { minor: '100', currency: 'VND', decimals: 0 },
      repaid: { minor: '0', currency: 'VND', decimals: 0 },
      currency: 'VND',
      interest_rate: '0',
      term_months: 12,
      payment_frequency: 'maturity',
      repayment_method: 'interest_only',
      interest_to_maturity: { minor: '0', currency: 'VND', decimals: 0 },
      maturity_date: '2027-10-21',
      next_due_date: null,
      days_to_due: 365,
      status: 'pending_disbursement',
      attachment_count: 0,
      repayment_count: 0,
      created_at: null,
      updated_at: '2026-10-21T00:00:00.000Z',
      partner_id: OID,
      disbursed_at: null,
    });
    expect(row.success).toBe(true);
  });

  it('chi tiết hồ sơ đọc được origin và partner (nếu có)', () => {
    // Chỉ kiểm tra khoá mới tồn tại trong shape (đối tượng đầy đủ không cần dựng lại ở đây).
    const shape = documentDetail.shape;
    expect(shape).toHaveProperty('partner');
    expect(shape).toHaveProperty('origin');
    expect(shape).toHaveProperty('tag_ids');
  });
});
