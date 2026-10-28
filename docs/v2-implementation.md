# FinGate v2 — Nền tảng dữ liệu & quy trình tự động (handoff cho các agent sau)

Phạm vi đã làm: đặc tả `v2/v2.md` §2 (đối tượng), §3.2 (quyền), §11.2 (liên kết + quy tắc tự động), §14 (mô hình dữ liệu), §14.3 (nguyên tắc). Đây là **lớp dữ liệu và nền tảng**: model, contract, quyền, index, domain liên kết, outbox sự kiện, bộ máy quy tắc. Chưa có route HTTP mới, chưa có UI, chưa có nghiệp vụ R1–R6 (xem mục 9).

> **Trạng thái hiện tại:** xem mục **24** (vòng hoàn thiện cuối: build, lint, test, rà soát nhất quán) và mục **25** (How to migrate). Các mục khác ghi trạng thái tại thời điểm bàn giao của từng agent; khi mâu thuẫn, mục 24 là đúng. Số đo kiểm thử trong từng mục là số lúc bàn giao mục đó. Số mục trùng (12, 18, 21) do nhiều agent đánh số độc lập — tra theo tiêu đề.

Quy ước đã áp dụng (không đổi): tiền = minor units, trên wire là chuỗi, trong DB là BigInt; `*_at` = Date UTC, ngày nghiệp vụ = `YYYY-MM-DD`; mọi truy vấn nghiệp vụ lọc `company_id`; không dùng transaction (CAS + best-effort, ADR-03).

---

## 1. Shared (`packages/shared`)

### 1.1 Quyền mới (`permissions/index.ts`)

| Quyền | Ai có mặc định | Ghi chú |
| --- | --- | --- |
| `tag:create` | `staff`, `chief_accountant`, `director` | = ai có `doc:create` |
| `tag:manage` | `chief_accountant` | đổi tên / gộp / ẩn tag |
| `automation:config` | `chairman`, `admin` | bật/tắt, chỉnh tham số quy tắc |
| `link:manage` | `staff`, `chief_accountant` | gán / gỡ liên kết thủ công |

Thêm theo §3.2 (quyền đã có, bổ sung cho cấp điều hành): `partner:read` cho `deputy_director`, `director`, `deputy_chairman`, `chairman` ("xem"). `partner:write` không đổi. Có nhãn `PERMISSION_LABEL`, nhóm `PERMISSION_GROUPS` (tag, link, automation), và `buildEntitlements().actions` có 4 khoá mới.

### 1.2 Status & nhãn (`status/index.ts`)

Hằng số enum + nhãn tiếng Việt (dùng lại ở contract, không import ngược):

- Đối tác: `PARTNER_TYPES` (`bank|customer|supplier`) + `PARTNER_TYPE_LABEL`; `PARTNER_STATUSES` (`active|inactive`) + `PARTNER_STATUS_LABEL` (`Hoạt động` / `Ngừng giao dịch`); `PARTNER_CODE_PREFIX = 'DT'`.
- Hướng công nợ: `DEBT_DIRECTIONS` (`receivable|payable`) + `DEBT_DIRECTION_LABEL`.
- Liên kết: `BUSINESS_LINK_RELATIONS` (`offset|repayment|disbursement|funded_by|generated|internal_transfer`) + `BUSINESS_LINK_RELATION_LABEL`; `LINK_OBJECT_TYPES` (`document|debt_voucher|bank_debt`) + `LINK_OBJECT_TYPE_LABEL`; `LINK_ORIGINS` (`manual|automation`); `LINK_STATUSES` (`active|removed`); `LINK_SPLIT_KEYS` (`principal|interest|fee`).
- Quy tắc & lượt: `AUTOMATION_RULE_CODES` (`R1..R7`) + `AUTOMATION_RULE_LABEL`; `AUTOMATION_RUN_STATUSES` (`pending|running|done|failed`) + `AUTOMATION_RUN_STATUS_REGISTRY`; `AUTOMATION_STEP_STATUSES` (`pending|done|failed|skipped`) + `AUTOMATION_STEP_STATUS_LABEL`.
- Khoản nợ NH (registry riêng, không trộn workflow): `BANK_DEBT_STATUSES` = `pending_disbursement | active | overdue | settled | archived | cancelled`; `BANK_DEBT_STATUS_REGISTRY`, `BANK_DEBT_STATUS_KEYS`, `bankDebtStatusLabel(key)`, `bankDebtStatusTone(key)`. `pending_disbursement` = "Chờ giải ngân" (tone attention, không tính dư nợ); `cancelled` = "Đã huỷ".
- Tuỳ chọn vay: `LOAN_KINDS` (`borrow|fund`) + `LOAN_KIND_LABEL`; `LOAN_MODES` (`new|existing|later`) + `LOAN_MODE_LABEL`; `REPAYMENT_PERIODS` + `REPAYMENT_PERIOD_LABEL`; `REPAYMENT_METHODS` (type `RepaymentMethodKey`) + `REPAYMENT_METHOD_LABEL`.
- `TAG_COLOR_DEFAULT = '#64748b'`.

### 1.3 Contract (zod) — `packages/shared/src/contracts/`

Mới (export qua `contracts/index.ts`):

- **`partners.ts`**: `partnerType`, `partnerStatus`; `partnerCreateBody` (`type`, `name` 2–200, `bank_name?`, `account_number?`, `tax_code?`, `note?`, `company_id?`, `status` mặc định `active`); `partnerUpdateBody` (partial + `status?`, `request_id?`); **`partnerDuplicateWarning`** = `{ reason: 'name'|'bank_account', partner_id, partner_code, partner_name, partner_type, message }`; `partnerSaveResult` = `{ partner: partnerRef, warnings[] }`; `partnerRef` = `{ _id, code, type, name, bank_name, account_number, tax_code, status }`; `partnerSearchQuery` (`type` là một loại hoặc mảng, `status`, `q`, `limit`=20); **`partnerSummaryRow`** = partnerRef + `company_id`, `receivable_remaining`, `payable_remaining`, `overdue_amount` (KH/NCC), `outstanding`, `next_maturity_date` (NH), `paid_in_period`, `paid_out_period`, `has_activity`, `updated_at`; `partnerDetail` = summary + `history[]`; `partnerHistoryEntry` = `{ at, actor, changes: { field: {from, to} } }`; `partnerCopyBody` (`source_company_id`, `partner_ids[]`, `target_company_id?`); `partnerCopyResult`.
- **`tags.ts`**: `tagName` (chuẩn hoá trước: bỏ ký tự vô hình, gộp khoảng trắng, trim, rồi mới kiểm 1–40 ký tự; hàm `normalizeTagDisplayName` dùng chung với domain), `TAG_COLOR_RE` (`#RRGGBB`); `tagCreateBody`; `tagUpdateBody` (ít nhất một trường); `tagMergeBody` (`source_id ≠ target_id`); `tagRow` (+ `usage_count`); `tagListQuery`.
- **`links.ts`**: `linkObjectType`, `linkRelation`, `linkOrigin`, `linkStatus`; `linkSplit` (`principal|interest|fee`, chuỗi không âm, mặc định `'0'`); `linkCreateBody` (flat: `from_type, from_id, to_type, to_id, relation, amount_minor?, split?, note?`; superRefine: tổng tách = số tiền, quan hệ mang tiền cần số tiền, không tự liên kết); `linkRemoveBody` (`reason` ≥ 5 ký tự); `linkRow`; `linkListQuery` (`object_type`, `object_id`, `include_removed?`); `linkMetrics` (discriminated union theo `object_type`: `document` → `allocated_minor`, `remaining_minor`; `debt_voucher` → `offset_applied_minor`, `remaining_minor`; `bank_debt` → `repaid_principal_minor`, `outstanding_minor`).
- **`automation.ts`**: `automationRuleCode`, `automationRunStatus`, `automationStepStatus`; `automationCompanyOverride` (`company_id`, `enabled=true`, `params`); `automationRunStep` (`name, status, output_type, output_id, error, at`); `automationRuleRow` (có `trigger_events[]`); `automationRuleUpdateBody` (ít nhất một trường); `automationRunRow`; `automationRunQuery`; `automationRerunBody`.
- `common.ts`: thêm `minorNonNeg` (chuỗi số nguyên không âm) và **`normalizeNameKey(name)`** (trim, gộp khoảng trắng, lowercase, NFC) — khoá chống trùng cho đối tác và tag.

Mở rộng (cũ giữ nguyên, thêm trường tuỳ chọn):

- **`documents.ts`** — `documentFields` (body tạo/sửa) thêm: `partner_id?` (nullable), `tag_ids?` (≤ 50), `options?: { loan? }`, `transfer_target?` (`{company_id, account_id?}`). `loanOptions` = `{ kind: borrow|fund, mode: new|existing|later (mặc định later), lender_partner_id?, receive_account_id?, amount_minor?, existing_loan_id?, terms? }` với superRefine: `mode≠later` cần ngân hàng; `fund` cần TK nhận; `existing` cần `existing_loan_id`. `loanTerms` = `{contract_no, interest_rate, term_months, due_date, repayment_period, repayment_method, collateral}`. `documentOrigin` = `{ kind: manual|automation, run_id?, rule_code? }`. `documentDetail` thêm: `partner`, `partner_id`, `tag_ids`, `tags?`, `options`, `transfer_target`, `origin`. `create_bank_debt` và `target` (v1) GIỮ NGUYÊN.
- **`finance.ts`** — `bankDebtStatus` = 6 trạng thái; `debtDirection`; `bankDebtUpsertBody.partner_id?`; `bankDebtRow` + `partner_id?`, `disbursed_at?`, `origin?`; `debtVoucherUpsertBody` + `partner_id?`, `direction?`; `debtVoucherRow` + `partner_id?`, `direction?`; `debtListQuery` + `partner_id?`, `direction?`. `party_name` (v1) còn bắt buộc (xem mục 10).
- **`admin.ts`** — `TASK_NAMES` thêm `'automation'`; `recurringUpsertBody.partner_id?`.

### 1.4 Mã lỗi & nhãn

`errors/index.ts`: `FG-PARTNER-001` (đối tác không hợp lệ cho mục này, 422), `FG-PARTNER-002` (đã phát sinh, chỉ ngừng giao dịch, 409), `FG-PARTNER-003` (không đổi loại vì vướng ràng buộc, 409), `FG-TAG-001` (tag trùng tên, 409), `FG-LINK-001` (hai đối tượng không thể liên kết theo quan hệ này, 422), `FG-LINK-002` (tổng phân bổ vượt số tiền còn lại, 422), `FG-LINK-003` (liên kết này đã tồn tại, 409), `FG-AUTO-001` (không thể chạy lại lượt này, 422).

`text/index.ts`: `UI.partner` (tạo/sửa/chọn, cảnh báo trùng, `addNew(name)`), `UI.tag` (`create(name)`, merge, hide), `UI.link` (`allocated(amount)`, `remaining(amount)`, `autoBy(rule)`), `UI.automation` (`rerun`, `failed`, `cancelledWarning(code)`…).

---

## 2. Mô hình dữ liệu (`apps/api/src/db/models.ts`)

Sub-schema dùng chung (không export): `originEmbed` (`kind` mặc định `manual`, `run_id`, `rule_code`), `loanOptionsEmbed` (`kind` bắt buộc, `mode`, `lender_partner_id`, `receive_account_id`, `amount_minor` BigInt, `existing_loan_id`, `terms`), `loanTermsEmbed`, `transferTargetEmbed` (`company_id` bắt buộc, `account_id`), `linkSplitEmbed` (`principal|interest|fee` BigInt, mặc định 0n).

### 2.1 Trường thêm vào collection cũ (đều tuỳ chọn, mặc định `null` / `[]`)

| Collection | Trường mới | Ghi chú |
| --- | --- | --- |
| `documents` | `partner_id` (ObjectId) | v1 chưa bắt buộc; route POST ghi giá trị |
| | `tag_ids` ([ObjectId]) | route POST ghi giá trị |
| | `options.loan` (loanOptionsEmbed) | CHƯA được ghi từ route (cần map BigInt) |
| | `transfer_target` (`{company_id, account_id}`) | CHƯA được ghi từ route; `target` v1 còn song song |
| | `origin` (`{kind, run_id, rule_code}`, mặc định manual) | ghi bởi bộ máy; dữ liệu v1 thiếu ⇒ coi là manual |
| `debt_vouchers` | `partner_id` (ObjectId) | route POST ghi giá trị |
| | `direction` (`receivable\|payable`) | route POST ghi giá trị; v1 = null (migrate M3b) |
| `bank_debts` | `status` enum + `pending_disbursement`, `cancelled` | mặc định vẫn `active` |
| | `partner_id` (ObjectId) | route POST/import ghi giá trị |
| | `disbursed_at` (Date UTC) | chưa ghi ở đâu (bước R2) |
| | `origin` | auto bank debt v1 ghi `{kind: automation, rule_code: 'R2'}` |
| `recurring_rules` | `partner_id` | `materializeRecurring` đọc và copy sang phiếu nháp |

### 2.2 Collection mới

- **`partners`** (`PartnerSchema`) — `company_id`*, `code` (DT-…, unique), `type` (`bank|customer|supplier`)*, `status` (`active|inactive`, mặc định active), `name`*, `name_key`* (chỉ cảnh báo trùng, KHÔNG unique), `bank_name`, `account_number`, `tax_code`, `note`, `history[]` (`{at, actor:{user_id,name}, changes: Mixed}`), `created_by`, `created_at`, `updated_at`. (`*` bắt buộc.)
- **`tags`** (`TagSchema`) — `company_id`*, `name`*, `name_key`*, `color` (mặc định `#64748b`), `hidden` (false), `created_by`, `created_at`, `updated_at`.
- **`business_links`** (`BusinessLinkSchema`, §14.1) — `company_id`*, `from_type`*, `from_id`*, `to_type`*, `to_id`*, `relation`*, `amount_minor` (BigInt, null nếu không có tiền), `split` (linkSplitEmbed, null nếu không tách), `origin` (`manual|automation`), `run_id`, `rule_code`, `status` (`active|removed`), `note`, `created_by`, `created_at`, `removed_by`, `removed_at`, `removed_reason`.
- **`domain_events`** (`DomainEventSchema`, outbox) — `type`*, `company_id`, `subject_type`*, `subject_id`, `payload` (Mixed; BigInt đã đổi thành chuỗi), `actor:{user_id,name,role}`, `created_at`, `processed_at` (null = chưa xử lý), `claimed_at` (lease), `attempts`, `last_error`.
- **`automation_rules`** (`AutomationRuleSchema`) — `code`* (unique), `name`*, `trigger_event`* (sự kiện chính), `trigger_events[]` (**thêm ngoài spec**: sự kiện bổ sung, một quy tắc có thể nghe nhiều sự kiện), `condition` (Mixed), `steps[]` (tên bước — thông tin hiển thị), `params` (Mixed), `company_overrides[]` (`{company_id, enabled=true, params}`), `company_ids[]` (rỗng = mọi công ty), `enabled`, `created_at`, `updated_at`.
- **`automation_runs`** (`AutomationRunSchema`) — `rule_id`*, `rule_code`*, `company_id`, `source_type`*, `source_id`*, `event_id`, `event_type`*, `idem_key`* (unique), `status` (`pending|running|done|failed`), `steps[]` (`{name, status, output_type, output_id, error, at}`), `error`, `attempts`, `claimed_at` (lease), `created_at`, `updated_at`.

Đăng ký trong `Models`: `Partner`, `Tag`, `BusinessLink`, `DomainEvent`, `AutomationRule`, `AutomationRun`.

Lưu ý: `PartnerSchema`, `TagSchema`, `BusinessLinkSchema`, `DomainEventSchema`, `AutomationRuleSchema` được `export const` (có thể import để test). Không khai báo index trong schema — tất cả nằm ở `db/indexes.ts`.

---

## 3. Index (`apps/api/src/db/indexes.ts`)

Áp dụng lúc boot (`applyIndexes`) và qua `pnpm db:indexes`. Mọi collection mới đã được ánh xạ trong `COLLECTION_MODEL`.

| Collection | Index | Ghi chú |
| --- | --- | --- |
| `partners` | `(company_id, type, name_key)`, `(company_id, account_number)`, `code` unique | |
| `tags` | `(company_id, name_key)` unique | chống trùng tag |
| `business_links` | `(from_type, from_id)`, `(to_type, to_id)`, `(from_id, to_id, relation)` unique **partial** `status: 'active'` | gỡ rồi tạo lại được |
| `domain_events` | `(processed_at, created_at)`; `processed_at` TTL 30 ngày | TTL chỉ dọn bản đã xử lý (null không bị xoá) |
| `automation_rules` | `code` unique | |
| `automation_runs` | `idem_key` unique; `(source_type, source_id)` | |
| `documents` (thêm) | `(company_id, partner_id)`, `(company_id, tag_ids)`, `(company_id, options.loan.lender_partner_id)` | tab đối tác; lọc theo tag; người cho vay trên phiếu chi vay (chặn xoá đối tác, `has_activity`) |
| `debt_vouchers` (thêm) | `(company_id, partner_id)` | tab công nợ của đối tác |
| `bank_debts` (thêm) | `(company_id, partner_id)` | tab nợ NH của đối tác |

---

## 4. Mã số (`domain/numbering`)

`nextPartnerCode(at = new Date()): Promise<string>` → `DT-2026-00001` (cùng bộ đếm `counters` theo năm, `nextSequentialCode('DT', …)`). Chưa được gọi ở đâu — màn Đối tác sẽ gọi khi tạo.

---

## 5. Liên kết nghiệp vụ (`domain/links/index.ts`)

### 5.1 Quy tắc theo quan hệ (`RELATION_SPECS`)

| Quan hệ | Từ → Đến | Điều kiện bổ sung |
| --- | --- | --- |
| `offset` | phiếu (spend/income) → công nợ | đối tác khớp; đối tác đích là KH/NCC; cùng công ty; có số tiền |
| `repayment` | phiếu chi (spend) → khoản vay NH | đối tác đầu nguồn = NH và đích = NH; khớp; cùng công ty; có số tiền |
| `disbursement` | phiếu thu (income) → khoản vay NH | như repayment nhưng phiếu thu; có số tiền |
| `funded_by` | phiếu chi (spend) → khoản vay NH | đích là NH; **không** yêu cầu khớp đối tác; có số tiền |
| `generated` | phiếu / công nợ / khoản vay → phiếu / khoản vay / công nợ | cùng công ty; không tiền |
| `internal_transfer` | phiếu chi (spend) → phiếu thu (income) | **khác** công ty; không tiền |

`AMOUNT_RELATIONS` = `offset, repayment, disbursement, funded_by` (chỉ các quan hệ này tính vào chỉ tiêu và sức chứa).

### 5.2 API (tất cả là hàm; route chưa có)

```ts
createLink(input: CreateLinkInput): Promise<LinkRecord>
// CreateLinkInput = { from:{type,id}, to:{type,id}, relation, amount_minor?: string|bigint|null,
//   split?: {principal?,interest?,fee?}|null, note?, origin?: 'manual'|'automation',
//   run_id?, rule_code?, actor: {user_id, name?, role?}, scopeCompanyIds?: string[]|null,
//   request_id?, ip? }
// Lỗi: FG-LINK-001 (cấu trúc/đối tác), FG-LINK-002 (vượt sức chứa), FG-LINK-003 (trùng cặp),
//      FG-VAL-001 (số tiền không hợp lệ / 404 đối tượng), FG-RBAC-002 (ngoài phạm vi)

removeLink(input: { link_id, reason, actor, scopeCompanyIds?, request_id?, ip? }): Promise<LinkRecord>
// soft: status='removed', removed_by/at/reason; lý do ≥ 5 ký tự; liên kết đã gỡ ⇒ FG-VAL-001

listLinksFor(objectType: LinkObjectType, id: string,
             opts: { scopeCompanyIds: string[] | null; includeRemoved?: boolean }): Promise<LinkRecord[]>

loadEndpoint(type, id): Promise<LinkEndpoint>      // nạp đối tượng + loại đối tác
```

Chỉ tiêu suy ra (KHÔNG lưu cứng):

```ts
documentAllocatedTotalOf(documentId): Promise<bigint>   // Σ phân bổ hiệu lực từ phiếu (mọi trạng thái phiếu)
debtOffsetApplied(debtVoucherId): Promise<bigint>        // Σ offset hiệu lực từ phiếu ĐÃ paid
debtRemaining(debtVoucherId): Promise<bigint>            // giá trị − debtOffsetApplied, không âm
loanRepaidPrincipal(bankDebtId): Promise<bigint>         // Σ phần GỐC repayment từ phiếu ĐÃ paid
loanOutstanding(bankDebtId): Promise<bigint>             // gốc − đã trả; pending_disbursement/cancelled ⇒ 0
```

Thuần (dùng để test / tính trên dữ liệu đã nạp): `documentAllocatedTotal(links, docId)`, `debtOffsetAppliedFrom(links, debtId, executedDocIds)`, `debtRemainingOf(value, applied)`, `loanRepaidPrincipalFrom(links, loanId, executedDocIds)`, `loanOutstandingOf(principal, repaid, status)`, `allocationOf(link)` (tách → tổng 3 phần, không tách → amount), `principalPartOf(link)` (tách → gốc, không tách → amount), `normalizeAmount(...)`, `assertWithinCapacity({limit, committed, add, what})`, `assertRelationRules(relation, from, to)`.

Quy ước: **sức chứa** (kiểm khi tạo) dùng liên kết HIỆU LỰC bất kể trạng thái phiếu (để không cấn trừ quá số); **chỉ tiêu "đã cấn trừ / đã trả / dư nợ"** chỉ tính phiếu đã `paid`. Sức chứa theo nhóm: phiếu nguồn ≤ số tiền phiếu; công nợ ≤ giá trị (offset); khoản vay: mỗi nhóm `disbursement`, `funded_by` ≤ gốc theo số tiền; `repayment` ≤ gốc theo phần GỐC.

Sự kiện loan:

```ts
emitLoanSettledAfterPayment(documentId: string, actor?: LinkActor|null): Promise<string[]>
// Gọi sau khi phiếu chi đã paid. Phát `loan.settled` khi lần thanh toán này đưa dư nợ về 0.
// Chỉ xét business_links (relation repayment); `repayment_links` v1 đã bỏ khỏi code (§20.1). Không ném lỗi nếu gọi trong try/catch.
```

Chưa có: route `POST /links`, `POST /links/:id/remove`, `GET /links` (cần thêm perms `link:manage`, scope). Chưa có `link.created`/`link.removed` sự kiện.

---

## 6. Sự kiện nghiệp vụ (`domain/events/index.ts`)

```ts
emitDomainEvent(input: DomainEventInput, session?: ClientSession): Promise<string | null>
// DomainEventInput = { type, company_id?, subject_type, subject_id?, payload?, actor?: {user_id?, name?, role?} }
// - không session: KHÔNG ném lỗi (log); thành công ⇒ kickAutomation() (xử lý ngay ở setImmediate).
// - có session: ném lỗi để transaction rollback (dùng khi codebase có transaction sau này).

emitVoucherEvent(type: VoucherEventType, doc: VoucherEventSubject, actor, extra = {}): Promise<string|null>
// subject_type = 'document'; payload luôn có: kind, code, status, partner_id, amount_minor (chuỗi),
// currency, loan_kind (borrow|fund|null) + extra (from, to, action, step_order, next_role, changed…)

buildDomainEventDoc(input, now?) — thuần; toEventPayload(v) — BigInt→chuỗi, ObjectId→hex, Date→ISO
```

Tên sự kiện: `VOUCHER_EVENT_TYPES` = `voucher.created | voucher.updated | voucher.submitted | voucher.step_approved | voucher.approved | voucher.rejected | voucher.changes_requested | voucher.queued | voucher.paid | voucher.cancelled | voucher.expired`; khác: `debt.created | loan.created | loan.settled`; lịch: `schedule.<tên>` (kiểu `ScheduleEventType`, chưa có bộ phát).

Điểm phát (đã nối):

| Nơi | Sự kiện |
| --- | --- |
| `routes/documents.ts` POST `/documents` | `voucher.created` |
| `routes/documents.ts` PATCH `/documents/:id` | `voucher.updated` (trạng thái không đổi, `changed` = các khoá sửa) |
| `workflow.submitDocument` | `voucher.submitted` |
| `workflow.transition` duyệt trung gian | `voucher.step_approved` |
| `workflow.transition` duyệt cuối | `voucher.approved`; phiếu thu tự thực thi thêm `voucher.paid` (`auto_executed: true`) |
| `workflow.transition` reject / request_changes / queue_payment | `voucher.rejected` / `voucher.changes_requested` / `voucher.queued` |
| `workflow.transition` pay | `voucher.paid` (+ `loan.settled` nếu đủ gốc, phiếu chi) |
| `workflow.transition` cancel / expire | `voucher.cancelled` / `voucher.expired` |
| `routes/finance.ts` POST `/internal-transfers` | `voucher.created` |
| `domain/recurring` materialize | `voucher.created` (`action: recurring_materialize`) |
| R1 `automation/rules/r1-internal-transfer` → `automation/actions/voucher.ts` (thay `workflow/auto-income` v1, đã xoá) | `voucher.created`; phiếu thu tự thực thi thêm `voucher.paid` (`auto_executed: true`) |
| `routes/debt.ts` POST `/debts` | `debt.created` (subject `debt_voucher`) |
| `routes/bank-debt.ts` POST `/bank-debts` và POST `/bank-debts/import` | `loan.created` (subject `bank_debt`) |
| R2 `automation/rules/r2-borrow-receipt` → `automation/actions/loan.ts` (thay `workflow/auto-bank-debt` v1, đã xoá) | `loan.created` (`origin: automation`) |

Chưa phát: xoá phiếu (`/documents/:id/delete` — không phải chuyển trạng thái), chuyển trạng thái khoản vay (`pending_disbursement`→`active`, `→cancelled`), liên kết.

---

## 7. Bộ máy quy tắc tự động (`domain/automation/engine.ts`)

### 7.1 Cách đăng ký một quy tắc (R1…R6 — việc của agent nghiệp vụ)

1. Tạo module (mẫu có sẵn: `apps/api/src/domain/automation/rules/r3-fund-by-loan.ts`):

```ts
import { registerRule, type StepContext } from '../engine.ts';

registerRule('R3', {
  steps: [
    {
      name: 'create_loan',
      run: async (ctx: StepContext) => {
        // ctx.stepKey = `${rule}:${source}:${event}#create_loan` → dùng làm khoá idempotency:
        // tìm business_links / bank_debts đã có origin.run_id + stepKey trước khi tạo.
        // ctx.params: tham số hiệu lực (term_months, due_offset_months…). ctx.event.payload: dữ liệu sự kiện.
        const loanId = /* … */ '';
        return { output_type: 'bank_debt', output_id: loanId };   // hoặc { skipped: true }
      },
    },
    { name: 'create_voucher', run: async (ctx) => ({ output_type: 'document', output_id: /* … */ '' }) },
    { name: 'execute_voucher', run: async (ctx) => ({ output_type: 'document', output_id: ctx.outputs.create_voucher?.output_id ?? null }) },
    { name: 'link', run: async (ctx) => { /* createLink({... origin:'automation', run_id, rule_code}) */ return {}; } },
  ],
});
```

2. `import` module đó trong `apps/api/src/domain/automation/rules/index.ts` (file này hiện trống, `server.ts` đã import nó một lần lúc khởi động).

Quy định bước: tên bước `^[a-z_]+$`, duy nhất trong quy tắc; hàm bước **nhận ctx và dùng `ctx.stepKey` làm khoá idempotency** (§14.3 (3)); gọi nghiệp vụ chuẩn (`createLink`, workflow, …), không ghi DB tắt; bước trả về `{output_type, output_id}` hoặc `{skipped: true}`; ném lỗi ⇒ lượt `failed`.

### 7.2 Dữ liệu và ngữ nghĩa

- Sự kiện chưa xử lý (`processed_at: null`) → `processPendingEvents()`: nhận từng sự kiện bằng lease (`claimed_at`, 2 phút); với mỗi quy tắc **bật** (`enabled`) có `trigger_event` hoặc `trigger_events` chứa loại sự kiện, **có bộ xử lý đăng ký trong tiến trình**, đúng phạm vi công ty (`company_ids` rỗng = mọi công ty), không bị `company_overrides[].enabled=false`, và `condition` khớp ⇒ tạo/nhận lượt chạy theo `idem_key = ${rule}:${subject_id}:${event.type}` (unique), rồi chạy các bước **chưa xong**.
- Quy tắc chưa có bộ xử lý ⇒ bị bỏ qua (không tạo lượt); sự kiện vẫn được đánh dấu xử lý. Vì vậy **đăng ký bộ xử lý trước khi bật quy tắc**.
- Sự kiện chỉ được đánh dấu `processed_at` khi mọi quy tắc khớp đã xong (`done`) hoặc lỗi có cảnh báo (`failed`). Nếu lượt khớp đang `running` trong lease của tiến trình khác (hoặc của tiến trình đã chết, chưa quá 5 phút) ⇒ sự kiện **chờ**: nhả lease (không tính là một lần thử), không đánh dấu, và được xét lại ở mỗi vòng. Khi lượt quá lease, claimRun **tiếp quản** và chạy tiếp các bước chưa xong (khoản vay tự sinh tới ngay vòng kế tiếp, mặc định 5 giây).
- Điều kiện (`matchCondition`): khoá là đường dẫn trong `{type, company_id, subject_type, subject_id, payload, actor}` (VD `"payload.kind": "spend"`), giá trị so **lỏng** theo chuỗi; toán tử `$eq $ne $in $nin $exists`; `{}`/null = luôn khớp.
- Lượt lỗi: `status = failed`, dừng ở bước lỗi, ghi `steps[].error` (với `ApiError` ghi **nguyên nhân** — `detail`/`errors`, không chỉ tiêu đề chung như "Dữ liệu không hợp lệ"), tạo **cảnh báo** `alert_type: 'automation_failed'` cho `chief_accountant` (dedupe theo `run._id`). Lượt lỗi KHÔNG tự chạy lại — gọi `rerunRun(runId)` (chỉ chạy bước chưa xong; cũng nhận lượt `running` đã quá lease 5 phút).
- Lượt `running` mà tiến trình chết giữa chừng (quá lease 5 phút) được bộ máy tiếp quản tự động (xem trên). Chỉ khi sự kiện nguồn đã xử lý xong mà lượt vẫn treo (lượt mồ côi) thì `sweepStaleRuns` mới đánh dấu `failed` (lý do "bị gián đoạn") khi hàng sự kiện rảnh, kèm cảnh báo; sau đó KTT chạy lại bình thường.
- Sự kiện lỗi ngoài dự kiến: nhả lease, `attempts++`; sau 5 lần ⇒ bỏ qua + cảnh báo `automation_event_failed`.
- Chạy song song an toàn: nhận sự kiện và nhận lượt đều là `findOneAndUpdate` có điều kiện; `idem_key` unique. `drainAutomation()` gộp các lời gọi trong cùng tiến trình.

### 7.3 API

```ts
registerRule(code: string, handler: { steps: StepDef[] }): void      // StepDef = { name, run(ctx) }
getRuleHandler(code), registeredRuleCodes(), clearRuleHandlers()       // clear: chỉ test
idemKeyFor(ruleCode, sourceId, eventType), stepKeyFor(runIdemKey, stepName)
getRuleParams(rule, companyId): Record<string, unknown>                 // mặc định + ghi đè công ty
isRuleEnabledFor(rule, companyId): boolean
matchCondition(condition, view): boolean
processPendingEvents({ limit?, now? }): Promise<ProcessSummary>        // ProcessSummary: events, runs_done, runs_failed, runs_skipped, rules_without_handler, runs_swept, errors
drainAutomation(): Promise<ProcessSummary>                              // gộp, không chạy chồng
kickAutomation(): void                                                   // setImmediate sau khi ghi sự kiện
executeRunSteps(run, rule, handler, view): Promise<'done'|'failed'>     // đã được claim
rerunRun(runId: string): Promise<RunRow>                                // FG-AUTO-001 nếu không phải lượt lỗi
sweepStaleRuns(now?, limit = 50): Promise<number>                    // lượt 'running' quá lease 5 phút, sự kiện nguồn đã xử lý ⇒ failed + cảnh báo; chạy khi hàng sự kiện rảnh
ensureAutomationRules(now?): Promise<{ inserted: string[] }>            // seed R1,R2,R3,R4(tắt),R5,R6 — chỉ thêm quy tắc còn thiếu
findRuleByCode(code)
```

Chu kỳ: `startAutomationLoop(log, intervalMs = 5000)` (`jobs/index.ts`) gọi `drainAutomation()` mỗi 5 giây (bỏ qua khi DB chưa lên), được khởi động trong `server.ts` sau `listen` và dừng khi tắt máy. Task HTTP `POST /api/v1/tasks/automation` cũng chạy `drainAutomation()` (dedupe 15 phút qua `jobs`).

### 7.4 Quy tắc mặc định (seed lúc boot)

| Mã | Trigger | Điều kiện | Bước (thứ tự) | Tham số | Bật |
| --- | --- | --- | --- | --- | --- |
| R1 | `voucher.paid` | `payload.kind = spend` | create_voucher, execute_voucher, link | — | ✔ |
| R2 | `voucher.created` (+ `voucher.updated`, `voucher.approved`, `voucher.paid`) | `payload.kind = income`, `payload.loan_kind = borrow` | create_loan, activate_loan, link | `term_months: 12`, `due_offset_months: 11`, `r2_create_at: 'save'` | ✔ |
| R3 | `voucher.approved` | `payload.kind = spend`, `payload.loan_kind = fund` | create_loan, create_voucher, execute_voucher, link | `term_months: 12`, `due_offset_months: 11` | ✔ |
| R4 | `loan.settled` | — | notify | — | ✘ |
| R5 | `schedule.recurring` | — | create_voucher | — | ✔ |
| R6 | `voucher.cancelled` (+ `voucher.rejected`) | `payload.loan_kind ≠ null` | alert, cancel_unpaid | — | ✔ |
| R7 | `voucher.approved` | `payload.kind = spend` (bước gán chỉ làm khi phiếu có `options.offset`, §27) | link | — | ✔ |

Seed chỉ INSERT quy tắc còn thiếu (`$setOnInsert`), không ghi đè chỉnh sửa của người dùng. Trường `steps` trong DB chỉ để hiển thị; bộ xử lý đăng ký trong code là nguồn thực thi.

---

## 8. Điểm nối đã sửa (các file đã đổi)

- `apps/api/src/domain/workflow/index.ts` — `loadDoc` chọn thêm `partner_id, tag_ids, options, transfer_target, origin`; phát sự kiện trong `submitDocument` và `transition` (sau CAS); `loan.settled` kiểm tra sau pay phiếu chi.
- `apps/api/src/domain/types.ts` — `DomainDoc` thêm `partner_id, tag_ids, options, transfer_target, origin`; `DocLoanOptions`.
- ~~`apps/api/src/domain/workflow/auto-income.ts`, `auto-bank-debt.ts`~~ — đã xoá (§20.1). R1/R2 nay là quy tắc trong `apps/api/src/domain/automation/rules/`, phát sự kiện qua `domain/events`.
- `apps/api/src/domain/recurring/index.ts` — copy `partner_id`; phát `voucher.created`.
- `apps/api/src/routes/documents.ts` — POST ghi `partner_id`, `tag_ids`; phát created / updated.
- `apps/api/src/routes/finance.ts` — phát `voucher.created` cho chuyển nội bộ.
- `apps/api/src/routes/debt.ts` — POST ghi `partner_id`, `direction`; phát `debt.created`.
- `apps/api/src/routes/bank-debt.ts` — POST và import ghi `partner_id`; phát `loan.created`.
- `apps/api/src/db/models.ts`, `db/indexes.ts`, `domain/numbering/index.ts`, `jobs/index.ts`, `server.ts` — như các mục trên.
- Mới: `domain/links/index.ts`, `domain/events/index.ts`, `domain/automation/engine.ts`, `domain/automation/rules/index.ts`.

---

## 9. Chưa làm / cần lưu ý cho các agent sau

1. ~~**Route HTTP** cho đối tác / tag / liên kết / quy tắc — chưa có~~ — ĐÃ CÓ: `routes/partners.ts`, `routes/tags.ts`, `routes/automation.ts`; liên kết `POST|DELETE /documents/:id/links` và `/debts/:id/links`. Quyền kiểm ở route (§12, §17).
2. ~~**Bộ xử lý R1–R6** chưa đăng ký~~ — ĐÃ CÓ: `domain/automation/rules/r1…r6` (đăng ký khi import qua `rules/index.ts`). Đường v1 `createAutoIncomeForSpend` / `createAutoBankDebtForIncome` đã xoá.
3. ~~`options.loan`, `transfer_target`, `origin` chưa được ghi từ `POST /documents`~~ — ĐÃ CÓ: POST/PATCH `/documents` ghi `options.loan` và `transfer_target`; `origin` do automation ghi (§13, §17).
4. ~~Liên kết v1 vẫn là nguồn chính~~ — ĐÃ CHUYỂN: cấn trừ, trả nợ và giải ngân đọc `business_links`; `document_links` / `repayment_links` chỉ còn để migration 0004 đọc (§20, §24).
5. **Outbox không có transaction** (ADR-03): nếu tiến trình chết giữa CAS và ghi sự kiện, sự kiện có thể mất. Chấp nhận ở giai đoạn này; cần job đối chiếu nếu yêu cầu cao hơn.
6. ~~`schedule.recurring` (R5) chưa có bộ phát~~ — ĐÃ CÓ: tác vụ `recurring` (`domain/recurring`) phát `schedule.recurring` mỗi kỳ; R5 = `rules/r5-recurring.ts` (§17). `loan.settled` phát từ luồng thanh toán phiếu chi và từ `POST /documents/:id/links` (§23.1).
7. Quy tắc chưa có bộ xử lý bị bỏ qua (không lỗi). Thứ tự triển khai: đăng ký bộ xử lý → bật quy tắc.
8. Engine dùng `trigger_events` (mảng) ngoài `trigger_event` theo spec — đã ghi trong schema.
9. Payload sự kiện: số tiền là CHUỖI minor units (`amount_minor`, `value_minor`…). Khi tính toán, chuyển bằng `BigInt(...)`, không dùng `Number` (có thể mất độ chính xác với số lớn).
10. Hàng `domain_events` đã xử lý bị TTL xoá sau 30 ngày; hàng chưa xử lý được giữ.
11. `apps/api/src/domain/links/index.ts` không kiểm quyền — tầng route phải kiểm `link:manage` và truyền `scopeCompanyIds`.
12. **Khoá lượt chạy theo spec = `rule:source:event_type`** (không có id sự kiện/phiên bản). Hệ quả: lần sửa thứ hai của cùng phiếu (`voucher.updated`) KHÔNG tạo lượt mới cho cùng quy tắc. Nếu R2 cần đồng bộ khoản vay mỗi lần sửa (v2 §11.4), agent R2 phải quyết định: thêm phiên bản vào khoá (cần sửa §14.2) hoặc dùng sự kiện khác. Không tự ý đổi khoá trong engine.

---

## 10. Trường v1 sẽ bỏ & trường phải thành bắt buộc (sau migrate M1–M6, v2 §15)

**Sẽ bỏ (sau khi đã chuyển sang trường mới và đối chiếu M6):**

- `documents`: `payee.name`, `payee.tax_code`, `payee.counterparty_id`, `payee.bank_name`, `payee.bank_account` (→ `partner_id`); `create_bank_debt` (→ `options.loan`); `auto_source_document_id`, `auto_created` (→ `origin` + `business_links`); `target` (→ `transfer_target`).
- `debt_vouchers`: `party_code`, `party_name`, `party_tax_code`, `party_bank_name`, `party_bank_account`, `counterparty_id` (→ `partner_id`); `document_links` (→ `business_links` relation `offset`). GIỮ `account_code` và `side` (bút toán kế toán) song song `direction`.
- `bank_debts`: `bank_name`, `branch` (→ `partner_id`); `repayment_links` (→ `business_links` relation `repayment`); `auto_source_document_id` (→ `origin` + link `disbursement`).
- `recurring_rules`: `payee` (→ `partner_id`).
- Collection `counterparties` (→ `partners`, theo công ty).
- Contract v1 còn chấp nhận (client cũ không vỡ; server bỏ qua hoặc ghi song song): `documentFields.payee`, `target`. Đã bỏ khỏi body nhập: `create_bank_debt`, `debtVoucherUpsertBody.party_*`, `bankDebtUpsertBody.bank_name` (§20.1) và `recurringUpsertBody.payee` (§24).

**Phải chuyển thành bắt buộc (hiện đang tuỳ chọn để v1 không vỡ):**

- `documentCreateBody` / `documentUpdateBody`: `partner_id` (sau M2, trừ phiếu "Chưa xác định").
- `debtVoucherUpsertBody`: `partner_id` và `direction` (sau M2/M3b); `party_name` bỏ khi đã có `partner_id`.
- `bankDebtUpsertBody`: `partner_id` (loại Ngân hàng) sau M2.
- `recurringUpsertBody`: `partner_id` sau M2.
- Model: `documents.partner_id`, `debt_vouchers.partner_id` + `direction`, `bank_debts.partner_id`, `recurring_rules.partner_id` — `required` sau khi migrate xong.

---

## 11. Kiểm thử & xác minh

Đã chạy (phải xanh trước khi bàn giao):

```
pnpm -F @fingate/shared build
pnpm -r typecheck
pnpm -F @fingate/api test
```

Test mới:
- `packages/shared/test/v2-foundation.test.ts` — quyền mặc định theo §3.2, registry trạng thái/nhãn, contract đối tác/tag/liên kết/quy tắc, tương thích body v1.
- `apps/api/src/domain/links/links.test.ts` — quy tắc quan hệ, tách/phân bổ, sức chứa, chỉ tiêu suy ra.
- `apps/api/src/domain/events/events.test.ts` — dựng bản ghi outbox, chuẩn hoá payload.
- `apps/api/src/domain/automation/engine.test.ts` — khoá, tham số, phạm vi, điều kiện, kế hoạch bước, đăng ký bộ xử lý, seed mặc định, và `executeRunSteps` (lỗi dừng lượt, cảnh báo KTT, chạy lại không làm trùng bước đã xong) với tầng DB được mock.

Chưa có test tích hợp với MongoDB (hàm DB của links/engine chưa được chạy trên DB thật). Không chạy `pnpm dev` khi xác minh (theo AGENTS.md).

## Tag: danh bạ nhãn phiếu (agent tags, v2 §6.2, §13, §14.2)

Đã làm (backend, chưa có UI): nghiệp vụ và truy vấn ở `apps/api/src/domain/tags/` (`normalize.ts` thuần, `index.ts` DB), route ở `apps/api/src/routes/tags.ts` (đã đăng ký trong `routes/index.ts`). Không đổi shared, models, indexes: dùng `Models.Tag`, unique `(company_id, name_key)` và `documents (company_id, tag_ids)` sẵn có.

**Endpoint** (dưới `/api/v1`, cần phiên, kiểm quyền bằng `config.perms`):

| Route | Quyền | Ghi chú |
| --- | --- | --- |
| `GET /tags` | một trong `doc:read`, `tag:create`, `tag:manage` | query `company_id`, `q` (chứa, trên tên chuẩn hoá), `include_hidden=true` (chỉ `tag:manage`), `limit` ≤ 500, `offset` (phân trang). Trả `{items, total}` (total = số dòng khớp, không tính phân trang), mỗi dòng có `usage_count` |
| `GET /tags/:id` | như trên | `{data}` |
| `POST /tags` | `tag:create` | `{company_id?, name, color?}`. 201 tạo mới; 200 (`created: false`) khi trùng tên đang hiện, trả tag đã có; 409 `FG-TAG-001` khi trùng tên nhưng đang ẩn |
| `PATCH /tags/:id` | `tag:manage` | `{name?, color?, hidden?}`. Đổi tên trùng → 409 `FG-TAG-001`. Ẩn khi còn phiếu gắn → 422 `FG-VAL-001` |
| `POST /tags/merge` | `tag:manage` | `{source_id, target_id}` → `{data: {source_id, target_id, documents_changed, target}}` |

**Quy tắc đã chốt** (cách hiểu spec):
- Chuẩn hoá tên: NFC, bỏ ký tự vô hình (ZWSP/ZWNJ/ZWJ/BOM), gộp khoảng trắng kể cả NBSP, trim, 1–40 ký tự. `name_key` = `normalizeNameKey` của shared (có lowercase). **Giữ dấu tiếng Việt** ("Dự án" ≠ "Du an"): spec chỉ yêu cầu bỏ khoảng trắng thừa và không phân biệt hoa thường.
- Ẩn = ngừng dùng (spec: "ẩn tag không dùng"): chỉ ẩn tag không còn phiếu nào gắn. Tag ẩn không hiện trong gợi ý và `resolveVoucherTagIds` (`domain/vouchers/refs.ts`) từ chối gắn vào phiếu mới.
- Gộp A vào B: (1) chuyển mọi phiếu công ty đang gắn A sang B, không trùng; mỗi phiếu qua `cas` (tăng `version`), history `tag_merge` (`from`/`to` là tên tag). (2) Ẩn A. (3) Quét lại. Không xoá tag nên id vẫn tra được trong audit. Chạy lại an toàn. Không phát domain event vì tag không đổi tiền.
- Audit: `tag.create`, `tag.update`, `tag.hide`, `tag.unhide`, `tag.merge`, `document.tag_merge` (mỗi phiếu được chuyển).

**Hàm cho agent khác** (`import` từ `apps/api/src/domain/tags/index.ts`):
- Kiểm tag khi gắn vào phiếu: `resolveVoucherTagIds({companyId, requested, previous})` ở `domain/vouchers/refs.ts` — nguồn duy nhất, gọi trong POST/PATCH /documents và PATCH /documents/:id/tags. Ném `FG-VAL-001` (422) kèm `errors.tag_ids` khi sai định dạng, khác công ty, tag đang ẩn (tag ẩn đã có trên phiếu thì giữ, không gắn thêm) hoặc quá 50. Khử trùng, giữ thứ tự. (`resolveTagIds`, `tagRefsFor`, `groupTagsAcrossCompanies` đã xoá vì không còn nơi gọi — đối chiếu lại ngày review v2.)
- Tên và màu tag hiện trên phiếu: `buildVoucherRefView` ở `domain/vouchers/refs.ts`. Báo cáo "Tất cả công ty" nhóm theo tên chuẩn hoá bằng `groupByTagName` ở `domain/reports/aggregate.ts` (một nguồn duy nhất).
- `tagUsageByIds(scope, ids)` → `Map<tagId, số phiếu>`; `countTagUsage(companyId, tagId)`.
- `normalizeTagName(raw)` → `{name, name_key}`, ném `FG-VAL-001` nếu không hợp lệ.

**Gợi ý cho agent phiếu / báo cáo**: sửa `tag_ids` được cả khi phiếu đã duyệt (không đổi tiền), nên không đặt điều kiện trạng thái cho `tag_ids`; ghi qua CAS với history `update` và `fields.changed: ['tag_ids']`. Lọc theo tag dùng `tag_ids` (đã có index).

**Kiểm thử**: `apps/api/src/domain/tags/tags.test.ts` (chuẩn hoá tên, gộp id không trùng, diff audit); kiểm tag khi gắn phiếu có test ở `domain/vouchers/rules.test.ts`. Smoke test: 5 route đăng ký dưới `/api/v1`, không có phiên thì trả 401.

**Chưa làm / lưu ý**:
- Chưa có UI (màn quản lý tag, ô gợi ý "+ Tạo tag").
- Chưa chạy với MongoDB thật: unique index `(company_id, name_key)`, pipeline `tagUsageByIds` và `groupTagsAcrossCompanies`, chuỗi CAS khi gộp.
- Không có transaction (ADR-03). Nếu gộp bị ngắt giữa chừng, chạy lại `POST /tags/merge` để hoàn tất. Writer đã đọc phiếu trước khi A bị ẩn có thể ghi A sau lượt quét đầu; lượt quét thứ hai bắt phần lớn trường hợp, phần còn lại trả FG-WF-011 để gộp lại.
- Không thêm mã lỗi mới (tránh sửa shared). "Ẩn khi đang dùng" trả `FG-VAL-001` (422).
- `GET /tags` không dùng query `scope`; phạm vi lấy theo header `x-company-scope` như các route khác.

---

## 12. Web — Tag (TagInput · TagFilter · TagPicker · TagChips · màn Quản lý tag) — v2 §6.2, §13

Chỉ UI và hook phía web; không đổi API hay contract. Đã đối chiếu với `apps/api/src/routes/tags.ts` và `domain/tags`.

### 12.1 File

- `apps/web/src/app/v2/tags.ts` — kiểu `TagRef`, `TagCreateResult`, `TagMergeResult`; khoá cache `tagsQueryKey(companyId)` = `['tags', companyId, 'all']`; hook `useCompanyTags`, `useCreateTag`, `useUpdateTag`, `useMergeTags`; hàm thuần `findTagByName`, `tagMatchesSearch`, `tagColorOf`, `problemOf`, `tagErrorMessage`, `TAG_COLOR_PRESETS`, `CREATE_TAG_TOKEN`.
- `apps/web/src/components/tag-input.tsx` — `TagInput`, `TagFilter`, `TagPicker`, `TagChips`, `TagChip`.
- `apps/web/src/screens/tags.tsx` — `TagsScreen`, route `/quantri/tags`, quyền `tag:manage`.
- Sửa nhỏ: `routes.tsx` (route, `PATH_PERMS`, `AdminHomeRedirect`), `components/shell.tsx` (mục rail "Quản lý tag" ngay dưới "Quản trị").

### 12.2 Cách dùng

```tsx
<TagInput value={tagIds} onChange={setTagIds} companyId={companyId} knownTags={doc?.tags} disabled={!canEdit} />
<TagFilter value={tagIds} onChange={setTagIds} companyId={scope === SCOPE_ALL ? null : scope} />
<TagChips tags={doc.tags} />                 // hoặc <TagChips ids={doc.tag_ids} companyId={doc.company_id} />
<TagPicker companyId={companyId} value={id} onChange={setId} exclude={sourceId} />
```

- `companyId` là công ty của phiếu hoặc phạm vi đang lọc. Tag không dùng chung giữa công ty, nên mọi ô đều cần nó.
- Truyền `knownTags` (hoặc `tags` của `documentDetail`) để hiện đúng tên tag đã ẩn trên phiếu cũ. Server chỉ trả tag đã ẩn trong danh bạ cho người có `tag:manage`.

### 12.3 Hành vi

- TagInput: chip có màu và tên; gõ để lọc (bỏ khoảng trắng thừa, không phân biệt hoa thường); dòng "+ Tạo tag “…”" khi chưa có tên trùng và có `tag:create`; tối đa 50 tag mỗi phiếu. Trùng tên đang hiện → server trả tag đó, không tạo trùng. Trùng tên đang ẩn → báo cần Kế toán trưởng hiện lại.
- Tag đã ẩn không được gợi ý (TagInput, TagPicker) nhưng vẫn hiển thị trên phiếu đã gắn.
- Danh bạ được tải đủ mọi trang (`collectAllTagPages` trong `app/v2/tags.ts`, mỗi trang tối đa 500 dòng): tìm kiếm, sửa / gộp / ẩn, tra tên chip, lọc và kiểm trùng tên đều thấy tag ở mọi vị trí, không chỉ 500 tag đầu.
- Màn Quản lý tag (KTT): bảng có số phiếu; tìm kiếm; lọc Tất cả / Đang dùng / Đã ẩn; Sửa tên và màu (chỉ gửi trường đã đổi); Ẩn / Hiện lại (nút Ẩn bị khoá khi tag còn phiếu gắn); Gộp…: chọn tag đích đang hiện, bước xác nhận nêu số phiếu sẽ chuyển. Tag nguồn bị ẩn chứ không xoá, và hiện lại được.
- Phạm vi "Toàn tập đoàn": TagFilter và TagInput không có công ty nên bị khoá. Báo cáo hợp nhất theo tên chuẩn hoá (`name_key`) chưa có UI.

### 12.4 Hợp đồng đã đối chiếu với server

| Thao tác | Kết quả | Lỗi |
| --- | --- | --- |
| GET `/tags?company_id&scope&include_hidden=true&limit=500&offset=n` | `{items, total}` (total = số dòng khớp bộ lọc; trang kế tiếp bằng `offset`); include_hidden chỉ có tác dụng với `tag:manage` | — |
| POST `/tags` | `{data: tag, created}`: 201 khi tạo mới, 200 khi trùng tên đang hiện | 409 FG-TAG-001 (trùng tên đang ẩn) |
| PATCH `/tags/:id` | `{data: tag}` | 409 FG-TAG-001 (đổi trùng tên); 422 FG-VAL-001 (ẩn khi còn phiếu) |
| POST `/tags/merge` | `{data: {documents_changed, target, …}}` | 422 nếu tag đích đang ẩn |

### 12.5 Chưa làm / lưu ý

- Chưa nối TagInput vào form phiếu, danh sách phiếu và báo cáo; thuộc các agent màn đó (dashboard đã có ô lọc tag và thẻ "Theo tag", xem §16.2). Form phiếu cần gửi `tag_ids` và truyền `knownTags`.
- Chưa có màn xem lịch sử tag. Server đã ghi audit `tag.create / tag.update / tag.hide / tag.unhide / tag.merge`.
- Mục "Quản lý tag" nằm ở rail, chưa vào thanh tab Quản trị (`ADMIN_TABS` trong `screens/admin.tsx`, ngoài phạm vi được giao).
- Bảng màu cố định nằm trong `app/v2/tags.ts`, có chú thích `eslint-disable` cho quy tắc `fg/no-raw-color`, vì mã hex là dữ liệu tag.
- Chưa kiểm tra trên trình duyệt (không chạy `pnpm dev` theo AGENTS.md). Đã chạy `pnpm -F @fingate/web typecheck` (đạt) và eslint trên các file mới (không lỗi).

---

## 13. Phiếu thu/chi v2 — backend (agent voucher: v2/v2.md §5.2, §6, §7.2, §11.4–11.6, §14.2)

### 13.1 Đã làm

- **Contract** (`packages/shared/src/contracts/documents.ts`, sửa tối thiểu): `payee` thành tuỳ chọn (không còn ghi; bị bỏ qua). `documentCreateBody` bắt buộc `partner_id` với phiếu thu/chi. `documentListQuery` thêm `partner_id`, `tag_ids` (chuỗi phân tách dấu phẩy hoặc mảng). `documentDetail` thêm `links`, `automation_runs`; `documentRow` thêm `partner_id`, `partner_name`, `tags`. Mới: `documentLinkItem`, `documentTagsBody`, `documentLinkCreateBody` (cuối file).
- **`domain/vouchers/rules.ts`** (mới, thuần, có test): chuẩn hoá ID, `diffIds`, `parseIdList`, kiểm đối tác (`assertVoucherPartner`, `assertLenderBank`), kiểm tag (`assertTagSelection`), tuỳ chọn vay (`planLoanOptions`), chuyển nội bộ (`assertTransferTargetFits`), sửa số tiền sau R3 (`assertAmountEditAllowed`), liên kết thủ công (`manualLinkTargetType`, `assertDocumentLinkable`).
- **`domain/vouchers/refs.ts`** (mới, có DB): kiểm khi ghi (`resolveVoucherPartner`, `resolveVoucherTagIds`, `resolveLoanPlan`, `resolveTransferTarget`, `assertApprovalAmountEditable`, `hasAutoLoanRun`, `softRemoveLinksOfDocument`). Dựng tham chiếu khi đọc (`buildVoucherRefView`): đối tác nạp sống theo ID, tag, `options.loan`, `transfer_target`, `origin`, liên kết hai chiều (`counterpart` có mã, trạng thái, số tiền, đối tác; ngoài phạm vi thì `visible: false`), lượt tự động. Phiếu không lưu bản sao thông tin đối tác.
- **Quyền** (`domain/entitlement`): `can.tag` (xem + `doc:create` hoặc `tag:create`), `can.link` (`link:manage`).
- **Truy vấn** (`domain/queries`): lọc `partner_id`, `tag_ids` (có ít nhất một tag); `q` khớp tên / STK / MST của đối tác và tên tag (qua ID, tối đa 200 mỗi loại); hàng danh sách có `partner_id`, `partner_name`, `tags`, và `payee_name` lấy từ đối tác. `decisionPack.q1_payee` lấy từ đối tác.

### 13.2 Endpoint (`routes/documents.ts`)

| Endpoint | Ghi chú | Lỗi chính |
| --- | --- | --- |
| POST `/documents` | bắt buộc `partner_id` (phiếu thu/chi); `tag_ids`; `options.loan`; `transfer_target` (ghi song song vào `target`); không ghi `payee`, không tách chuỗi, không tự tạo đối tác. Vay để chi: TK nguồn = TK nhận giải ngân (luôn bằng nhau). Có `options.loan` thì bỏ qua cờ v1 `create_bank_debt`. | 422 FG-PARTNER-001 / FG-VAL-001 |
| PATCH `/documents/:id` | kiểm đối tác, khoản vay, chuyển nội bộ, tag trên trạng thái SAU khi gộp; đổi đối tác ⇒ kiểm lại toàn bộ khoản vay; `payee` bị bỏ qua. Vẫn chỉ khi nháp / trả về / từ chối (như v1). | |
| PATCH `/documents/:id/tags` | mới. Quyền `doc:create` hoặc `tag:create`. Mọi trạng thái. Ghi history `tags_update` với `added` / `removed` (id + tên), không phát sự kiện (tag không ảnh hưởng tiền). Không đổi thì không ghi lịch sử. | 409 FG-WF-011; 422 FG-VAL-001 (tag ẩn / không thuộc công ty) |
| POST `/documents/:id/links` | mới, `link:manage`, 201. `offset` → công nợ; `repayment` / `disbursement` → khoản NH; tách gốc/lãi/phí chỉ cho `repayment`. Phiếu đã từ chối / huỷ không gắn. Gọi `createLink` (FG-LINK-001/002/003). | |
| DELETE `/documents/:id/links/:linkId` | mới, `link:manage`, body `{reason ≥ 5, request_id?}`. Gỡ mềm. Liên kết không nối với phiếu này ⇒ 404. | 404 FG-WF-001 |
| POST `/documents/:id/transition` | approve / approve_with_reason đổi `amount_minor` khác số tiền hiện tại ⇒ 422 FG-WF-005 nếu đã có lượt `R3` của phiếu (`automation_runs`, `source_type: document`). Đổi tài khoản vẫn được. | 422 FG-WF-005 |
| POST `/documents/:id/delete` | gỡ mềm mọi liên kết còn hiệu lực của phiếu trước khi xoá cứng. | |
| GET `/documents`, GET `/queue` | thêm `partner_id`, `tag_ids`. | |
| ~~GET `/documents/payees`~~ | đã bỏ (§22.1), không còn client gọi | |
| GET `/documents/:id` và mọi phản hồi chi tiết | `partner`, `partner_id`, `payee` (dẫn xuất từ đối tác; v1 giữ nguyên nếu chưa có đối tác), `tag_ids`, `tags` (`_id`, `name`, `color`), `options.loan` (xem 13.3), `transfer_target` (+ `company_name`, `account_label`), `target` (v1), `origin`, `links`, `automation_runs` (≤ 20, mới nhất trước), `can.tag`, `can.link`. | |

### 13.3 Quy tắc ghi (để agent R2 / R3 dùng)

- **Đối tác**: lựa chọn MỚI phải `active`; giữ nguyên thì ngừng giao dịch vẫn sửa được. Phiếu thu đi vay: đối tác bắt buộc là Ngân hàng.
- **`options.loan.amount_minor` = null** khi gốc bằng số tiền phiếu (vay đi theo số tiền phiếu, kể cả khi số tiền đổi lúc duyệt). Số tiền hiệu lực = `amount_minor ?? amount.minor`; khi đọc, có sẵn `effective_amount_minor`. Vay một phần thì giữ số đã ghi (phải > 0 và ≤ số tiền phiếu).
- **`borrow`** (R2, phiếu thu): `lender_partner_id` = đối tác phiếu; `receive_account_id` = null; `mode` `new | existing | later`; `existing_loan_id` chỉ khi `existing`, và khoản đó phải cùng ngân hàng, cùng công ty, đang `pending_disbursement` hoặc `active`. Điều khoản `terms` lưu nguyên, không đặt mặc định ở đây.
- **`fund`** (R3, phiếu chi): `mode` luôn `new`; `lender_partner_id` là đối tác loại Ngân hàng, đang hoạt động, cùng công ty; `receive_account_id` là TK **ngân hàng** đang hoạt động của công ty.
- **Chuyển nội bộ**: chỉ phiếu chi (và `internal`); công ty nhận khác công ty phiếu và tồn tại; TK nhận **bắt buộc** (theo ID, thuộc công ty nhận và đang hoạt động) — thiếu ⇒ 422 FG-VAL-001 (`transfer_target.account_id`) khi tạo / sửa, vì R1 cần TK để ghi phiếu thu sau khi tiền đã ra. Lưu song song `transfer_target` và `target`.
- **Tag**: kiểm trực tiếp trong `tags` theo `company_id` (`domain/tags` hiện chỉ chuẩn hoá tên). Tag ẩn: giữ được nếu đã có trên phiếu, không gắn thêm. Tối đa 50.

### 13.4 Việc cần agent khác làm (ngoài phạm vi, đã kiểm tra)

1. **Chặn gửi duyệt**: `domain/workflow/index.ts` `requiredFieldsMissing` vẫn đòi `doc.payee?.name`; phiếu v2 không còn ghi `payee`, nên gửi duyệt sẽ báo thiếu. Đổi sang kiểm `doc.partner_id` (và `target` → `transfer_target` cho kind `internal`). Cần làm trước khi bật v2.
2. ~~**R1** (v1 `workflow/auto-income.ts` nhận diện bằng `payee.name`)~~ — ĐÃ XỬ LÝ: R1 là `rules/r1-internal-transfer.ts`, nhận diện qua `transfer_target` / `kind = internal` / `origin.rule_code = R1`; file v1 đã xoá.
3. ~~**R2 / R3** — gỡ đường v1 `createAutoBankDebtForIncome`~~ — ĐÃ XỬ LÝ: R2 = `rules/r2-borrow-receipt.ts`, R3 = `rules/r3-fund-by-loan.ts`; đọc `options.loan` (§13.3). Sửa số tiền sau R3 bị chặn ở route.
4. ~~**`domain/counterparty/index.ts`** (legacy: `ensureCounterpartyFromLabel` / `syncCounterparties`)~~ — ĐÃ XOÁ cùng `routes/counterparty.ts` (§20.1, §21.1).
5. ~~**`domain/recurring`** (R5): materialize chưa đặt `partner_id`~~ — ĐÃ XỬ LÝ: phiếu nháp copy `partner_id` từ khoản định kỳ; `payee` chỉ còn là bản sao hiển thị.
6. **Dữ liệu v1** chưa có `partner_id`: vẫn đọc được (`payee` cũ), nhưng không gửi duyệt được cho đến khi migrate M2.

### 13.5 Kiểm thử

- `pnpm -F @fingate/shared test`: 94 pass. Có `test/v2-voucher.test.ts` (mới). Hai khẳng định trong `v2-foundation.test.ts` được sửa cho yêu cầu đối tác (`partner_id` bắt buộc khi thu/chi).
- `pnpm -F @fingate/api test`: 292 pass. Có `domain/vouchers/rules.test.ts`, `domain/entitlement/document-v2-permissions.test.ts`, và `queue-filter.test.ts` (đối tác, tag, tìm kiếm).
- `pnpm -F @fingate/api typecheck`: không lỗi trong file của agent này (còn lỗi ở `domain/debt/rules.ts` của agent khác).
- Đã nạp mô-đun `routes/documents.ts` và `routes/schemas.ts`, đăng ký đủ 23 route trên app giả (không listen, không DB).
- **Chưa** có kiểm thử tích hợp MongoDB cho các route voucher (CAS với `$set options.loan`, ép BigInt, chỉ mục). Cần chạy thử trên DB thật trước khi phát hành.

---

## 12. Công nợ & nợ ngân hàng — backend (agent DEBT)

**Đã làm**: công nợ phải thu/phải trả theo đối tác ID (§9); nợ ngân hàng theo đối tác Ngân hàng, vòng đời, giải ngân, trả nợ tách gốc/lãi/phí, chuỗi liên quan (§10, §11.4, US-AUTO-08); nhập Excel theo mã đối tác. Mọi chỉ tiêu suy ra khi đọc từ `business_links` + trạng thái phiếu. Không còn ghi `document_links` / `repayment_links`.

**File** (đều thuộc `apps/api/src`):
- `domain/debt/rules.ts` — thuần, không DB: hướng ↔ bút toán (phải thu = Nợ, phải trả = Có), TK 131/331, `debtFigures` (còn lại, quá hạn, nhóm tuổi nợ), `loanStatusOf` (pending/cancelled/archived lưu; active/overdue/settled suy ra), `loanWarningOf` (bảng `maturity()` chung), `businessDateStart` (VN UTC+7), `defaultAllocation`, `positiveMinor`, `wireMoney`, `isoOf`.
- `domain/debt/bodies.ts` — zod v2: `debtCreateBody` (partner_id + direction bắt buộc), `debtUpdateBody`, `debtOffsetBody`, `loanCreateBody` (partner_id loại Ngân hàng), `loanUpdateBody` (không default), `loanRepaymentBody` (split), `loanDisbursementBody`, `loanCancelBody`, `loanImportRow` (partner_id | partner_code), `unlinkBody`, `loanListQuery`, `debtAgingQuery`, `linkCandidatesQuery`.
- `domain/debt/loads.ts` — nạp theo lô (đối tác, phiếu, liên kết hiệu lực), `assertPartner` (FG-PARTNER-001: đúng công ty, đang hoạt động, đúng loại), `documentCandidates` (cùng công ty + đối tác + đúng loại phiếu, chưa huỷ), `sumBy`, `paidRepaymentParts`.
- `domain/debt/debts.ts` — `listDebts`, `debtAgingMatrix`, `getDebtDetail`, `createDebt`, `updateDebt`, `assertDebtDeletable`/`deleteDebtRecord`, `assignOffset` (qua `createLink`, kiểm hướng ↔ loại phiếu), `unassignOffset` (qua `removeLink`), `offsetCandidates`.
- `domain/debt/loans.ts` — `listLoans` (khoản chờ giải ngân nằm trong danh sách, không vào dư nợ), `getLoanDetail` (chuỗi: `funded_by`, `disbursements`, `repayments`), `createLoan`, `importLoans`, `updateLoan`, `assertLoanDeletable`/`deleteLoanRecord`, `assignDisbursement`, `assignRepayment` (kể cả `emitLoanSettledAfterPayment` khi phiếu chi đã thực thi), `unassignLoanLink`, `loanCandidates`, `cancelPendingLoan`, `archiveLoan`.
- `domain/debt/debt.test.ts` (giữ) + `domain/debt/v2.test.ts` (mới, 30 test thuần: quy tắc, chỉ tiêu, zod, JSON Schema) + `domain/debt/routes.test.ts` (mới: đăng ký đủ endpoint).
- Routes: `routes/debt.ts`, `routes/bank-debt.ts` (mỏng, gọi domain). `mapOwnerAttachments` vẫn export từ `routes/debt.ts`.

**Endpoint công nợ** (`perms`):
- `GET /debts` (`partner_id`, `direction`, `counterparty`|`q`, `overdue_only`, `bucket`, `sort`, `page`/`limit`) — `debt:read`; trả `items`, `total`, `totals{remaining,value,offset_applied}`.
- `GET /debts/aging?party_type&direction` — `{data:{columns, rows[{counterparty, partner_id, direction, cells, total}], totals}}`.
- `POST /debts` — `partner_id` (KH/NCC), `direction` (receivable|payable), `value`, `due_date`; `side` tuỳ chọn (lệch hướng ⇒ FG-VAL-001). `debt:write`.
- `GET|PATCH|DELETE /debts/:id` — PATCH chặn đổi đối tác/hướng khi đã có cấn trừ (FG-PARTNER-003 / FG-VAL-001), giá trị không nhỏ hơn đã cấn trừ (FG-LINK-002). DELETE chặn khi còn liên kết hiệu lực. Chi tiết có `offset_links`, `offset_applied`, `remaining`, `days_overdue`, `aging_bucket`, `read_only` (TK 334).
- `POST /debts/:id/links` `{document_id, amount_minor?, note?}` — `debt:write` + `link:manage`; mặc định số tiền = min(còn lại của phiếu, còn lại của khoản).
- `DELETE /debts/:id/links/:linkId` (`reason` trong body hoặc query, mặc định "Gỡ liên kết cấn trừ") — `debt:write` + `link:manage`.
- `GET /debts/:id/link-candidates?q=` — phiếu cùng đối tác, đúng loại (phải thu ↔ thu, phải trả ↔ chi), có `allocated`, `unallocated`, `already_linked`.

**Endpoint nợ ngân hàng** (`perms`):
- `GET /bank-debts?status&partner_id&q&company_id&summary` — `loan:read`; lọc trong DB (công ty trong phạm vi, đối tác, trạng thái lưu trực tiếp, `q` khớp mã khoản hoặc tên ngân hàng) và KHÔNG cắt số dòng. `totals{outstanding,count,pending_count,pending_amount}` và `by_bank[]` (dư nợ theo ngân hàng: số khoản, dư nợ, đáo hạn ≤ 7 / ≤ 30 ngày) luôn tính trên mọi khoản khớp bộ lọc. `summary=true` bỏ `items` (chỉ tổng hợp) cho màn đáo hạn.
- `POST /bank-debts` — `partner_id` (Ngân hàng) bắt buộc, `amount`, `maturity_date`, `disbursed_date?` (tạo tay = đang vay).
- `POST /bank-debts/import` — dòng: `partner_id` hoặc `partner_code` (DT-…); không khớp theo tên; dòng lỗi báo trong `failed`.
- `GET|PATCH|DELETE /bank-debts/:id` — DELETE chặn khi còn liên kết hiệu lực (dùng `cancel`). PATCH chặn đổi ngân hàng khi đã có liên kết; gốc không nhỏ hơn đã giải ngân / đã gán trả gốc.
- `GET /bank-debts/:id/schedule` — lịch trả nợ (v1), tên ngân hàng lấy từ đối tác.
- `POST /bank-debts/:id/cancel` `{reason≥5}` — chỉ khi `pending_disbursement` và chưa có tiền giải ngân về.
- `POST /bank-debts/:id/archive` — chỉ khi đã tất toán.
- `POST /bank-debts/:id/disbursements` `{document_id, amount_minor?}` (phiếu thu cùng ngân hàng) — `loan:write` + `link:manage`. Phiếu đã thực thi ⇒ khoản chuyển `active`.
- `DELETE /bank-debts/:id/disbursements/:linkId`, `GET /bank-debts/:id/disbursement-candidates?q=`.
- `POST /bank-debts/:id/repayments` `{document_id, amount_minor?, split?{principal,interest,fee}}` (phiếu chi cùng ngân hàng) — `loan:write` + `link:manage`.
- `DELETE /bank-debts/:id/repayments/:linkId`, `GET /bank-debts/:id/repayment-candidates?q=`.
- `GET /bank-debts/:id` — `disbursement_links`, `funded_by_links`, `chain{funded_by,disbursements,repayments}`, `attachments`.

**Điểm nối cho quy tắc tự động (R2 / R3 / R6)** — `domain/debt/loans.ts`:
- `createLoanForAutomation({companyId, partnerId, principalMinor, maturityDate, status: 'pending_disbursement'|'active', origin:{run_id, rule_code}, actor, …})` → `{_id, code}` (cùng kiểm tra như tạo tay; `origin.kind = automation`). Idempotency do bước quy tắc (`ctx.stepKey`).
- `activateLoanOnDisbursement(loanId, actor)` → boolean: `pending_disbursement → active` khi có phiếu giải ngân đã `paid`; `disbursed_at` = ngày thực thi; gốc = số thực thu nếu đã giải ngân hết các phiếu gán.
- `syncLoansOnVoucherPaid(documentId, actor)` → id các khoản đã kích hoạt. Gọi khi một phiếu thu được thực thi (hook của workflow/R2/R3).
- `releaseLoansOfCancelledVoucher(documentId, actor, reason)` → `{cancelled, kept}` (R6): huỷ khoản chờ giải ngân chưa có tiền; khoản đã có tiền / đã đang vay vào `kept` để báo KTT.
- `cancelPendingLoan(actor, scopeOrNull, loanId, reason)`.
- Liên kết tạo bằng `createLink` (`origin:'automation'`, `run_id`, `rule_code`), gỡ bằng `removeLink`.

**Chưa làm / cần lưu ý**:
1. `db/models.ts`: `debt_vouchers.party_name` và `bank_debts.bank_name` vẫn **bắt buộc** → server ghi bản sao hiển thị từ đối tác (cache); đọc luôn lấy tên theo `partner_id`. Khi model bỏ bắt buộc, bỏ luôn phần cache này.
2. ~~**Module ngoài đọc mảng v1** chưa dùng `business_links`~~ — ĐÃ XỬ LÝ (§20.1): đáo hạn, dư nợ theo ngân hàng, quá hạn, báo cáo, cảnh báo, bản tin và tóm tắt đối tác đọc `business_links`.
3. Contract `packages/shared/src/contracts/finance.ts` (`debtVoucherUpsertBody`, `bankDebtUpsertBody`, `bankDebtRow`) còn `party_*` / `bank_name` bắt buộc hoặc tuỳ chọn; body thật nằm ở `domain/debt/bodies.ts`. Web/shared cần đồng bộ.
4. Kiểm sức chứa giải ngân theo **gốc** (`principal`), không theo hạn mức tín dụng (`credit_limit`).
5. Chưa có sự kiện cho gán/gỡ liên kết và cho chuyển trạng thái khoản vay (không có loại trong `DomainEventType`). `loan.settled` phát khi gán trả nợ từ phiếu đã thực thi và từ luồng thanh toán phiếu chi.
6. Phiếu nguồn bị huỷ không tự gọi `releaseLoansOfCancelledVoucher` — hook do workflow/R6 gọi.
7. Chưa kiểm thử tích hợp MongoDB (chỉ test thuần). `tie` và `loan-schedule` không đổi.

---

## 15. Chuyển đổi dữ liệu v1 → v2 (migration 0004) & seed

Phạm vi: `v2/v2.md` §15 (M1–M6) và dữ liệu demo v2. Không đổi route HTTP, không đổi UI.

### 15.1 File

| File | Vai trò |
| --- | --- |
| `db/migrations/0004-v2-data.js` | M1–M6. Runner (`pnpm db:migrate`) gọi `up(conn)` = áp dụng thật; M6 lệch ⇒ ném lỗi, runner không ghi "đã áp dụng". CLI `node db/migrations/0004-v2-data.js --dry-run`: tính toàn bộ, đối chiếu trên trạng thái mô phỏng, **không ghi DB**, lưu báo cáo JSON vào `data/migrations/` (đã gitignore), exit 1 nếu lệch. Không có cờ ⇒ exit 2 (áp dụng chỉ qua runner). |
| `db/migrations/0004-v2-data.test.mjs` | `node --test db/migrations/0004-v2-data.test.mjs` — bộ nhớ giả lập tập lệnh Mongo mà migration dùng; 8 kiểm thử (dry-run không ghi, phân loại/ngoại lệ/rà soát, apply + chạy lại không trùng, M6 bắt lệch, gỡ liên kết/đổi hướng ở v2 không bị ghi đè). |
| `db/migrations/0006-clean-interest-rates.js` | Làm sạch lãi suất cũ về tối đa 2 chữ số thập phân (v2/v2.md §10.1; docs/02_design_system.md §4.3): `bank_debts.interest_rate`, `documents.rollover.new_rate`, `documents.rollover.result.new_rate`, `documents.options.loan.terms.interest_rate`. Làm tròn nửa lên (`9,555` → `9,56`); không phải số (`abc`) → `0` ở khoản vay, `null` ở phiếu. CAS trên giá trị cũ, ghi `history` trước → sau (actor "Migration 0006"), phiếu tăng `version`. Chạy lại không đổi gì. Số 0005 để dành cho bước bỏ trường v1 (§15.4). |
| `db/migrations/0006-clean-interest-rates.test.mjs` | `node --test db/migrations/0006-clean-interest-rates.test.mjs` — 9 kiểm thử: quy tắc làm tròn/chuẩn hoá/không đọc được, ghi lịch sử và version, chạy lại idempotent, CAS khi sửa đồng thời. |
| `apps/api/src/db/seed.ts` | Seed v2: đối tác theo công ty (NH / KH / NCC, "Chưa xác định"), 6 tag, `partner_id` cho mọi phiếu, công nợ KH/NCC (kèm `direction`), khoản vay (`partner_id` = NH, `origin`), khoản chi định kỳ; liên kết cấn trừ mẫu (phiếu thu "Thu bán hàng tháng 8" → công nợ KH-010); `ensureAutomationRules()` (R1…R6). Mật khẩu demo đổi thành `123qweasdzxc` (AGENTS.md). |
| `db/check-tie.js` | Thêm `--v2`: kiểm tra toàn vẹn dữ liệu v2 (chỉ đọc): phủ đối tác, hướng công nợ, liên kết mồ côi / số tiền / tách / khác công ty (lỗi cứng ⇒ exit 1); đối tác hai đầu khác nhau ⇒ cảnh báo. Không có `--v2` thì hành vi như cũ. |

### 15.2 Quy tắc chuyển đổi

- **Khoá đối tác** = (công ty, loại, tên chuẩn hoá, STK). Cùng tên + khác STK ⇒ hai đối tác; thiếu STK ⇒ gộp vào đối tác có STK duy nhất (nhiều STK ⇒ rà soát). Một pháp nhân vừa KH vừa NCC ⇒ hai đối tác. Danh bạ `counterparties` (dùng chung tập đoàn) không tự sinh đối tác: nó chỉ bổ sung tên/STK khi phiếu hoặc công nợ có `counterparty_id`, nên mỗi công ty chỉ có đối tác từ dữ liệu thực của công ty đó.
- **Loại**: công nợ `customer`/`supplier` giữ nguyên; khoản vay ⇒ `bank`, tên "NH – chi nhánh"; phiếu không liên kết: thu ⇒ `customer`, chi ⇒ `supplier` (hoặc `bank` nếu rollover / phiếu thu `create_bank_debt` / tên giống ngân hàng), **đánh dấu cần rà soát** (`partners.migration.key`, mục `inferred_type`).
- **Nhân viên (334)** (M5): không sinh đối tác, không hướng, không liên kết — giữ nguyên.
- **Phiếu có liên kết ⇒ đối tác = đối tác của liên kết** (vì `partnerMatch` §5.1/§11.2): cấn trừ → công nợ; trả nợ / giải ngân → khoản vay; phiếu gắn khoản vay (rollover) → NH. Tên v1 khác ⇒ mục rà soát `link_partner_<loại>`.
- **"Chưa xác định"** (một đối tác mỗi công ty, loại `supplier`): phiếu nội bộ (`kind=internal`, nhãn "Mã công ty – NH – STK" trỏ công ty, phiếu R1), phiếu không tên, khoản chi định kỳ không tên. Đưa vào danh sách rà soát (`unassigned_<lý do>`).
- **M3 liên kết**: `document_links` ⇒ `offset`; `repayment_links` ⇒ `repayment`; R2 (`auto_source_document_id` của khoản vay) ⇒ `disbursement` (số tiền = min(gốc, phiếu thu)) + `origin {automation, R2}`, `disbursed_at` = `created_at`; R1 (phiếu thu tự sinh) ⇒ `internal_transfer` khi khác công ty, **`generated` chỉ khi cùng công ty** (RELATION_SPECS `generated` là `sameCompany`; spec §15 "(+ generated)" không áp dụng được cho cặp khác công ty). Liên kết không tạo lại nếu cặp (từ, đến, quan hệ) đã có ở mọi trạng thái. Ngoại lệ (thiếu phiếu, lệch công ty, sai loại phiếu, số tiền ≤ 0) không migrate, được đếm trong báo cáo và loại khỏi kỳ vọng M6.
- **M3b**: `direction = receivable` nếu `side = debit`, `payable` nếu `side = credit`; không ghi đè hướng đã có (người dùng v2 chọn).
- **M4**: khoản vay giữ trạng thái; không sinh `pending_disbursement`; thiếu `origin` ⇒ `manual`, R2 ⇒ `automation`.
- **M6 (đối chiếu)**: so chỉ tiêu theo khoản và theo công ty giữa v1 suy ra (chỉ phiếu `paid`, khoản chờ/huỷ dư nợ 0) và v2 (`business_links` hiệu lực); phủ đối tác (phiếu, KH/NCC, NH, khoản chi định kỳ) và đúng loại; hướng M3b; M5 không đổi; `Σ cash_entries` mỗi tài khoản trước = sau; số liên kết hiệu lực. Lệch ⇒ `up()` ném lỗi (chạy lại sau khi xử lý). Dry-run đối chiếu trên trạng thái mô phỏng, cùng hàm kiểm tra.
- **Idempotent**: đối tác có `migration.key` và được tái sử dụng (kể cả đối tác tạo tay trùng khoá); trường đã có giá trị không ghi đè; mục rà soát upsert theo (migration, collection, ref_id, reason); ghi lịch sử `migrate_v2` vào `history` của phiếu / công nợ / khoản vay khi có thay đổi.
- **Tóm tắt**: `settings.migration.0004.summary` (apply) và JSON trong `data/migrations/` (dry-run) — số lượng, lý do rà soát, ngoại lệ, chỉ tiêu trước/sau, kết quả từng kiểm tra. Không có tên đối tác/số tiền cá nhân trong báo cáo (chỉ đếm và id).

### 15.3 Vận hành

1. Xem trước (không ghi): `pnpm db:migrate:v2:dry-run` (= `node db/migrations/0004-v2-data.js --dry-run`, cần `MONGODB_URI`). Script npm đã thêm ở vòng hoàn thiện; cách đọc báo cáo: mục 25.2.
2. Áp dụng: `pnpm db:migrate` (đã nằm trong `preDeployCommand`). Lưu ý: preDeploy chạy trước khi thay bản, bản v1 còn phục vụ; giao dịch v1 đồng thời có thể làm M6 lệch ⇒ migration dừng an toàn, chạy lại được. Nên chạy khi ít giao dịch.
3. Sau khi M6 xanh trên production và rà soát danh sách "cần rà soát": (a) chạy `pnpm check:tie -- --v2`; (b) migration 0005 bỏ trường v1 (xem 15.4).

### 15.4 Chưa làm / lệch spec (cần lưu ý)

- **Không xoá trường v1** trong 0004 (§12.4 "thêm trước, bỏ sau"): `payee.*`, `party_*`, `bank_name/branch`, `document_links`, `repayment_links`, `auto_source_document_id`, `create_bank_debt`, `target`, `recurring.payee`, collection `counterparties`. Spec §15 M2 nói "chỉ giữ trong bản sao lưu" — hiện giữ ngay trên bản ghi; bỏ trường để 0005.
- Liên kết v1 không được route v1 ghi vào `business_links` (route v1 chưa nối `createLink`): sau migration, thao tác cấn trừ/trả nợ bằng giao diện v1 chưa phản ánh sang v2 cho tới khi nối route.
- Không tạo đối tác "Nhân viên" (M5, để giai đoạn sau).
- **Chưa chạy trên DB thật**: MongoDB `localhost:27117` không chạy trong phiên này. Kiểm thử bằng bộ nhớ giả lập (`node --test`). Cần `--dry-run` trên DB thật trước khi deploy.
- `generated` cùng công ty (R3) và R1/R2 đầy đủ là việc của agent nghiệp vụ; migration chỉ tạo liên kết lịch sử.
- Mật khẩu test / bootstrap: đã đồng bộ `123qweasdzxc` (seed, `env.ts` cho dev/test, README, runbook, `.env.example`); production bắt buộc `BOOTSTRAP_ADMIN_PASSWORD` (vòng hoàn thiện, §24).

## 14. Web — Đối tác (PartnerPicker · popup Đối tác · màn Đối tác & chi tiết) — v2/v2.md §5.2, §5.3

### 14.1 File
- `apps/web/src/app/v2/partners.ts` — kiểu trên wire và hooks: `usePartnerOptions`, `usePartner`, `usePartnerList`, `usePartnerCopySource`, `usePartnerVouchers`, `usePartnerDebts`, `usePartnerLoans`, `useCreatePartner`, `useUpdatePartner`, `useSetPartnerStatus`, `useDeletePartner`, `useCopyPartners`, `useMergePartner`, `useSettlePartner`; hàm `debtDirectionOf`.
- `apps/web/src/components/partner-picker.tsx` — `PartnerPicker` (ô chọn), `PartnerFormModal` (export để tái dùng), `notifyPartnerWarnings`, `partnerTypesFor`.
- `apps/web/src/screens/partners.tsx` — `PartnersScreen` (`/doi-tac`), `PartnerDetailScreen` (`/doi-tac/:id`), các tab.
- `apps/web/src/screens/partner-dialogs.tsx` — `partnerVoucherHref`, `partnerDebtHref`, `partnerLoanHref`, `DebtDirectionDialog`, `SettlePartnerDialog`, `CopyPartnersDialog`, `MergePartnerDialog`, `TogglePartnerStatusDialog`, `DeletePartnerDialog`.
- Đã xoá `screens/counterparty.tsx`. `routes.tsx`: `/doi-tac` + `/doi-tac/:id`. `shell.tsx`: nhãn "Đối tác". Hook và type `/counterparties` đã bỏ ở vòng hoàn thiện (§20.1).

### 14.2 Dùng PartnerPicker
```tsx
<PartnerPicker value={partnerId} onChange={(id, partner) => …} allowedTypes={['customer', 'supplier']} companyId={companyId} required error={err} />
```
- Loại lọc sẵn (§5.2): phiếu thu/chi `['bank','customer','supplier']`; công nợ `['customer','supplier']`; khoản vay / vay để chi `['bank']`.
- Chỉ chọn đối tác có sẵn (lưu `partner_id`). "+ Tạo đối tác" mở popup trên form (portal, không điều hướng): loại điền sẵn theo `defaultType`/`allowedTypes`, chữ đang gõ điền vào Tên. Lưu xong → chọn sẵn; huỷ → ô giữ nguyên. Cảnh báo trùng trả về sau khi lưu được hiện bằng thông báo (không chặn).
- Gõ để tìm: danh sách chỉ gồm đối tác khớp chữ đang gõ (tên / STK / MST). Khi đang gõ, đối tác đang chọn KHÔNG được thêm vào danh sách (tránh Enter chọn lại đối tác cũ); trong lúc chờ debounce 300 ms hiện "Đang tìm…" thay vì kết quả của chữ cũ. Hàm thuần: `components/partner-picker-options.ts` (có test).
- Ngân hàng / STK / MST hiển thị chỉ đọc dưới ô; "Sửa đối tác" mở popup sửa.

### 14.3 Tham số điều hướng (form phải đọc)
- Thu: `/thu/moi?partner_id=ID&kind=income` (+ `&loan=borrow` khi đối tác là Ngân hàng). Chi: `/chi/moi?partner_id=ID&kind=spend`.
- Ghi nợ KH/NCC: `/cong-no/moi?partner_id=ID&direction=receivable|payable&side=debit|credit`. Ghi nợ NH: `/ngan-hang/khoan-vay/moi?partner_id=ID`.
- Form tương ứng cần đọc `partner_id` (và `loan`, `direction`) để điền sẵn; nếu chưa nối, form mở trống nhưng vẫn lưu được.

### 14.4 Hợp đồng đã đối chiếu với backend `routes/partners.ts`
- `GET /partners/options` → `{items: PartnerRef[]}` (`type`, `q`, `company_id`, `status`).
- `GET /partners/internal-companies` → `{items: {_id, name, code, is_group}}` (mọi công ty đang hoạt động, không theo phân công; chỉ dùng khi tạo đối tác nội bộ). `GET /partners/internal-accounts?company_id=` → `{items: {_id, bank_name, account_name, account_number_masked}}` (TK ngân hàng đang hoạt động, không phải TK nhóm; không có số dư). Cả hai cần `partner:write`.
- `GET /partners` (`type`, `status`, `q`, `period_from`, `period_to`, `limit`, `offset`) → `{items, total, limit, offset, period}`.
- `GET /partners/:id` → tóm tắt **tháng hiện tại** (server không nhận kỳ) + `history[]` (`changes`: `{field: {from, to}}`).
- `POST /partners`, `PATCH /partners/:id` → `{partner, warnings}`; `POST /partners/:id/deactivate|reactivate` → `{partner, warnings}`; `DELETE /partners/:id` → `{ok}`.
- `POST /partners/copy` (`source_company_id`, `partner_ids`, `target_company_id`) → `{created: [{source_id, partner_id, code, name}], warnings}`. Web gửi header scope = công ty nguồn cộng `company_id` khi đọc danh bạ nguồn.
- `POST /partners/:id/merge` body `{target_id, request_id}` → `{partner, moved: {documents, lender_documents, debt_vouchers, bank_debts, recurring_rules}}` (mục 12.10). Nút «Gộp vào…» nằm trong «Thao tác» ở danh sách và «Khác» ở chi tiết (không hiện với đối tác công ty trong tập đoàn); popup chỉ liệt kê đối tác cùng công ty, cùng loại, đang hoạt động.
- `POST /partners/:id/settle` body `{items: [{debt_voucher_id, amount_minor}], loans: [{bank_debt_id, amount_minor, split: {principal, interest, fee}}], note}` → `{partner_id, replayed, vouchers: [{document_id, code, kind, status, amount_minor, title, links}]}`. Mở phiếu nháp đầu tiên; các phiếu còn lại báo ở thông báo.
- Tab: `GET /partners/:id/documents` (`{items: {_id, code, kind, status, title, planned_date, amount, …}}`), `/debts` (`direction`, `value`, `applied`, `remaining`, `due_date`, `overdue_days`, `status`), `/loans` (`principal`, `repaid_principal`, `outstanding`, `maturity_date`, `status`).

### 14.5 Chưa làm / lưu ý
- Màn chi tiết không chọn kỳ được (server tóm tắt tháng hiện tại). Muốn đồng bộ với kỳ đang lọc ở danh sách, backend cần nhận `period_from` / `period_to` trên `GET /partners/:id`.
- Chưa có kiểm tra trùng trước khi lưu (API không có chế độ kiểm tra); cảnh báo chỉ hiện sau khi lưu.
- Chưa chạy trình duyệt: chỉ `pnpm -F @fingate/web typecheck` đã xanh. Không có test UI.

---

## 12. Đối tác — backend (`/partners`, v2/v2.md §5, §14.2) — đã làm

Phạm vi: danh bạ đối tác THEO CÔNG TY (`partners`), lịch sử, cảnh báo trùng không chặn, chặn đổi loại, xoá khi chưa phát sinh, sao chép từ công ty khác, số liệu tóm tắt, dữ liệu các tab, và **Trả nợ** (`settle`). Không có UI.

### 12.1 File

- Domain (mới): `apps/api/src/domain/partner/` — `index.ts` (dịch vụ: tạo / sửa / trạng thái / xoá / sao chép / đọc), `rules.ts` (thuần: ảnh chụp, so sánh lịch sử, kiểm tra bản ghi), `duplicates.ts` (cảnh báo trùng), `type-guard.ts` (chặn đổi loại), `summary.ts` (số liệu tóm tắt + nạp sổ theo lô), `settle.ts` (trả nợ: kế hoạch thuần + thực thi), `voucher-draft.ts` (tạo phiếu nháp), `contracts.ts` (hợp đồng API riêng của màn Đối tác), `merge.ts` (gộp đối tác: điều kiện và thông tin danh bạ sau gộp, thuần).
- Route (mới): `apps/api/src/routes/partners.ts`. Route cũ `routes/counterparty.ts` đã xoá; alias `/counterparties` đã gỡ (§20.1).
- Shared-small-edit: `routes/index.ts` (đăng ký `partnerRoutes`), `routes/schemas.ts` (JSON Schema cho OpenAPI, chỉ thêm cuối file).
- Test (72 test, vitest, thuần): `duplicates.test.ts`, `type-guard.test.ts`, `rules.test.ts`, `summary.test.ts`, `settle.test.ts`, `contracts.test.ts`, `merge.test.ts`, `delete.test.ts`.

### 12.2 Endpoint (`/api/v1`)

| Method | Đường dẫn | Quyền | Ghi chú |
| --- | --- | --- | --- |
| GET | `/partners` | `partner:read` | Danh sách + tóm tắt. Lọc `company_id`, `type` (gộp `a,b` hoặc lặp), `status` (`active|inactive|all`), `q` (tên / STK / MST), `limit` (≤200), `offset`, `period_from`, `period_to`. Trả `{items, total, limit, offset, period}` |
| GET | `/partners/options` | một trong `partner:read`, `doc:read`, `doc:create` | Ô chọn đối tác: `type`, `q`, `status` (mặc định `active`), `limit` (mặc định 20). Trả `{items}` |
| POST | `/partners` | `partner:write` | Tạo. 201 `{data: {partner, warnings}}` |
| POST | `/partners/copy` | `partner:write` | Sao chép từ công ty khác (xem 12.4). 201 `{data: {created, warnings}}` |
| GET | `/partners/:id` | `partner:read` | Chi tiết = tóm tắt + `history` (mới nhất trước) |
| PATCH | `/partners/:id` | `partner:write` | Sửa. Trả `{data: {partner, warnings}}` |
| POST | `/partners/:id/deactivate` · `/reactivate` | `partner:write` | Ngừng / kích hoạt lại (có ghi lịch sử) |
| DELETE | `/partners/:id` | `partner:write` | Chỉ khi chưa phát sinh (kể cả khi chỉ là người cho vay trên phiếu vay), nếu không ⇒ `FG-PARTNER-002` |
| POST | `/partners/:id/merge` | `partner:write` | Gộp `:id` (nguồn, bị xoá) vào `target_id` (đích, giữ lại), cùng công ty và cùng loại (xem 12.10). 200 `{data: {partner, moved}}`; lặp lại cùng `request_id` ⇒ trả lại kết quả cũ |
| GET | `/partners/:id/documents` | `partner:read` + `doc:read` | Tab Phiếu thu/chi. Lọc `status`, `kind`, `limit` |
| GET | `/partners/:id/debts` | `partner:read` + `debt:read` | Tab Công nợ (còn lại, đã cấn trừ, quá hạn, trạng thái) |
| GET | `/partners/:id/loans` | `partner:read` + (`loan:read` hoặc `bank:read`) | Tab Nợ NH (dư nợ, đáo hạn, mức cảnh báo) |
| GET | `/partners/:id/history` | `partner:read` | Tab Lịch sử |
| POST | `/partners/:id/settle` | `partner:write` + `doc:create` + `link:manage` | Trả nợ (xem 12.6). 201 khi tạo mới, 200 khi replay |
| ~~GET/POST~~ | ~~`/counterparties`, `/counterparties/options`~~ | — | đã gỡ (§20.1, mục 12.7) |
| ~~GET/PATCH/DELETE~~ | ~~`/counterparties/:id`~~ | — | đã gỡ (§20.1, mục 12.7) |

Tiền trên wire: `{minor: "123", currency: "VND", decimals: 0}`. Cảnh báo trùng: `{reason: name|bank_account, partner_id, partner_code, partner_name, partner_type, message}`.

### 12.3 Trùng, đổi loại, lịch sử

- **Cảnh báo trùng (không chặn)** trong cùng công ty, kể cả khác loại: cùng tên chuẩn hoá (`normalizeNameKey`) hoặc cùng cặp (ngân hàng, STK) sau chuẩn hoá (bỏ khoảng trắng / gạch / chấm; không phân biệt hoa thường). Chỉ so cặp khi CẢ HAI có giá trị. Khi sửa, loại trừ chính đối tượng đó.
- **Đổi loại** bị chặn bằng `FG-PARTNER-003` khi: đang có khoản nợ NH (không đổi khỏi Ngân hàng); đang là ngân hàng cho vay (`options.loan.lender_partner_id`) hoặc có phiếu liên kết `repayment` / `disbursement` (phải giữ Ngân hàng); đang có công nợ (không đổi sang Ngân hàng). KH ↔ NCC luôn được.
- **Ràng buộc bản ghi**: KH/NCC có số tài khoản ⇒ bắt buộc có ngân hàng (`FG-VAL-001`).
- **Lịch sử**: mọi lần sửa ghi `history[] = {at, actor, changes: {field: {from, to}}}`, chỉ với các trường thực sự đổi; tạo đối tác ghi một mục với `from: null`. Sửa dùng CAS theo `updated_at` (xung đột ⇒ `FG-WF-011`).

### 12.4 Xoá và sao chép

- Xoá ⇒ `FG-PARTNER-002` nếu còn phiếu / công nợ / khoản vay / khoản chi định kỳ / liên kết tham chiếu (liên kết tính qua các đối tượng nói trên), hoặc còn phiếu vay ghi đối tác làm người cho vay (`options.loan.lender_partner_id`). `partnerUsageCounts` là một hàm đếm dùng chung cho kiểm trước khi xoá, kiểm lại sau khi xoá, và việc gộp. `has_activity` ở danh sách và chi tiết tính theo cùng tiêu chí, nên nút «Xoá» tắt sẵn.
- Sao chép: người gọi phải xem được công ty nguồn (toàn tập đoàn, hoặc công ty được gán); nguồn khác đích; mọi `partner_ids` phải thuộc công ty nguồn. Tạo bản sao MỚI (mã mới, `status: active`), ghi `copied_from` vào lịch sử, vẫn cảnh báo trùng.

### 12.5 Số liệu tóm tắt (không lưu, `domain/partner/summary.ts`)

- KH/NCC: `receivable_remaining`, `payable_remaining` = Σ (giá trị − đã cấn trừ). `overdue_amount` = Σ phần còn dư của khoản đã qua hạn (`due_date` trước hôm nay, cả hai hướng). Hướng v1 (`direction` null) suy theo `side` như M3b.
- NH: `outstanding` = Σ (gốc − gốc đã trả); `next_maturity_date` = hạn sớm nhất của khoản còn dư nợ. Khoản chờ giải ngân / đã huỷ = 0.
- Mọi loại: `paid_in_period` / `paid_out_period` = phiếu `paid` (hoặc kỳ chi từng phần `execution.installments`) có ngày trong kỳ. Kỳ mặc định: ngày 1 tháng VN hiện tại → hôm nay.
- Chỉ tiêu "đã cấn trừ / đã trả" chỉ tính phiếu `paid` (như `domain/links`), chỉ đọc `business_links` (liên kết v1 nhúng đã bỏ khỏi tính toán, §20.1).

### 12.6 Trả nợ (`POST /partners/:id/settle`)

Body: `items: [{debt_voucher_id, amount_minor}]` (KH/NCC) hoặc `loans: [{bank_debt_id, amount_minor, split?: {principal, interest, fee}}]` (Ngân hàng); tuỳ chọn `receipt_account_id`, `payment_account_id`, `business_date`, `planned_date`, `note`, `request_id`.

- Kế hoạch thuần (`planSettlement`) kiểm tra TRƯỚC khi ghi: đối tác đang hoạt động; loại Ngân hàng chỉ trả bằng khoản vay, KH/NCC chỉ bằng công nợ; mỗi khoản một lần; khoản thuộc đúng đối tác và công ty; khoản vay đang `active` / `overdue`; sức chứa (công nợ ≤ giá trị − đã phân bổ; khoản vay ≤ gốc − gốc đã phân bổ, tính theo phần gốc khi có tách).
- Thực thi: khoản phải thu ⇒ phiếu THU nháp (`offset`); khoản phải trả ⇒ phiếu CHI nháp (`offset`); khoản vay ⇒ phiếu CHI nháp (`repayment`). Phiếu nháp qua `createDraftVoucher`, liên kết qua `createLink` (đúng quy tắc liên kết, trạng thái `active`, chỉ tính khi phiếu `paid`).
- Lỗi giữa chừng ⇒ gỡ các liên kết vừa tạo (`removeLink`) và xoá các phiếu NHÁP vừa tạo, rồi ném lại lỗi. Không có transaction (ADR-03).
- `request_id` ghi vào `processed_requests` của phiếu nháp; gọi lại cùng đối tác và `request_id` trả đúng các phiếu cũ (`replayed: true`), không tạo thêm.

### 12.7 Alias `/counterparties` — ĐÃ GỠ

Đã gỡ: alias không còn đăng ký ở `routes/index.ts` và file đã xoá (§20.1, §21.1). Không còn client nào gọi `/counterparties`; danh bạ là `/partners`.

### 12.8 Chưa làm / cần lưu ý (cập nhật: mục 24)

1. **Chưa có hàm dùng chung tạo phiếu.** `POST /documents` đặt toàn bộ logic tạo phiếu trong handler (`routes/documents.ts`). `createDraftVoucher` (`domain/partner/voucher-draft.ts`) sao chép các bước lưu của route đó; khi tách được hàm từ route, thay thế ở đây.
2. ~~**Luồng v1 vẫn ghi danh bạ cũ**~~ — ĐÃ XỬ LÝ (§20.1): không còn `ensureCounterparty*` / `syncCounterparties`; collection `counterparties` chỉ còn để migration 0004 đọc (M1).
3. **Chưa chạy với MongoDB thật.** Test chỉ kiểm hàm thuần; index, truy vấn theo lô và CAS chưa được kiểm trên DB.
4. **Trả nợ không tách** ⇒ toàn bộ số tiền được tính là GỐC (đúng với `principalPartOf` của `domain/links`). Giao diện nên gửi `split` khi có lãi / phí.
5. **Chỉ mục cân nhắc:** tìm trùng truy vấn theo `(company_id, name_key)` hoặc `(company_id, account_number)`. Index hiện có `(company_id, type, name_key)` chỉ dùng được tiền tố `company_id` khi truy vấn không có `type`. Nên thêm `(company_id, name_key)` vào `db/indexes.ts` khi danh bạ lớn.
6. Hợp đồng riêng (`contracts.ts`: danh sách, tab, trả nợ) chưa nằm ở `packages/shared`; chuyển sang đó nếu web cần dùng chung kiểu.

### 12.9 Đối tác công ty trong tập đoàn — chọn mọi công ty khi tạo

- Người có `partner:write` tạo đối tác nội bộ tới **mọi công ty đang hoạt động** trong tập đoàn, không chỉ công ty được phân công. Công ty ghi (`company_id`) vẫn phải nằm trong phạm vi; `internalPartnerFieldsFor` chỉ kiểm TK thuộc công ty đã chọn, đang hoạt động, không phải TK nhóm, khác công ty đang tạo và chưa có đối tác cho TK đó.
- Hai endpoint đọc mới (mục 14.4) thay cho `me.companies` và `GET /bank-accounts?for_company` ở `PartnerFormModal`: endpoint sau bị `companyReachableByActor` chặn với công ty không được phân công.
- Đối tác nội bộ lưu STK đầy đủ của TK gốc (như trước), nên ai xem được đối tác của công ty ghi sẽ thấy STK đó. Quyết định sản phẩm: giữ nguyên, đối tác nội bộ lưu và hiện STK đầy đủ. Phiếu chi chọn đối tác nội bộ không kiểm phạm vi công ty nhận ở server (đích lấy từ đối tác, `resolveTransferTarget`); form «Chuyển nội bộ» vẫn yêu cầu công ty nhận được phân công (`routes/documents.ts`, §7.5/§11.6). Quyết định sản phẩm: giữ nguyên, phiếu chi qua đối tác nội bộ không kiểm phạm vi công ty nhận ở server, khác với form «Chuyển nội bộ».

### 12.10 Gộp đối tác (`POST /partners/:id/merge`)

Gộp hai bản trùng thành một: đối tác NGUỒN (`:id`, đối tác đang mở) được gộp VÀO đối tác ĐÍCH (`target_id`, chọn trong popup). Quyết định sản phẩm:
- Chỉ gộp trong **cùng công ty** và **cùng loại** (`FG-VAL-001` nếu khác). Đối tác **công ty trong tập đoàn không gộp** (mỗi TK gốc là một đối tác). Không gộp đối tượng với chính nó.
- Đích **phải đang hoạt động** (sẽ nhận phiếu / công nợ mới). Nguồn có thể đang ngừng giao dịch (thường là bản trùng cần dọn).
- Sau gộp, **nguồn bị xoá khỏi danh bạ**; đích giữ lại mã, tên, loại, trạng thái của mình. Quyền: `partner:write`, như xoá.

Chuyển tham chiếu (lọc theo nguồn, trong cùng công ty):
- `documents.partner_id`; `documents.options.loan.lender_partner_id` (ngân hàng cho vay trên phiếu vay); `debt_vouchers.partner_id`; `bank_debts.partner_id`; `recurring_rules.partner_id`.
- Phiếu / công nợ / khoản vay ghi thêm một mục lịch sử `action: partner.merge` với nhãn «mã · tên» từ → đến (`fields.changes`). Khoản chi định kỳ không có lịch sử nên không ghi.
- Liên kết (`business_links`) không đổi: chúng trỏ tới phiếu / công nợ / khoản vay theo ID. Cache hiển thị trên công nợ / khoản vay (`party_name`, `bank_name`) không sửa, như khi đổi tên đối tác: đọc luôn lấy theo `partner_id`.

Thông tin danh bạ của đích sau gộp (`mergedMasterFields`, thuần):
- Giữ tên / loại / trạng thái của đích. MST trống ở đích lấy từ nguồn. Cặp NH + STK lấy từ nguồn chỉ khi đích chưa có STK. Ghi chú của nguồn nối vào cuối ghi chú đích (`Gộp từ <mã · tên>: …`), không mất.
- Lịch sử đích có mục `changes.merged_from = {from: null, to: "<mã · tên nguồn>"}` cùng các trường đổi; audit `partner.merge` (subject = đích) ghi mã nguồn và số tham chiếu đã chuyển.

Thứ tự thực hiện (không transaction, ADR-03):
1. Đọc đích (kiểm phạm vi), rồi khoá `request_id` (`claimKeyOf('partner.merge', nguồn, request_id)`). Lượt lặp lại ⇒ trả lại kết quả cũ, không đọc nguồn (đã bị xoá).
2. Đọc nguồn, kiểm `mergeProblems`. Lỗi ⇒ nhả khoá.
3. Chuyển tham chiếu; đọc lại số tham chiếu còn trỏ về nguồn. Còn thì chuyển tiếp, tối đa 3 vòng (phiếu mới ghi đúng lúc vẫn được chuyển nốt).
4. Ghi đích (CAS theo `updated_at`; xung đột ⇒ `FG-WF-011`), ghi audit.
5. Xoá nguồn, kiểm lại. Nếu vẫn còn tham chiếu (có phiếu mới gắn vào nguồn đúng lúc xoá) ⇒ khôi phục đúng bản ghi nguồn và báo `FG-WF-011`: gửi lại để gộp nốt.

Lỗi giữa chừng: các bước chuyển đều lọc theo nguồn nên gửi lại (cùng `request_id`) sẽ chuyển nốt phần còn lại; nguồn chưa bị xoá nên vẫn tìm thấy. Web (`MergePartnerDialog`) gửi một `request_id` cho mỗi lần mở hộp thoại.

Chưa làm / lưu ý:
- Không hoàn tác. Không gộp hàng loạt. Không gộp đối tác công ty trong tập đoàn.
- Lỗ hổng cũ đã sửa: trước đây xoá không đếm phiếu vay có người cho vay là đối tác, nên có thể xoá ngân hàng còn được ghi là người cho vay và để lại tham chiếu treo. Nay `partnerUsageCounts` đếm thêm `lender_documents` (xem 12.4). Tham chiếu treo đã tạo trước khi sửa KHÔNG được tự dọn; cần rà soát thủ công.
- Kiểm trên MongoDB trong bộ nhớ bằng test tạm (không commit): index được tạo và được truy vấn dùng (IXSCAN), xoá bị chặn, đổi người cho vay rồi xoá được, gộp vẫn chuyển người cho vay. Chưa kiểm trên DB có dữ liệu thật. Test đơn vị giữ lại: `delete.test.ts`.

## 16. Dashboard · dòng tiền · cảnh báo · bản tin · báo cáo — backend v2 (agent DASH, v2/v2.md §4.2 BỎ, §12)

### 16.1 Số dư chỉ từ sổ cái + dự kiến
- `domain/accounts.ts`: `ledgerAccountViews(scope, {asOf, horizonDays, includeClosed, includeGroup, forCompany})` trả `actual` (Σ sổ cái đến ngày), `planned_in/out`, `projected` (thực tế + phiếu chờ thực thi đến `asOf+30`), `breach` (thực tế < tối thiểu), `breach_projected`. Hàm thuần `composeAccountBalance`.
- `domain/ledger/planned.ts`: phiếu chờ thực thi (`pending.*`, `approved`, `processing`) → `plannedFlowsOf` (chi/đảo hạn → `operating_out`; thu → `operating_in`; thu giải ngân vay → `disbursement_in`; chuyển nội bộ → `internal_out` + `internal_in`). Quá hạn chưa thực thi được kẹp vào ngày bắt đầu.
- `domain/ledger/index.ts`: `recomputeAccountBalances` không còn đọc/ghi `blocked_minor` (vi phạm = sổ cái < tối thiểu). `internalDestOf` ưu tiên `transfer_target` (v2), rơi về `target` (v1) — dùng trong `entriesForPayment` và `entriesForExecutedDocument`. `rebuild/balances.ts` select thêm `transfer_target`.
- Route: `GET /bank-accounts` (`balance`, `projected`, `planned_in/out`, `breach`, `breach_projected`; bỏ `available`/`blocked`), `GET /bank-accounts/balances/history` (bỏ `blocked`/`available`), `GET /rollovers/preparation` (`balance` thay `available`). `POST /internal-transfers` ghi thêm `transfer_target`.

### 16.2 Dashboard
- `GET /dashboard/overview`: lấy bản cache `dashboardOverview` (queries) rồi dựng object MỚI (không sửa cache) với: `kpi.cash_total` (sổ cái; breakdown tiền mặt / ngân hàng / dự kiến 30 ngày), `exceptions` (vi phạm theo sổ cái), `bank.by_bank` (theo đối tác), `receivable_overdue` (theo hướng công nợ), và mới: `partners {top_receivable, top_payable, receivable_total, receivable_overdue_total, payable_total}`, `loans_pending {count, total, items}`, `automation {failed_count, items}`.
- `GET /dashboard/overview?tag_ids=a,b` (v2 §6.2): lọc số liệu THEO PHIẾU theo tag (ít nhất một tag khớp) — `kpi.income_today`, `kpi.spend_today`, `kpi.awaiting_me` + `counts.awaiting_me` + `awaiting_me_rows` + cảnh báo chờ duyệt, `counts.missing_evidence`. Không gắn tag nên luôn toàn phạm vi: `kpi.cash_total`, dự báo, `partners`/công nợ, `bank`, đáo hạn, `loans_pending`, `automation`. ID sai định dạng → 422 FG-VAL-001. Khoá cache `overview`/`badge` có hậu tố tập tag (`domain/queries/dashboard-tags.ts`). Khoá `badge` (`domain/queries/badge-cache.ts`) còn gồm PHẠM VI công ty (`scopeCacheKey`): số "chờ tôi duyệt" đổi theo công ty đang chọn (US-APR-01). `invalidateFor` (route phiếu, sổ quỹ, `notifyNextApprover`) xoá toàn bộ badge; `cacheThrough` không ghi kết quả đọc dở khi có lần xoá xảy ra giữa chừng (`lib/cache.ts`). Ghi phiếu không đi qua các đường này (vd. quy tắc tự động tạo phiếu đã duyệt) chưa xoá badge: số có thể trễ tới `CACHE_TTL_MS` (60 giây).
- Nhóm "Theo tag" trên dashboard dùng `GET /reports/theo-tag?from&to&tag_ids` (cùng cửa sổ 30 ngày với biểu đồ thu–chi, `tag_ids` lọc chung với biểu đồ qua `GET /reports/thu-chi-ngay`). FE: ô lọc `TagFilter` khoá ở "Toàn tập đoàn" (tag thuộc từng công ty), URL `?tag_ids=`.
- `GET /dashboard/today`: số dư sổ cái.
- `domain/reports/dashboard.ts`: `dashboardExtras`, `partnerExposures` (phải thu/phải trả còn lại = giá trị − phân bổ đã thực thi), `bankOutstandingByPartner`, `receivableOverdueTotal`.

### 16.3 Dự báo dòng tiền 7 / 30 / 60 / 90 ngày
- `GET /cashflow/forecast?horizon=7|30|60|90&from=YYYY-MM-DD` (perm `forecast:read`). Trả `opening`, `min_balance`, `totals` (operating_in, disbursement_in, internal_in, operating_out, internal_out, loan_repayment_out, inflow, outflow, net, min_closing, end_closing), `days[]` (mỗi ngày: opening…closing, `breach`), `first_breach_date`, `shortfall_by_company`, `disbursements {dated, undated, undated_total}`, `repayments[]`.
- Không đếm trùng: đầu kỳ = sổ cái đến hết `from`; dòng dự kiến KHÔNG gồm `paid`; khoản vay `pending_disbursement` chưa có phiếu thu giải ngân CÓ HIỆU LỰC (liên kết `disbursement` tới phiếu trong pipeline hoặc đã thực thi; phiếu nháp / trả về chưa tính — `loansCoveredByReceipts`) nằm ở `undated`; lịch trả nợ (`buildSchedule`) chỉ lấy kỳ CHƯA đến hạn và trừ phần đã có phiếu trả nợ trong pipeline (`netInstallments`, xấp xỉ theo số tiền).
- Hàm thuần: `buildForecastSeries`, `netInstallments`, `weekdayOf`, `parseHorizon`.

### 16.4 Cảnh báo
- `domain/alerts/index.ts`: `raiseAlert({alert_type, company_id, severity, text, dedupe_key, subject?, to_roles?, channels?, amount_minor?, href?})` — ghi idempotent theo `dedupe_key`, giao cho KTT mặc định, không ném lỗi ra ngoài. R6 dùng `alert_type: 'source_cancelled_with_money'`, `severity: 3`.
- Loại mới: `automation_run_failed` (evaluator bù cho lượt lỗi chưa có cảnh báo; bỏ qua nếu đã có `automation_failed:<runId>` hoặc `automation_run_failed:<runId>`), `source_cancelled_with_money`. Giữ 8 loại v1. Tên đối tác trong nội dung lấy theo `partner_id`. Thiếu tiền = số dư SỔ CÁI. Dòng tiền âm = `cashflowForecast` 30 ngày.
- Shared (`contracts/admin.ts`): `ALERT_TYPES` và `ALERT_LABEL` có 2 loại mới. `GET /alerts` nhận nhãn cho loại cũ `automation_failed`.

### 16.5 Bản tin
- `domain/newsletter/index.ts`: tiền = sổ cái; dự báo = `cashflowForecast`; thêm mục "Giải ngân & trả nợ sắp tới"; cảnh báo khoản vay chờ giải ngân và lượt tự động lỗi; tên ngân hàng theo `partner_id`. Giữ nguyên shape `Newsletter`.

### 16.6 Báo cáo
- `reportPreset(preset, {…, partnerId?, tagIds?})`; `GET /reports/:preset?partner_id=&tag_ids=a,b` (lọc trên mọi preset phiếu/công nợ/vay).
- Thu–chi (ngày, tháng, theo công ty) LOẠI chuyển nội bộ (`loadInternalDocIds`: kind `internal`, `payee.is_internal`, phiếu thu tự động R1 và phiếu nguồn, hai đầu liên kết `internal_transfer`). Dòng tiền GIỮ chuyển nội bộ: chân ra ở công ty nguồn, chân vào ở công ty đích.
- Công nợ / vay / đáo hạn / chờ duyệt: tên theo `partner_id`; chỉ tiêu đọc `business_links` (đã bỏ `mergeSettlements`, §20.1); chỉ phiếu `paid` tính đã cấn trừ / đã trả gốc. Hướng công nợ: `direction` (v2), v1 suy từ `side` (M3b).
- `so-du-ngan-hang`: số dư thực tế + dự kiến 30 ngày (không còn khả dụng/phong toả).
- Preset mới (shared `REPORT_PRESETS`/`REPORT_LABEL`): `theo-doi-tac` (thu/chi/phải thu/phải trả/dư nợ vay theo đối tác), `theo-tag` (gộp theo `name_key`, "tất cả công ty" cộng chung tag cùng tên), `so-chi-tiet-doi-tac` (cần `partner_id`; `buildPartnerLedger` + `loadPartnerLedgerEvents`: công nợ, khoản vay, phiếu thu/chi; dư lũy kế, dương = đối tác còn nợ công ty, âm = công ty còn nợ).
- Shared `reportQuery`: thêm `partner_id`, `tag_ids` (CSV).

### 16.7 Tìm kiếm
- `GET /search`: khớp đối tác (tên, mã, NH, STK, MST) → đối tác, phiếu/khoản vay/công nợ của đối tác; khớp tag → phiếu có tag. Không đọc text `payee.*`/`party_*`/`bank_name` v1.

### 16.8 Kiểm thử
- Thuần, vitest: `reports/aggregate.test.ts`, `reports/cashflow.test.ts`, `reports/partner-ledger.test.ts`, `ledger/planned.test.ts`, `ledger/transfer-target.test.ts`, `accounts.test.ts` (37 test). `pnpm -F @fingate/api test`: 43 file, 437 test xanh khi bàn giao. Chưa chạy với MongoDB thật (aggregate, `$or` theo phiếu, upsert cảnh báo).

### 16.9 Còn lại (ngoài phạm vi agent này)
1. ~~`domain/queries/index.ts`: `accountSnapshots` tính `blocked/available`; nhãn "Bị hạn chế"~~ — ĐÃ XỬ LÝ (§20.1): số dư theo sổ cái (`closing`), không còn `blocked/available`.
2. `domain/workflow/index.ts` `availableBalanceOf` vẫn trừ `blocked_minor` khi chặn thực thi phiếu chi → nên dùng `bookedBalance` (sổ cái).
3. `routes/admin.ts` `POST /exports`: chưa chuyển `partner_id`/`tag_ids` sang `reportPreset` (cần `partnerId`, `tagIds`); preset `so-chi-tiet-doi-tac` xuất ra rỗng nếu thiếu đối tác.
4. `domain/automation/engine.ts` ghi cảnh báo `automation_failed` trực tiếp: nên đổi sang `raiseAlert({alert_type: 'automation_run_failed', …})`. Hiện đã có evaluator bù, không trùng.
5. Dữ liệu v1 chưa gán `partner_id` hiển thị "Chưa gán đối tác"; tên ngân hàng khoản đáo hạn (rollovers) giữ text v1 khi chưa gán.
6. Dự báo lịch trả nợ bỏ qua kỳ đã qua (không biết kỳ nào đã trả ngoài luồng); netting theo số tiền, không khớp kỳ theo ngày.

## 17. Tự động hoá R1–R6 — bộ quy tắc & bước dùng chung (agent AUTO, v2/v2.md §10.2, §11.3–11.6, §14.3)

### 17.1 Đã làm

- **Bộ máy (`engine.ts`, mở rộng — API cũ giữ nguyên)**: `RuleHandler.occurrenceEvents` — với các sự kiện này, mỗi lần xảy ra là một lượt riêng, khoá = `rule:source:event#<id sự kiện>` (`runKeyFor`). Dùng cho R2 (`voucher.updated`, `voucher.submitted`), R5 (`schedule.recurring`), R6 (`voucher.cancelled`, `voucher.rejected`). Các sự kiện khác vẫn theo khoá chuẩn §14.2. Retry cùng sự kiện ⇒ cùng khoá, không sinh lượt thứ hai.
- **`ensureAutomationRules`**: ngoài `$setOnInsert` (giữ chỉnh sửa của người dùng: bật/tắt, tham số, phạm vi), mỗi lần khởi động đồng bộ phần do code định nghĩa: `name`, `trigger_event`, `trigger_events`, `condition`, `steps`. Nhờ đó DB đã có sẵn nhận được sự kiện mới của R2.
- **Bước dùng chung** (`domain/automation/actions/`): `createAutoVoucher` (create_voucher: phiếu ĐÃ DUYỆT, kế thừa chuỗi duyệt, `origin`, lịch sử `auto_create`, audit, `voucher.created`); `executeAutoVoucher` (execute_voucher: gọi đúng `transition(pay)` — sổ cái, lịch sử, audit, `voucher.paid`; `request_id` = khoá bước); `createAutoLoan` / `syncAutoLoan` / `activateLoan` / `cancelLoan` / `reviveLoan` (create_loan · activate_loan · huỷ khoản vay, theo quy ước route nợ NH: mã NHD, lịch sử, audit, `loan.created`); `ensureAutomationLink` (link: `createLink`/`removeLink`, idempotent, đổi số tiền ⇒ gỡ rồi tạo lại); `raiseAutomationAlert` (notify/alert, chống lặp bằng `dedupe_key`).
- **Quy tắc** (`domain/automation/rules/`):
  - R1 `r1-internal-transfer.ts` — `voucher.paid` phiếu chi có `transfer_target` (theo ID): tạo phiếu thu đã duyệt ở công ty đích → thực thi → `internal_transfer`. Không đọc chuỗi "Mã công ty - NH - STK" nữa.
  - R2 `r2-borrow-receipt.ts` — `options.loan.kind=borrow`: mode `new` tạo khoản vay (gốc = số tiền phiếu, đối tác ngân hàng bắt buộc, kỳ hạn 12 tháng, hạn mặc định = ngày gốc + 11 tháng; `r2_create_at` = save|approve); phiếu còn trước duyệt ⇒ đồng bộ đối tác / gốc / điều khoản / liên kết mỗi lần sửa; mode `existing` ⇒ gắn `disbursement` vào khoản có sẵn với nguồn **Thủ công** (`ensureManualLink`, không lượt chạy; kiểm công ty, đối tác qua `createLink`). Liên kết này do NGƯỜI DÙNG chọn nên được ghi NGAY khi lưu phiếu (`linkChosenLoanOnSave`, `routes/documents.ts` POST/PATCH, `domain/vouchers/refs.ts`), không phụ thuộc quy tắc R2 bật/tắt; sức chứa khoản vay (gốc, trừ chính phiếu đang sửa) được kiểm ngay trong `resolveLoanPlan` → `assertLoanDisbursementCapacity` (FG-LINK-002, 422) trước khi lưu; khoản tự sinh ghi nguồn Tự động; `later` ⇒ không làm gì (huỷ khoản tự sinh chưa giải ngân nếu đổi lựa chọn). Khi `paid` ⇒ khoản vay `Đang vay`, ngày giải ngân = ngày thực thi, gốc = số thực thu (khoản tạo tay giữ gốc). `linkChosenLoanOnSave` nhận kế hoạch ĐÃ LƯU (`previous`): đổi từ "khoản có sẵn" sang vay mới / để sau / bỏ cờ ⇒ gỡ liên kết Thủ công tới khoản đó (R2-20/21/22; liên kết gán tay từ tab Liên kết giữ nguyên). Bước `link` của mode `existing` và bước `activate_loan` chỉ liệt kê khoản do R2 SINH RA là "đã tạo" (panel Quy trình tự động); khoản người dùng chọn không được liệt kê như đối tượng sinh ra.
  - R3 `r3-fund-by-loan.ts` — `voucher.approved` phiếu chi `options.loan.kind=fund`: create_loan (khoản vay + `funded_by`; số tiền theo `resolveLoanAmount`) → create_voucher (phiếu thu đã duyệt, kế thừa chuỗi duyệt, nội dung "(Tự động) Giải ngân vay cho phiếu chi …") → link (`generated` chi→thu, `disbursement` thu→vay) → execute_voucher (ngày = ngày duyệt cuối của phiếu chi) → activate_loan. Phiếu chi giữ `Đã duyệt`. Màn duyệt / decision-pack (`domain/queries` `pendingFundingInflowFor`): trước duyệt cuối, khoản giải ngân về TK nguồn (TK nhận = TK nguồn, R3 đang bật, chưa có phiếu thu R3) được cộng vào «Sau giao dịch» vì chưa vào sổ cái; đã duyệt cuối (khoản đã nằm trong sổ) thì không cộng thêm.
  - R4 `r4-loan-settled.ts` — `loan.settled` ⇒ cảnh báo nhắc lưu trữ / giải chấp TSĐB. Tắt mặc định.
  - R5 `r5-recurring.ts` + `domain/recurring/index.ts` — tác vụ `recurring` nay chỉ phát `schedule.recurring` (mỗi khoản, mỗi kỳ; không phát trùng khi sự kiện đang chờ); R5 tạo phiếu nháp qua `createRecurringDraft` (idempotent theo lịch sử `recurring_materialize`, đối tác theo `partner_id`, đứng tên KTT của công ty). Nhắc 7/3/1 ngày vẫn ở tác vụ này.
  - R6 `r6-cancel-generated.ts` — `voucher.cancelled` / `rejected` (chỉ khi trạng thái hiện tại vẫn huỷ/từ chối; đã gửi lại thì bỏ qua): khoản do quy tắc sinh từ phiếu này và chưa có tiền ⇒ huỷ; khoản chỉ gắn THỦ CÔNG vào phiếu (tạo tay, không do phiếu sinh ra) ⇒ chỉ gỡ liên kết (liên kết của phiếu đã huỷ/từ chối không còn hiệu lực), không cảnh báo và không huỷ, kể cả khi khoản đã có tiền; khoản do quy tắc sinh từ phiếu này đã có tiền ⇒ chỉ cảnh báo KTT (`source_cancelled_with_money`), giữ liên kết, không tự huỷ (`decideOnSourceFinal`, `alertLoansOfSource`).
  - R7 `r7-offset-on-approval.ts` — `voucher.approved` phiếu thu / chi có cấn trừ khoản vay: gán liên kết tới khoản đã chọn khi duyệt xong (chi tiết §27).
- **Thuần (có test)**: `policy.ts` — điều khoản mặc định (`resolveLoanTerms`), số tiền vay R3 (`resolveLoanAmount`), ngày duyệt cuối (`finalApprovalDateOf`), quyết định R6 (`decideOnSourceFinal`), thời điểm R2 (`mayCreateLoan`, `mayFollowLoanEdits`, `mayReviveLoan`); `params.ts` — tham số theo quy tắc (`checkRuleParams`).
- **Khoá số tiền R3** (`automation/locks.ts`, dùng trong `workflow.transition`): sau khi R3 đã chạy, đổi `amount_minor` khi duyệt hoặc `actual_amount_minor` khi thực thi ⇒ `FG-VAL-001`.
- **Route** (`routes/automation.ts`, đăng ký trong `routes/index.ts`):
  - `GET /automation/rules?company_id=` — quy tắc + hiệu lực theo công ty (`doc:read | loan:read | automation:config`);
  - `PATCH /automation/rules/:id` — bật/tắt, tham số (kiểm theo quy tắc), `company_ids`, `company_overrides` (`automation:config`, có kiểm phạm vi, ghi audit);
  - `GET /automation/runs?status&rule_code&company_id&source_type&source_id&limit` — lượt chạy theo bộ lọc, giới hạn theo phạm vi;
  - `GET /automation/runs/by-source?source_type=document|bank_debt&source_id=` — panel "Quy trình tự động" (mặc định bỏ lượt mà mọi bước "bỏ qua"; `include_skipped=true` để xem hết); mỗi bước có đối tượng sinh ra kèm mã, trạng thái, đường dẫn;
  - `POST /automation/runs/:id/rerun` — chỉ lượt lỗi; quyền: kế toán trưởng hoặc `automation:config`.
- **Workflow (`workflow/index.ts`, sửa tối thiểu)**: bỏ 7b/7c (v1 `createAutoIncomeForSpend`, `createAutoBankDebtForIncome`); thêm khoá số tiền R3; miễn step-up cho phiên tự động (`session_id = automation`) khi `APPROVAL_STEP_UP=true`.
- **Đã xoá**: `workflow/auto-bank-debt.ts`, `workflow/auto-income.ts` (cùng test). `AUTO_INCOME_PREFIX` chuyển vào `rules/r1-internal-transfer.ts`.
- **Jobs (`jobs/index.ts`)**: `recurring` ⇒ `runRecurringTick()` rồi `drainAutomation()` ngay trong tác vụ, để R5 tạo phiếu nháp không phụ thuộc tiến trình chạy liên tục (Profile C không có chu kỳ trong tiến trình).

### 17.2 Khoá & nhận diện đối tượng sinh ra (idempotency, không transaction — ADR-03)

| Đối tượng | Tìm lại khi chạy lại / lượt khác |
| --- | --- |
| Khoản vay R2/R3 | liên kết hiệu lực từ phiếu nguồn (`disbursement` từ phiếu thu; `funded_by` từ phiếu chi), kiểm `origin.kind=automation` và `rule_code`; chưa có liên kết ⇒ `origin.run_id` của lượt |
| Phiếu thu R1/R3 | `origin.run_id` + `origin.rule_code` (+ `kind`) |
| Phiếu nháp R5 | lịch sử `recurring_materialize` của khoản (`fields.rule_id`, `fields.period`) |
| Liên kết | `ensureAutomationLink`: cặp + quan hệ đang hiệu lực ⇒ dùng lại; trùng khi chạy song song ⇒ đọc lại |
| Thực thi | `request_id` = khoá bước ⇒ `transition` trả `skipped` nếu đã xử lý |

### 17.3 Việc còn lại / phụ thuộc (ngoài phạm vi agent AUTO)

1. **`routes/documents.ts`** (POST/PATCH): phải GHI `options.loan` (cần map `amount_minor` → BigInt, `terms`), `transfer_target` (`{company_id, account_id}`) và phát `voucher.updated` với `options` MỚI (payload `loan_kind` lấy từ phiếu truyền vào). Chưa có các trường này thì R1/R2/R3 không chạy.
2. **Cờ v1 `create_bank_debt`** không còn sinh khoản vay (đường v1 đã bỏ). Phiếu đang dở cần chuyển sang `options.loan` (mode `new`) — quyết định của route/migration, không tự động.
3. **Chuyển nội bộ v1 theo chuỗi** không còn tự sinh phiếu thu: cần đặt `transfer_target` khi lập phiếu chi (`finance.ts` / `documents.ts`).
4. ~~Khoản vay chưa có trường số HĐ tín dụng và TSĐB: hai thông tin này được ghi vào `note` của khoản vay sinh tự động.~~ — ĐÃ XỬ LÝ: R2/R3 ghi `contract_no` / `collateral` (`termFields`); sửa phiếu trước duyệt đồng bộ hai trường này (`syncAutoLoan`, `changedFieldsOf`); ghi chú khoản vay tự sinh chỉ còn nguồn sinh và không bị ghi đè khi đồng bộ.
5. R1 không tạo liên kết `generated` (ràng buộc `generated` là cùng công ty); chỉ có `internal_transfer`.
6. R2 phụ thuộc route PATCH phát `voucher.updated` đúng (xem 1). Bỏ cờ vay khi phiếu còn chờ duyệt chưa tự huỷ khoản chờ giải ngân (quy tắc chỉ chạy khi `loan_kind=borrow`).
7. Lượt R2 sinh một lượt cho mỗi lần sửa phiếu vay (có thể nhiều dòng trong panel; mặc định ẩn lượt "bỏ qua").
8. R5 đổi hành vi so với v1: phiếu nháp định kỳ v1 truyền `created_by = null` (trường bắt buộc ⇒ không lưu được). v2 đứng tên KTT của công ty; nếu công ty chưa có KTT, lượt lỗi và có cảnh báo.
9. Tên sự kiện lịch dùng `schedule.recurring` (như quy tắc seed R5 của §11.3), không phải `recurring.due`.
10. Chưa có kiểm thử tích hợp MongoDB: các bước đọc/ghi DB chưa được chạy trên DB thật. Tính đúng đắn khi chạy lại dựa trên thiết kế (CAS theo status, unique `idem_key`, `dedupe_key`).

### 17.4 Kiểm thử

- `apps/api/src/domain/automation/policy.test.ts` — điều khoản vay mặc định (12 tháng, hạn = ngày gốc + 11 tháng, lùi về ngày cuối tháng), số tiền vay theo duyệt cuối, ngày duyệt cuối (giờ VN), quyết định R6, thời điểm R2, kiểm tham số quy tắc.
- `apps/api/src/domain/automation/engine.keys.test.ts` — khoá lượt theo sự kiện (mặc định và theo lần xảy ra), đăng ký bộ xử lý, định nghĩa R1…R6 mặc định.
- `apps/api/src/domain/recurring/recurring.test.ts` — nhãn kỳ, ngày phát sinh kế tiếp.
- `pnpm -F @fingate/api test`: các test của agent AUTO xanh. `domain/reports/aggregate.test.ts` (file `reports/` của agent khác, đang dở) đang đỏ — không thuộc phạm vi này.
- `pnpm -F @fingate/api typecheck`: không còn lỗi trong file của agent AUTO (lỗi còn lại thuộc `routes/dashboard.ts`, `routes/finance.ts` của agent khác).

---

## 18. Web — Công nợ & nợ ngân hàng (agent WEB-DEBT — v2/v2.md §9, §10, §11.4–11.5, US-DEBT-01…04, US-LOAN-01…03, US-AUTO-02, US-AUTO-08)

**Đã làm**: màn Công nợ (danh sách, tuổi nợ, tạo/sửa có chọn đối tác và hướng, chi tiết có cấn trừ), màn Nợ ngân hàng (danh sách có trạng thái vòng đời, nhập theo lô bằng mã đối tác, tạo/sửa, chi tiết có chuỗi liên quan, gán giải ngân, gán trả nợ có tách gốc/lãi/phí, huỷ, lưu trữ), Bảng đáo hạn có mục "Sắp giải ngân". Không chạy trình duyệt (AGENTS.md). Khi bàn giao: `pnpm -F @fingate/web typecheck` xanh, ESLint sạch trên các file của mình, `vitest run src/app/v2/debts.test.ts` 8/8 (hàm thuần).

**File**
- Mới: `apps/web/src/app/v2/debts.test.ts` (test hàm thuần), `apps/web/src/app/v2/debts.ts` — kiểu trên wire (`DebtRow`, `DebtDetail`, `OffsetLinkRow`, `DebtAgingResult`, `LoanRow`, `LoanDetail`, `LoanLinkRow`, `LoanScheduleResult`, `DocCandidate`…), hàm thuần (`minorOf`, `voucherHref`, `principalOfSplit`, `canAssignDisbursement`, `canAssignRepayment`, `canCancelLoan`, `canArchiveLoan`, `canEditLoan`, `originLabel`, `directionFromSide`, `accountCodeOf`), và hooks (`useDebtList`, `useDebtAging`, `useDebt`, `useDebtOffsetCandidates`, `useCreateDebt`, `useUpdateDebt`, `useDeleteDebt`, `useAssignDebtOffset`, `useRemoveDebtOffset`, `useLoanList`, `useLoan`, `useLoanSchedule`, `useLoanCandidates`, `useCreateLoan`, `useUpdateLoan`, `useDeleteLoan`, `useCancelLoan`, `useArchiveLoan`, `useAssignDisbursement`, `useAssignRepayment`, `useRemoveLoanLink`, `useImportLoans`).
- Viết lại: `apps/web/src/screens/debt.tsx` (`DebtListScreen`, `DebtVoucherFormScreen`, `DebtDetailScreen`; xuất thêm `OwnerAttachmentSection`, `RemoveLinkModal`), `apps/web/src/screens/bank-debt.tsx` (`BankDebtListScreen`, `BankDebtFormScreen`, `BankDebtDetailScreen`, `LoanScheduleScreen`), `apps/web/src/screens/loans.tsx` (`RolloversScreen` có mục "Sắp giải ngân", `RolloverPreparationScreen`). Tên export giữ nguyên để `routes.tsx` không đổi.
- Shared-small-edit (chỉ phần công nợ/nợ NH): `apps/web/src/app/types.ts` bỏ `BankDebtRow`, `BankDebtDetail`, `LoanScheduleRow/Result`, `DebtVoucherRow/Detail`, `DebtPartyType/Side`, `LinkCandidate` (đã chuyển sang `v2/debts.ts`); `apps/web/src/app/queries.ts` bỏ 18 hook công nợ / nợ NH v1. Giữ `useRollovers`, `useRolloverPreparation`, `useRolloverResult`, hook `counterparties` v1.

**Endpoint đã đối chiếu** (`routes/debt.ts`, `routes/bank-debt.ts`): `GET /debts`, `/debts/aging`, `/debts/:id`, `/debts/:id/link-candidates`; `POST /debts`, `/debts/:id/links`; `PATCH|DELETE /debts/:id`; `DELETE /debts/:id/links/:linkId` (body `{reason}`); `GET /bank-debts`, `/bank-debts/:id`, `/:id/schedule`, `/:id/disbursement-candidates`, `/:id/repayment-candidates`; `POST /bank-debts`, `/bank-debts/import` (dòng: `partner_code`), `/:id/cancel`, `/:id/archive`, `/:id/disbursements`, `/:id/repayments` (`amount_minor` + `split`); `PATCH|DELETE /bank-debts/:id`; `DELETE /bank-debts/:id/disbursements|repayments/:linkId`; `GET /rollovers`, `/rollovers/preparation` (đọc `balance`).

**Hành vi trên màn**
- Công nợ: đối tác chọn bằng `PartnerPicker` (KH / NCC); hướng chọn bằng hai nút Phải thu / Phải trả, không suy từ loại đối tác; TK hiển thị theo loại đối tác (131 / 331). `?partner_id`, `?direction` (và `?side` của v1) điền sẵn form. Khoản đã có cấn trừ khoá đổi đối tác / hướng. Nhân viên (334) chỉ đọc. Chi tiết: bảng cấn trừ (mã phiếu, trạng thái phiếu, số tiền phân bổ, "Đã cấn trừ" chỉ khi phiếu đã thực thi, "Chờ thực thi — chưa trừ" nếu chưa, "Không còn hiệu lực" nếu phiếu đã huỷ / từ chối / hết hạn, nguồn Thủ công/Tự động), dialog gán phiếu cùng đối tác đúng loại (tuỳ chọn số tiền), gỡ cấn trừ có lý do ≥ 5 ký tự, còn lại / quá hạn / nhóm tuổi nợ do server trả về.
- Nợ NH: đối tác là ngân hàng (`PartnerPicker` chỉ loại Ngân hàng), bỏ ô tên / chi nhánh tự do. Trạng thái: nhãn và màu lấy từ `BANK_DEBT_STATUS_REGISTRY` ("Chờ giải ngân", "Đã huỷ", …). Chi tiết: chuỗi đầy đủ (phiếu chi được tài trợ, phiếu thu giải ngân, phiếu chi trả nợ kèm gốc / lãi / phí); badge "Tự động" + liên kết phiếu nguồn khi khoản do quy tắc sinh. Gán phiếu trả nợ: nhập tổng, lãi, phí; gốc = tổng − lãi − phí (âm ⇒ báo lỗi), gửi kèm `split`. Huỷ (chỉ khi chờ giải ngân, bắt buộc lý do), lưu trữ (khi tất toán).
- Bảng đáo hạn: dư nợ và bảng đáo hạn chỉ có khoản đang vay / quá hạn (server đã lọc). Bảng "Dư nợ theo ngân hàng" lấy `GET /bank-debts?summary=true` (`by_bank`, không tải cả danh sách). Mục "Sắp giải ngân" lấy `GET /bank-debts?status=pending_disbursement`, hiện tổng và số khoản, không cộng vào dư nợ.
- Gói quyết định (7 câu hỏi) của cấp duyệt: `GET /documents/:id/decision-pack?source_account_id=` tính q5/q6 theo TK đang chọn ở ô "Tài khoản nguồn" (không có tham số thì theo TK đã lưu trên phiếu). Phiếu đã thực thi luôn theo TK đã ghi sổ.
- Nhập theo lô (.tsv): cột 1 là MÃ đối tác ngân hàng (DT-…); mã được đối chiếu với danh sách ngân hàng đang hoạt động ngay ở bước xem trước. Không khớp theo tên.

**Chưa làm / lưu ý**
1. Bảng mẫu Google Sheets cũ có cột tên ngân hàng ở cột 1; người dùng cần đổi sang mã DT-… (hình hướng dẫn cũ đã bỏ, không có hình mới).
2. ~~Số hợp đồng tín dụng, TSĐB của khoản vay chưa có trường riêng (schema không có) — đang nhập vào ghi chú.~~ — ĐÃ XỬ LÝ: khoản vay có `contract_no` và `collateral` (R2/R3 ghi vào trường riêng).
3. Liên kết `funded_by` (phiếu chi được tài trợ) chỉ hiển thị; không có nút gán tay (đi qua quy tắc R3).
4. ~~Dư nợ trong bảng đáo hạn còn tính `repayment_links` v1~~ — ĐÃ XỬ LÝ (§20.1): `maturityLadder` dùng `business_links`.
5. Tuổi nợ có cả khoản nhân viên (TK 334, chỉ đọc) vì API không lọc mặc định.
6. Hook `useCounterparties` (v1) không còn được màn công nợ dùng; vẫn export trong `queries.ts` cho phần khác.
7. Chưa có test UI / unit cho web (vitest chạy với `passWithNoTests`); chưa chạy trình duyệt (AGENTS.md cấm `pnpm dev`).

## 19. Web — Dashboard · dòng tiền · báo cáo · cảnh báo · tự động hoá · khoản chi định kỳ (agent WEB-DASH — v2/v2.md §4.2, §11.7, §12, §13)

Chỉ UI và hook phía web; không đổi API, contract hay shared. Đã đối chiếu với `routes/dashboard.ts`, `routes/finance.ts`, `routes/automation.ts`, `routes/admin.ts`, `domain/automation/queries.ts`, `domain/reports/{dashboard,cashflow}.ts`.

### 19.1 File

- Mới: `apps/web/src/app/v2/exec.ts` — kiểu trên wire và hook: `useCashflowForecast`, `useAutomationRules`, `useUpdateAutomationRule`, `useAutomationRuns`, `useRerunAutomationRun`, `useRecurringRules`, `useCreateRecurring`, `useAckAlert`; hàm `automationAccess(can, role)`; hằng `RULE_PARAM_FIELDS`, `AUTOMATION_EVENT_LABEL`, `AUTOMATION_STEP_LABEL`.
- Mới: `apps/web/src/screens/automation.tsx` — `AutomationScreen` (`/quantri/tu-dong`, 3 tab: Quy tắc · Lượt chạy · Loại liên kết).
- Viết lại: `screens/dashboard.tsx`, `screens/cashflow.tsx` (giữ `CashflowHistoryScreen`), `screens/bank.tsx`, `screens/reports.tsx`, `screens/misc.tsx` (`AlertsScreen`), `screens/admin.tsx` (thêm `RecurringScreen` cuối file, `ADMIN_TABS` hỗ trợ nhiều quyền).
- Sửa nhỏ: `screens/bank-account-form.tsx` (chữ hướng dẫn: số dư lấy từ sổ cái); `app/types.ts` (xem 19.5); `app/queries.ts` (1 dòng: kiểu `useBankAccounts` có `totals`); `routes.tsx` (3 route + `PATH_PERMS`); `components/shell.tsx` (mục rail "Cảnh báo").

### 19.2 Dashboard (`/dashboard`)

- Thêm từ `/dashboard/overview`: "Phải thu theo đối tác" và "Phải trả theo đối tác" (top 5, còn lại, quá hạn, bấm tên mở `/doi-tac/:id`); "Dư nợ theo ngân hàng" (`bank.by_bank`, gộp theo đối tác); "Khoản vay chờ giải ngân" (không tính vào dư nợ); "Quy trình tự động lỗi" (`automation.items`, link tới phiếu nguồn; link "Lượt chạy" chỉ khi `automationAccess(...).view`).
- Nút "Dự báo dòng tiền" ở đầu trang → `/dong-tien?view=forecast`.

### 19.3 Dòng tiền (`/dong-tien`)

- Hai tab trên URL `?view=`: **Lịch sử** (mặc định, giữ nguyên v1) và **Dự báo** (`view=forecast`).
- Dự báo: 7/30/60/90 ngày (`GET /cashflow/forecast`); KPI đầu kỳ, thu, chi, thuần, cuối kỳ, thấp nhất; cảnh báo đỏ từ `first_breach_date`; thiếu tiền theo công ty; bảng từng ngày (ngày dưới tối thiểu tô đỏ); "Giải ngân sắp tới" (phiếu thu vay có ngày + khoản chờ giải ngân chưa có ngày, không cộng vào dòng); "Lịch trả nợ vay" (kỳ chưa đến hạn, link lịch trả).

### 19.4 Tài khoản tiền (`/ngan-hang/taikhoan`)

- Bỏ cột "Khả dụng" và trạng thái "Bị phong tỏa" nhập tay/tính cũ. Cột mới: "Số dư sổ cái" (đỏ nếu `breach`), "Dự kiến 30 ngày" (▲ nếu `breach_projected`). Trạng thái tài khoản vẫn có `Phong toả` (§4.1). KPI đầu bảng: `totals.balance`, `totals.projected`.
- Phân trang phía máy chủ: `GET /bank-accounts?page=&limit=&kind=` (`page`/`limit` bật chế độ trang, mặc định 50 dòng/trang, tối đa 200; `kind` = `bank` | `cash`). `items` chỉ gồm một trang, `total` = số TK khớp `kind`. `totals` (KPI) luôn tính trên mọi TK trong phạm vi, không theo `kind` hay trang. Không gửi `page`/`limit` ⇒ trả toàn bộ (bộ chọn tài khoản ở phiếu, duyệt, đối tác dùng kiểu này). Lọc Tiền mặt / Ngân hàng chuyển lên máy chủ — trước đây lọc trên các dòng đã tải nên sai khi có nhiều trang.

### 19.5 Kiểu chung (`app/types.ts`, sửa tối thiểu)

- `DashboardOverview`: thêm `partners?`, `loans_pending?`, `automation?`; `bank.by_bank[].partner_id?`. Kiểu mới: `PartnerExposureWire`, `DashboardPartnersWire`, `DashboardLoansPendingWire`, `DashboardAutomationWire`.
- `BankAccountRow`: thêm `projected?`, `planned_in?`, `planned_out?`, `breach_projected?`; **bỏ `blocked`**; `available?` đánh dấu `@deprecated`.
- `RolloverPreparation`: thêm `balance`; `available?` đánh dấu `@deprecated`.
- `AlertRow`: theo đúng `GET /alerts` — `_id`, `type_label`, `severity`, `company_id`, `created_at`, `acknowledged_at` (trước đây `id`, không khớp server).
- `ReportPresetMeta.needs_partner?`.

### 19.6 Báo cáo (`/baocao/:preset`)

- Bộ lọc: kỳ, **đối tác** (`PartnerPicker`, mọi loại) và **tag** (`TagFilter`, theo công ty đang chọn; "Toàn tập đoàn" khoá tag). Gửi `partner_id`, `tag_ids` (CSV) lên `GET /reports/:preset`.
- `so-chi-tiet-doi-tac` chưa chọn đối tác ⇒ không gọi API, hiện hướng dẫn chọn đối tác.
- **Sửa lỗi có sẵn**: `POST /exports` yêu cầu `kind` và `format` — web trước đây không gửi nên xuất Excel lỗi. Nay gửi `{kind:'report', preset, format:'xlsx', query:{from,to}}`.
- Khi đang lọc đối tác/tag, nút Xuất Excel **bị khoá** kèm thông báo: `POST /exports` hiện bỏ qua `partner_id` / `tag_ids` nên file sẽ sai phạm vi (xem 19.8).

### 19.7 Cảnh báo (`/canh-bao`, mục rail "Cảnh báo")

- Trước đây `AlertsScreen` không được gắn route. Nay: lọc "Chưa xử lý / Tất cả" và theo loại (`ALERT_LABEL`, gồm `automation_run_failed`, `source_cancelled_with_money`), nhãn `type_label` từ server, link "Mở", nút "Đã xử lý" (`PATCH /alerts/:id/ack`, cần `alert:config`).

### 19.8 Tự động hoá (`/quantri/tu-dong`, tab trong khu Quản trị)

- Quyền vào màn: `automation:config` hoặc `audit:read` (route và tab cùng điều kiện; kế toán trưởng có `audit:read`). Chạy lại: kế toán trưởng hoặc `automation:config` (khớp server).
- **Quy tắc**: chọn công ty (mặc định công ty đang chọn). Bật/tắt theo công ty = ghi đè `company_overrides`. PATCH của server **thay toàn bộ danh sách ghi đè**, nên web luôn gửi lại ghi đè của các công ty khác. Công tắc "toàn hệ thống" (`enabled`) có hộp xác nhận. Sửa tham số R2 (kỳ hạn 1–600 tháng, lệch hạn 0–36 tháng, thời điểm tạo khoản vay: lưu / duyệt) và R3 (kỳ hạn, lệch hạn) — đúng `domain/automation/params.ts`.
- **Lượt chạy**: lọc trạng thái / quy tắc / công ty (mặc định mọi công ty trong phạm vi); bảng và drawer chi tiết (từng bước, lỗi, đối tượng đã sinh có link). "Chạy lại" chỉ với lượt `failed`, có xác nhận.
- **Loại liên kết** (chỉ đọc): 6 quan hệ `BUSINESS_LINK_RELATIONS`, từ → đến, lúc có hiệu lực, ràng buộc khi gán (theo `RELATION_SPECS` của `domain/links`), đối tượng hai đầu, nguồn và trạng thái. Nội dung là bảng tĩnh trong web, không có endpoint.

### 19.9 Khoản chi định kỳ (`/quantri/dinh-ky`, tab "Chi định kỳ")

- Trước đây web không có màn này. Nay: danh sách (`GET /admin/recurring`) và tạo (`POST /admin/recurring`, cần `doc:create`).
- Bên nhận chọn bằng `PartnerPicker` (mọi loại, theo §5.2). `payee` (v1, server vẫn bắt buộc) lấy từ đúng đối tác đã chọn; không nhập tự do. Nhắc `remind_days` = 7/3/1.

### 19.10 Còn lại / phụ thuộc (ngoài phạm vi agent này)

1. `screens/document-detail.tsx` (`CashTab`) đọc `acc?.available` từ `useBankAccounts` → server không còn trả, nên hiện "Chưa có số dư". Đổi sang `acc?.balance`.
2. `screens/loans.tsx` đã đọc `d.balance` (không còn `available`) — không cần sửa thêm.
3. `routes/admin.ts` `POST /exports` không chuyển `partner_id` / `tag_ids` sang `reportPreset`. Khi sửa, bỏ khoá xuất Excel ở `reports.tsx` (`exportable`, thông báo "chưa áp dụng bộ lọc").
4. `GET /admin/recurring` không trả `partner_id` / tên bên nhận nên danh sách không hiện đối tác; `GET /automation/runs` không có mã và loại phiếu nguồn (chỉ hiện id rút gọn). Cần bổ sung ở server để hiển thị đầy đủ.
5. Không có endpoint sửa / xoá khoản chi định kỳ (chỉ tạo và liệt kê).

### 19.11 Xác minh

- `pnpm -F @fingate/web typecheck`: đạt (exit 0).
- ESLint trên các file đã sửa: không lỗi; còn 1 cảnh báo có sẵn ở `components/shell.tsx` (react-hooks/exhaustive-deps, dòng 142).
- Chưa chạy trình duyệt (AGENTS.md cấm `pnpm dev`); chưa kiểm thử với MongoDB thật.

## 18. Web — Phiếu thu/chi v2 (form · hồ sơ · duyệt · danh sách) — v2/v2.md §5.2, §6.1–6.2, §7.2, §11.4–11.6, US-AUTO-01..05

Chỉ UI và hook phía web; không đổi API hay contract. Đã đối chiếu với `routes/documents.ts` (`detailOf`), `domain/vouchers/refs.ts` (`buildVoucherRefView`), `routes/automation.ts` + `domain/automation/queries.ts` (RunView có `generated[]`, `steps[].output`), `routes/partners.ts` (tab đối tác).

### 18.1 File

- `apps/web/src/app/v2/documents.ts` (mới) — kiểu trên WIRE (`DocLoanView`, `DocLink`, `DocTransferView`, `AutomationRunView`, …), hook (`useAutomationRuns`, `useRerunAutomationRun`, `useSetDocumentTags`, `useCreateDocumentLink`, `useRemoveDocumentLink`) và hàm thuần dùng chung (`loanOptionsBody`, `loanTermsBody`, `transferTargetBody`, `manualLinkRelationsFor`, `debtDirectionForVoucher`, `defaultLoanDueDate`, `allocatedMinorOf`, `hasAutoLoanRun`, `generatedObjectText`).
- `apps/web/src/app/v2/documents.test.ts` (mới, 14 test): `cd apps/web && npx vitest run src/app/v2/documents.test.ts`.
- `apps/web/src/components/voucher-v2.tsx` (mới) — `LoanBanner` (tuỳ chọn vay), `PartnerCard` (đối tác sống + "Sửa đối tác"), `TagsCard` (sửa tag sau duyệt), `AutomationPanel` (quy trình tự động, chạy lại), `LinksTab` (+ `AddLinkModal`, `RemoveLinkModal`).
- `apps/web/src/screens/create-form.tsx` (viết lại) — form thu/chi/đảo hạn/chuyển nội bộ v2.
- `apps/web/src/screens/document-detail.tsx` — badge "Tự động", khối quy trình tự động dưới header, tab "Liên kết (n)", đối tác + tag ở tab Tóm tắt, đích chuyển nội bộ lấy từ `transfer_target`.
- `apps/web/src/screens/approve-modal.tsx` — `LoanBanner` trên modal duyệt; khoá ô số tiền khi phiếu đã có lượt R3.
- `apps/web/src/screens/documents.tsx` — bộ lọc đối tác + tag (URL `partner_id`, `tag_ids`), cột "Đối tác" và "Tag"; "Xóa lọc" ghi URL một lần.
- Sửa nhỏ (shared-small-edit): `apps/web/src/app/types.ts` (`import type` từ `v2/documents.ts`; `QueueRow` + `partner_id`, `partner_name`, `tags`; `DocumentDetail` + `partner`, `tag_ids`, `tags`, `options`, `transfer_target`, `origin`, `links`, `automation_runs`; `can.tag`, `can.link`), `apps/web/src/app/queries.ts` (`DocListFilters` + `partner_id`, `tag_ids`).

### 18.2 Form phiếu (`create-form`)

- Ô đối tác là `PartnerPicker` (chọn theo ID). Thu: mọi loại; thu đi vay: chỉ Ngân hàng (bật "đi vay" thì bỏ đối tác không phải ngân hàng). Chi: mọi loại. Đảo hạn: Ngân hàng, tuỳ chọn. Phiếu chuyển nội bộ: không có ô đối tác. Không còn ô nhập tự do và không còn chuỗi "Tên - NH - STK".
- Prefill một lần: `?partner_id=`, `?loan=borrow` (thu), `?kind=` (chỉ áp dụng khi khớp form; lệch thì bỏ qua prefill).
- Thu đi vay (R2): mode `new` (điều khoản: số HĐ, lãi suất, kỳ hạn mặc định 12, hạn mặc định ngày gốc + 11 tháng sửa được, kỳ trả, phương thức, TSĐB; gốc = số tiền phiếu) · `existing` (chọn khoản của cùng ngân hàng đang `pending_disbursement` hoặc `active`, lấy từ `/partners/:id/loans`) · `later`.
- Chi vay để chi (R3): ngân hàng cho vay (PartnerPicker, chỉ Ngân hàng) · TK nhận giải ngân (TK ngân hàng của công ty; TK nguồn luôn đồng bộ với ô này — đổi ô nào cũng đổi cả hai; ô "Nguồn tiền" bị khóa khi đang vay) · số tiền vay (bỏ trống = bằng phiếu chi) · điều khoản như R2.
- Chuyển nội bộ: phiếu chi "Nhận: tài khoản nội bộ" (tuỳ chọn) và phiếu chuyển nội bộ (bắt buộc): công ty nhận + TK nhận theo ID.
- Tag: `TagInput` (có "+ Tạo tag" nếu có `tag:create`).
- Body gửi lên: `partner_id`, `tag_ids`, `options: { loan }` (null nếu không vay), `transfer_target` (null nếu không chuyển). Không gửi `payee`, không gửi `create_bank_debt` (cờ v1).
- Lỗi server hiển thị theo field từ `problem.errors`: `partner_id`, `options.loan.*` (kể cả `options.loan.terms.*`), `transfer_target.*`, `tag_ids`.

### 18.3 Hồ sơ chi tiết (`document-detail` + `components/voucher-v2`)

- Header: badge "Tự động · R…" khi `origin.kind === 'automation'`.
- Panel "Quy trình tự động" (dưới header, ẩn khi không có lượt): dòng `R3 ✔ — đã tạo NHD-…(chờ giải ngân), PT-…(đã thanh toán)`; lượt lỗi hiện các bước lỗi và nút "Chạy lại" (KTT hoặc `automation:config`). Lượt đang chờ/chạy được làm tươi mỗi 3 giây.
- Tab Tóm tắt: `LoanBanner` (nếu có tuỳ chọn vay), thẻ đối tác (dữ liệu sống theo `partner_id`; "Sửa đối tác" cần `partner:write`, tải bản đầy đủ có ghi chú trước khi mở popup để không xoá ghi chú), thẻ tag (sửa khi `can.tag`, "Lưu tag" → PATCH `/documents/:id/tags` với `if_match`), rồi 7 câu hỏi kiểm soát.
- Tab "Liên kết (n)": bảng quan hệ / đối ứng (liên kết tới đúng trang), số tiền (kèm gốc-lãi-phí nếu có), trạng thái, lý do gỡ. "Gỡ" cần `can.link` (lý do ≥ 5 ký tự). "+ Gán liên kết" cần `can.link`: quan hệ theo loại đối tác (KH/NCC: cấn trừ; NH: trả nợ khi chi, giải ngân khi thu), ứng viên lấy từ `/partners/:id/debts` (cùng hướng phiếu, chưa tất toán) hoặc `/partners/:id/loans`; trả nợ có thể tách gốc / lãi / phí.

### 18.4 Duyệt (`approve-modal`)

- Phiếu chi vay để chi: hiện "Chi bằng vốn vay <ngân hàng> <số tiền>, kỳ hạn <n> tháng" + TK nhận và hạn (US-AUTO-04).
- Khoá số tiền: nếu hồ sơ có lượt `R3` trong `automation_runs`, ô "Số tiền duyệt" bị ẩn và hiện thông báo "Số tiền đã khoá". Server vẫn trả FG-WF-005 nếu gửi số tiền khác.

### 18.5 Danh sách (`documents`)

- Bộ lọc (chỉ danh sách phiếu): đối tác (chọn từ `/partners`, tìm theo tên; phạm vi "Toàn tập đoàn" hiện thêm tên công ty) và tag (`TagFilter`, khoá ở "Toàn tập đoàn"). Tìm kiếm `q` của server đã khớp tên đối tác, STK, MST và tên tag.
- Cột "Đối tác" (`partner_name`, dự phòng `payee_name`) và cột "Tag" (tối đa 2 chip + "+N"). Dòng "Nội dung" chỉ còn tên công ty.

### 18.6 Hợp đồng đã dùng

- GET `/automation/runs/by-source?source_type=document&source_id=` → `{data: RunView[]}` (cũ → mới; ẩn lượt mà mọi bước "bỏ qua").
- POST `/automation/runs/:id/rerun` → `{data}`. PATCH `/documents/:id/tags` (`tag_ids`, `if_match`). POST `/documents/:id/links` (`relation`, `to_id`, `amount_minor`, `split`, `note`). DELETE `/documents/:id/links/:linkId` (`{reason}`).
- Ứng viên liên kết: `/partners/:id/debts` (cần `partner:read` + `debt:read`), `/partners/:id/loans` (cần `partner:read` + `loan:read`|`bank:read`).

### 18.7 Chưa làm / lưu ý

- **Chuyển nội bộ qua form chưa dùng được với phạm vi một công ty**: `scopeFor` chỉ cho một công ty mỗi lúc, còn server (§7.5) bắt công ty nhận nằm trong phạm vi. Vì vậy danh sách công ty nhận rỗng (có chú thích). Cần quyết định sản phẩm: nới quy tắc cho chuyển nội bộ, hoặc cho phạm vi đa công ty.
- Hạn mặc định của khoản vay tính từ ngày dự kiến (`planned_date`). Ngày giải ngân thật của R3 là ngày duyệt cuối; người dùng sửa được.
- Khoá số tiền R3 suy từ sự có mặt của lượt R3, server không trả cờ riêng.
- Form chưa kiểm tra trùng đối tác trước khi lưu (API không có chế độ kiểm tra); cảnh báo trùng chỉ hiện sau khi lưu (như PartnerPicker).
- Liên kết `funded_by` / `generated` / `internal_transfer` chỉ do bộ máy tạo, không gán tay từ panel.
- Chưa chạy trên trình duyệt (AGENTS.md cấm `pnpm dev`). Đã kiểm: `pnpm -F @fingate/web typecheck` đạt; ESLint sạch trên các file đã đổi; vitest `src/app/v2/documents.test.ts` 14/14.

## 20. Dọn đường v1 & build xanh (agent INTEGRATOR — gộp, không đổi nghiệp vụ v2)

### 20.1 Đã làm

- **Gửi duyệt** (`domain/workflow/index.ts` `requiredFieldsMissing`): thu/chi bắt buộc `partner_id`; phiếu nội bộ bắt buộc `transfer_target` (không còn `payee.name` / `target`). Trước đây mọi phiếu v2 đều không gửi duyệt được.
- **Kiểm số dư khi chi** (FG-WF-010): dùng sổ cái (`bookedBalance`), không trừ `blocked_minor` nữa (v2 BỎ "phong toả / khả dụng"). Key trong `data`: `available_minor` → `balance_minor`.
- **Danh bạ v1**: bỏ quét đối tác lúc khởi động (`syncCounterparties` trong `server.ts`) và bỏ đăng ký alias `/counterparties` (`routes/index.ts`). Không còn đường nào tự tạo đối tác từ text.
- **`document_links` / `repayment_links` (v1 nhúng)**: mọi nơi đọc đã chuyển sang `business_links`:
  - `reports/refs.ts`: `loadDebtSettlements` / `loadLoanSettlements` chỉ đọc v2; bỏ `mergeSettlements` (`aggregate.ts`) và `SettlementRow.source` = `'v2'`.
  - Báo cáo, cảnh báo, dashboard, bản tin: truyền `{ id }` (không còn `v1:`).
  - `partner/settle.ts` (sức chứa), `partner/summary.ts`, `links/index.ts` (`emitLoanSettledAfterPayment`).
  - `queries/index.ts`: đáo hạn, dư nợ theo ngân hàng, quá hạn, công nợ phải trả (helper `settledMapOf`).
  - Chi tiết công nợ / khoản vay: bỏ alias `document_links` / `repayment_links` trong response (web không đọc).
- **`auto_source_document_id` / `payee.is_internal`**: bỏ khỏi `loadInternalDocIds`. Chuyển nội bộ nhận diện bằng `kind = internal`, phiếu R1 (`origin.rule_code = R1`) và liên kết `internal_transfer`.
- **`create_bank_debt`**: không còn ghi ở POST/PATCH/chi tiết phiếu, contract (`documentFields`, `documentDetail`), `DomainDoc`, phiếu tự động (`automation/actions/voucher.ts`, `partner/voucher-draft.ts`). Thay bằng `options.loan`.
- **`auto_created`**: bỏ ghi ở `recurring/index.ts` và `automation/actions/voucher.ts`. Thay bằng `origin`.
- **Cảnh báo lỗi tự động**: `automation/engine.ts` gọi `raiseAlert({ alert_type: 'automation_run_failed' })` (2 chỗ) thay vì ghi `automation_failed`. Cảnh báo cũ vẫn được dedupe qua `LEGACY_AUTOMATION_ALERTS`.
- **Xuất Excel** (`POST /exports`, `routes/admin.ts`): chuyển `partner_id` / `tag_ids` (ID hợp lệ) vào báo cáo.
- **Số dư**: `queries/index.ts` dùng `closing` của sổ cái; bỏ `blocked` / `available` ở danh sách tài khoản, chi tiết phiếu và tổng tiền ("Bị hạn chế" bị bỏ). Chi tiết phiếu dùng `bookedBalance`.
- **Tìm kiếm phiếu**: bỏ điều kiện text `payee.name`. Tên đối tác và tag đi qua ID đã khớp.
- **Contract shared**: `debtVoucherUpsertBody` (bắt buộc `partner_id` + `direction`, bỏ `party_*`), `bankDebtUpsertBody` (bắt buộc `partner_id`, bỏ `bank_name`). Bỏ 2 export schema tương ứng trong `routes/schemas.ts` (không có route nào dùng).
- **Web**: bỏ hook và type `/counterparties`; màn chi tiết phiếu đọc `balance` (nhãn "Số dư hiện có"); bỏ `create_bank_debt`, `available` và alias v1 trong `types.ts` / `v2/debts.ts`; bỏ phụ thuộc thừa ở `shell.tsx`.
- **Test** cập nhật theo hành vi mới: `automation/engine.test.ts` (mock `raiseAlert`), `queries/queue-filter.test.ts` (mệnh đề tìm kiếm mới), `reports/aggregate.test.ts` (bỏ `mergeSettlements`), `debt/debt.test.ts` (bỏ test liên kết nhúng v1).

### 20.2 Còn lại (có chủ ý)

- **Cờ `create_bank_debt` còn một chỗ đọc** trong `domain/ledger/planned.ts` (nhận diện vay cho dòng dự báo). Lý do: migration 0004 chưa ánh xạ cờ này sang `options.loan` cho phiếu v1 đang chạy. Bỏ sau khi migration 0005 làm việc đó.
- **Trường v1 còn trong schema** (để migration 0005 xoá sau khi đối soát M6): `payee.*` (bản sao hiển thị do server ghi từ đối tác), `create_bank_debt`, `auto_source_document_id`, `auto_created`, `document_links`, `repayment_links`, `party_name` / `bank_name` (bản sao hiển thị), collection `counterparties`.
- **Mã mồ côi đã xoá** (vòng hoàn thiện, §24): `routes/counterparty.ts`, `domain/counterparty/`, `packages/shared/src/contracts/counterparty.ts` và dòng export trong `contracts/index.ts`. Model `Counterparty` và index `counterparties` đã gỡ khỏi `db/models.ts` / `db/indexes.ts`; collection vẫn còn để migration đọc.
- ~~**Cảnh báo lint còn lại**~~ — ĐÃ SỬA ở vòng hoàn thiện (§24): `apps/web/src/components/pagekit.tsx` `useColdStart` đăng ký lắng nghe thay cho effect phụ thuộc biến ngoài; `pnpm -r lint` không còn cảnh báo.
- **Triển khai**: chạy `pnpm db:migrate` (migration 0004) **trước** khi khởi động API mới. Code mới không còn đọc `document_links` / `repayment_links`; dữ liệu v1 phải đã nằm trong `business_links`.

### 20.3 Kiểm chứng

- `pnpm -F @fingate/shared build`, `pnpm -r typecheck`, `pnpm -r lint` (0 lỗi, 1 cảnh báo có sẵn ở `pagekit.tsx`), `pnpm -r test` (shared 94, web 22, api 435) đều xanh.
- `node --test db/migrations/0004-v2-data.test.mjs` vẫn xanh (migration không đổi).

## 21. Đối tác — sửa lỗ hổng rà soát (agent PARTNERS — v2/v2.md §3.2, §5, §9.2, §11.2, §14.2, US-PAR-01..09)

Các mục trên (§12, §14) vẫn đúng ngoài các điểm dưới đây; mục 12.8 (2) ở trên ĐÃ LỖI THỜI: các hàm ghi danh bạ v1 đã gỡ (xem 21.1).

### 21.1 Đã sửa

- **Quyền KTV** (`shared/permissions`): `staff` có `loan:read`, `loan:write` (§3.2, US-PAR-05 "Ghi nợ" trên ngân hàng).
- **Liên kết của phiếu huỷ / từ chối / hết hạn không còn giữ sức chứa** (§9.2, §11.2): `domain/links` có `RELEASED_DOCUMENT_STATUSES` và `reservingLinks(links)` (lọc theo trạng thái phiếu nguồn ngay lúc kiểm). `assertCapacity`, `settle.committedFor` và tổng hợp đối tác dùng hàm này. Chỉ tiêu "đã cấn trừ / đã trả" vẫn chỉ tính phiếu `paid`.
- **"Còn có thể trả"**: `DebtOut.available` (= giá trị − đã giữ chỗ) và `LoanOut.available_principal` (0 nếu khoản không đang vay / quá hạn). Hộp thoại Trả nợ và hai tab (Công nợ, Nợ NH) hiển thị và giới hạn theo số này.
- **Chống ghi đúp** (docs §12.6): collection `request_claims` (model `RequestClaim`, `_id` = khoá duy nhất, TTL 7 ngày), helper `domain/partner/claims.ts` (`acquireClaim` / `completeClaim` / `releaseClaim`; `pending` quá 120 giây ⇒ giành lại). Áp dụng cho `POST /partners` (`request_id` trong `partnerCreateBody`), `POST /partners/copy` và `POST /partners/:id/settle`. Lặp lại sau khi xong ⇒ 200 + kết quả lần đầu; lỗi ⇒ nhả khoá để gửi lại cùng `request_id`. Web: popup tạo, hộp thoại sao chép và hộp thoại Trả nợ sinh `request_id` MỘT lần khi mở.
- **Trả nợ — hoàn tác có kiểm tra** (`settle.ts`): gỡ từng liên kết (thử lại 1 lần, đã gỡ thì coi như xong); chỉ xoá phiếu nháp khi mọi liên kết của nó đã gỡ; phần không hoàn tác được ⇒ cảnh báo `partner_settle_rollback_failed` (mức 3) cho KTT, không nuốt lỗi. Replay trả trạng thái phiếu HIỆN TẠI (không còn cứng `draft`). Phiếu nháp không ghi `payee.*` (`voucher-draft.ts`).
- **Quyền trả nợ** (`routes/partners.ts`): có khoản KH/NCC ⇒ cần `debt:write`; có khoản vay NH ⇒ cần `loan:read` + `loan:write`. Nút "Trả nợ" trên web dùng cùng điều kiện (`canSettleOf`).
- **Số liệu theo quyền** (danh sách và chi tiết): `summaryVisibilityOf(perms)` — thiếu `debt:read` ⇒ null cột phải thu / phải trả / quá hạn; thiếu `loan:read` hoặc `bank:read` ⇒ null dư nợ / đáo hạn; thiếu `doc:read` ⇒ null tổng thu / chi.
- **Xoá đối tác**: kiểm lại sau khi xoá; nếu có phát sinh vừa ghi (đua) thì khôi phục đúng bản ghi cũ (`insertOne`, cùng `_id`, lịch sử) và báo `FG-PARTNER-002`.
- **Trùng số TK** (`duplicates.ts`): `accountSearchPattern` — mẫu regex bỏ phân cách (khoảng trắng . - _ /) và không phân biệt hoa thường, thay cho danh sách biến thể `$in`. Không cần cột khoá chuẩn hoá hay backfill. Ô tìm đối tác và danh bạ (`partnerFilter`) cho STK / MST dùng `identifierSearchPattern` (cùng quy tắc, khớp đoạn bất kỳ): gõ `123456789012` vẫn tìm thấy STK `123-456 789 012`.
- **Kiểm trùng trước khi lưu**: `POST /partners/check-duplicates` (`partner:write`, chỉ đọc, `exclude_id` khi sửa) + cảnh báo inline trong popup (debounce 500 ms). Cảnh báo sau khi lưu vẫn giữ.
- **Sao chép**: danh sách công ty nguồn lấy từ `me.companies` (công ty được gán; toàn tập đoàn ⇒ mọi công ty đang hoạt động), loại công ty đang chọn. Danh sách nguồn có tìm kiếm (`q`) và phân trang 50/trang (API `limit` ≤ 200).
- **Đối tác ngừng giao dịch**: các thao tác Thu / Chi / Ghi nợ / Trả nợ bị vô hiệu hoá, lý do ghi trên nhãn (danh sách) hoặc nút (chi tiết, cùng banner sẵn có).
- **Ledger** (`summary.ts`): mọi truy vấn có `company_id $in` (công ty của đối tác), không chỉ lọc sau bằng `partnerByKey`.
- **Khoản chi định kỳ** (`routes/admin.ts`, `recurringUpsertBody`): `POST /admin/recurring` kiểm đối tác bằng `assertVoucherPartner` (cùng công ty, đang hoạt động) và LƯU `partner_id`; khi có đối tác không sao chép tên người nhận; `payee` chỉ bắt buộc khi không có `partner_id` (superRefine). `GET /admin/recurring` trả `partner_id`, `partner_name`. Khi xoá đối tác, `partnerUsageCounts` đã đếm khoản định kỳ.
- **Dọn v1**: các hàm ghi danh bạ v1 (`ensureCounterparty`, `ensureCounterpartyFromLabel`, `syncCounterparties`, `linkCounterpartyByName`, `isInternalLabel`) không còn caller. Trong cùng đợt dọn, `domain/counterparty` và `routes/counterparty.ts` (alias `/counterparties`) đã được gỡ khỏi cây làm việc; không còn import nào trong `apps/api/src` và `apps/web/src`. Model `Counterparty` (collection `counterparties`) còn trong `db/models.ts` và `db/indexes.ts`, chờ migrate M1.

### 21.2 Chưa làm / lưu ý

- **Bản sao tên trên khoản nợ / khoản vay** (`domain/debt/debts.ts` `party_name`, `loans.ts` `bank_name`): vẫn ghi vì model v1 còn bắt buộc các trường này và màn v1 còn đọc chúng. Cần migrate (M-series) rồi mới bỏ; cho tới đó tên đúng luôn lấy qua `partner_id`.
- **Màn Khoản chi định kỳ** (`screens/admin.tsx`, `app/v2/exec.ts`) chưa hiển thị cột đối tác: API đã trả `partner_name`.
- **Đua có chủ ý** (không transaction, ADR-03): xoá đối tác (kiểm lại sau xoá) và claim `pending` quá 120 giây có thể được giành lại. `copyPartners` lỗi giữa chừng ghi phần đã tạo vào claim (lặp lại không tạo đôi) và vẫn ném lỗi.
- Liên kết có `from` là phiếu đã xoá không giữ sức chứa (`reservingLinks` chỉ tính phiếu tồn tại và không huỷ / từ chối / hết hạn).
- Kiểm chứng: `pnpm -F @fingate/shared build` xanh; `pnpm -F @fingate/shared test` 95/95; `apps/api` partner tests 74/74 (thêm: mẫu số TK, quyền hiển thị, còn có thể trả). Typecheck API / web: lỗi còn lại nằm ở file của agent khác (`domain/debt/loans.ts`, `screens/create-form.tsx`, `screens/debt.tsx`); không có lỗi ở file đối tác.

## 21. Sửa khoảng cách spec — exec / migration (agent EXEC-FIX: v2/v2.md §4.2, §12, §13, §15)

Phạm vi: dashboard, dòng tiền & dự báo, cảnh báo, bản tin, báo cáo, tài khoản tiền, seed demo, cấu hình quản trị. Không đổi migration 0004 (M6 đã khớp: phải thu/trả trên dashboard loại nhân viên như M6).

### 21.1 Đã sửa

- **Dự báo khoản vay chia đều sau khi trả một phần** (§12, §10.3): `domain/loan-schedule/index.ts` thêm `buildRemainingSchedule` (gốc còn lại chia đều cho SỐ KỲ CÒN LẠI; kỳ đã trả = các kỳ mà gốc đã trả phủ hết theo lịch gốc; lãi tính trên dư nợ còn lại). `buildSchedule` giữ nguyên hành vi (v1, `routes/bank-debt.ts`). `domain/reports/cashflow.ts` dùng hàm mới. Test: `domain/reports/cashflow.test.ts`.
- **Một định nghĩa "thu–chi dự kiến"**: `PLANNED_FLOW_STATUSES` (`domain/ledger/planned.ts`) = `pending.*` + `approved` + `processing` + `paid`. Không tính nháp, trả về, từ chối, huỷ, hết hạn. Áp dụng ở KPI dashboard (`queries`), báo cáo (mọi preset có lọc trạng thái), ngân sách (`queries`, cảnh báo), bản tin. Test: `domain/reports/planned-status.test.ts`.
- **Bản tin** (`domain/newsletter/index.ts`): "chờ GĐ duyệt" = phiếu `pending.pgd` + `pending.gd` trong phạm vi công ty, không cần người xem (bỏ tham số `actorUserId`). Trường đổi tên `lines.awaiting_me` → `awaiting_gd`, `awaiting_gd_count`. Bỏ `print_url` (chưa có trang in). Thu/chi dự kiến đếm mọi phiếu trong ngày (không còn giới hạn 500 dòng). Tiền gồm tài khoản đã đóng còn số dư.
- **Phải thu quá hạn một con số theo HƯỚNG** công nợ: `partners.receivable_overdue_count` (`domain/reports/dashboard.ts`) → mục "khoản phải thu quá hạn" của "Cần xử lý ngay" và `counts.overdue_receivable` (`routes/dashboard.ts` ghi đè bản cache). Quick link "Công nợ quá hạn" → `/cong-no?direction=receivable&overdue_only=true`. Cảnh báo `receivable_overdue` cũng loại nhân viên (TK 334).
- **Nhân viên (TK 334)** không vào phải thu / phải trả theo đối tác, báo cáo công nợ theo đối tác, cảnh báo phải thu quá hạn (`party_type ≠ employee`).
- **Tài khoản đã đóng**: dashboard và bản tin tính số dư sổ cái của tài khoản đã đóng (`includeClosed`), khớp số dư đầu kỳ dự báo; cảnh báo dưới ngưỡng bỏ tài khoản đã đóng.
- **Cache phần bổ sung dashboard** 20 giây theo `dash-extras:<phạm vi>:<ngày>` (cùng TTL với phần cơ sở); `invalidateFor` cũng xoá khoá này sau mutation.
- **Danh sách cảnh báo** `GET /alerts` lọc theo `to_roles` của người xem; bản ghi không có `to_roles` hiện cho ai có quyền xem (như v1).
- **R6** (`domain/automation/rules/r6-cancel-generated.ts`) phát `source_cancelled_with_money` severity 3 qua `raiseAlert` (có fan-out và nhãn). Bản ghi R6 cũ `automation_money_moved` có nhãn trong `GET /alerts`.
- **Báo cáo** (`domain/reports/index.ts`):
  - Thẻ KPI "theo tag" cộng từng phiếu một lần (phiếu nhiều tag không bị cộng đôi); ghi chú nêu rõ.
  - Tổng công nợ, tổng theo đối tác, nhóm chi theo bộ phận/loại tính trên TOÀN BỘ nhóm trước khi cắt `limit` (chỉ cắt dòng hiển thị).
  - Biểu đồ "so sánh theo công ty" lấy số minor (tỷ đồng), không parse chuỗi nén.
  - "Hiệu suất phòng kế toán": SLA đếm trong phạm vi công ty bằng aggregate (không còn `find` cắt 2000 hồ sơ, không lấy công ty ngoài phạm vi).
  - "Dòng tiền": phần ĐÃ THỰC THI lấy từ sổ cái (`CashEntry`, theo ngày ghi sổ); phần CHƯA THỰC THI lấy từ phiếu theo ngày dự kiến (`PIPELINE_STATUSES`, không gồm `paid`). Không đếm trùng với số dư đầu kỳ.
  - Công nợ phải thu/trả: loại nhân viên; tổng không bị cắt theo `limit`.
- **Xuất Excel** (`apps/web/src/screens/reports.tsx`): gửi `partner_id` và `tag_ids` trong payload, bỏ khoá khi đang lọc; nhãn "Excel" (không có PDF; server chỉ nhận xlsx/csv).
- **Xuất báo cáo quá lớn** (`routes/admin.ts`): vượt `EXPORT_ROW_LIMIT` trả 422 (`FG-VAL-001`) và hướng dẫn thu hẹp kỳ; không còn xếp hàng job không có ai xử lý.
- **Tài khoản tiền** (`routes/finance.ts`): lịch sử giao dịch lấy tên đối tác theo `partner_id` (tên v1 chỉ là dự phòng cho phiếu chưa có đối tác).
- **Đóng / khoá tài khoản**: tham chiếu gồm `target.account_id` và `transfer_target.account_id`; 409 kèm mã phiếu (`data.codes`). Quyết định: vẫn CHẶN (không chuyển thành bước xác nhận, vì UI chưa có bước đó).
- **Tài khoản Tổng công ty** (`packages/shared/src/permissions/index.ts`): bỏ `admin:group_accounts` khỏi `deputy_chairman` và `admin`; chỉ `chairman` có mặc định (§4.2, §3.2). Test: `packages/shared/test/v2-group-accounts.test.ts`.
- **Tìm công nợ** (`domain/debt/debts.ts`): không khớp theo tên tự do v1 (`party_name`), chỉ qua `partner_id`, mã khoản và số hợp đồng.
- **Danh sách quy tắc và lượt chạy** (`routes/automation.ts`): `GET /automation/rules` và `GET /automation/runs` yêu cầu `automation:config` hoặc `audit:read` (khớp màn Quản trị). `GET /automation/runs/by-source` giữ `doc:read` cho panel trên phiếu.
- **Mật khẩu quản trị bootstrap** (`apps/api/src/env.ts`): dev/test mặc định `123qweasdzxc`; production bắt buộc `BOOTSTRAP_ADMIN_PASSWORD` khi bootstrap tạo tài khoản đầu tiên (throw khi thiếu, tại `db/bootstrap.ts`; không chặn khởi động khi DB đã có người dùng). Đồng bộ `.env.example`, `README.md`, `docs/runbook.md`, `db/bootstrap.js`.
- **Seed demo** (`apps/api/src/db/seed.ts`): 2 khoản vay `pending_disbursement` (một khoản có phiếu thu giải ngân hẹn ngày và liên kết `disbursement`, một khoản chưa có ngày) và 1 lượt R2 `failed` để panel "Quy trình tự động lỗi" có dữ liệu.
- **Dọn code counterparty mồ côi**: đã xoá ở vòng hoàn thiện (§24): `routes/counterparty.ts`, `domain/counterparty/index.ts`, `packages/shared/src/contracts/counterparty.ts` và dòng export trong `contracts/index.ts`. Model `Counterparty` đã gỡ; collection `counterparties` giữ lại (migration 0004 đọc).
- **Dashboard** (`apps/web/src/screens/dashboard.tsx`): thẻ "Thu – chi 30 ngày" gọi báo cáo đúng cửa sổ hôm nay → hôm nay + 29; thêm thẻ "Dự báo 30 ngày" (thuần, cuối kỳ, thấp nhất, ngày dưới ngưỡng đầu tiên) lấy từ `/cashflow/forecast?horizon=30`.
- **Dashboard (base)**: bỏ nhóm `byBankAgg` theo tên ngân hàng v1 khỏi `buildOverview` (kết quả bị ghi đè); `bank.by_bank` lấy theo đối tác (`bank_by_partner`).

### 21.4 Đính chính cho các dòng cũ trong mục này (không sửa tại chỗ)

- Dòng 706 (mục 12.7): alias `/counterparties` đã gỡ đăng ký (mục 20.1) và file đã xoá (mục 21.1).
- Dòng 748 (mục 16.6): `mergeSettlements` đã bỏ (mục 20.1); phân bổ chỉ đọc `business_links`.
- Dòng 760 và 762 (mục 16.9): `blocked/available` đã bỏ khỏi `buildOverview` (mục 20.1); `POST /exports` đã chuyển `partner_id` / `tag_ids` (mục 20.1) và web nay gửi kèm.
- Dòng 890 (mục 19.6): nút Xuất Excel không còn bị khoá khi lọc đối tác / tag.

### 21.5 Còn lại / lưu ý

- Chưa chạy trên MongoDB thật: aggregate SLA (`$type`, `$unwind`), dòng tiền theo `CashEntry.date`, seed demo (khoản vay chờ giải ngân và lượt R2 lỗi).
- Bản tin đọc toàn bộ phiếu chờ duyệt bằng `find` (không aggregate); cần đổi nếu số phiếu lớn.
- Dự báo lịch trả nợ vay vẫn là xấp xỉ: kỳ đã trả suy từ gốc đã trả, không biết kỳ trả ngoài luồng (mục 16.9.6).
- Đóng / khoá tài khoản vẫn chặn 409 (không có bước xác nhận trên UI).
- Xuất báo cáo lớn không có tác vụ nền: người dùng phải thu hẹp kỳ.
- Test khi bàn giao (ngoài phạm vi này, đang đỏ): `automation/engine.keys.test.ts` (điều kiện R2), `automation/engine.test.ts` (khoá cảnh báo `automation_run_failed`), `debt/v2.test.ts` (zod `unlinkBody`).

---

## 22. Vòng đời phiếu & tag — sửa theo review (agent vouchers-tags · v2/v2.md §6.1–6.2, §7.2, §8, §11.6, US-VOU-01..06)

Sửa các gap đã xác minh trong khu vực phiếu thu/chi và tag. Phần chưa làm và lý do nằm ở 22.5.

### 22.1 Server

- **Duyệt vượt cấp (§7.2)** — `domain/workflow/index.ts` `transition()`: bước của mình còn `waiting` (và có cấp `current` phía dưới) ⇒ chỉ `approve_with_reason` được; `approve` thường trả FG-WF-002. Duyệt vượt cấp đặt `steps[].fast_tracked` và `override.fast_tracked` (chỉ khi là duyệt vượt cấp). `domain/workflow/state-machine.ts` `applyDecision(steps, order, decision, { fastTrack })`: chỉ bỏ qua (`skipped`) cấp dưới khi duyệt vượt cấp tới cấp cao nhất; không đẩy cấp chờ thành `current` khi đã có cấp `current`. `domain/entitlement/index.ts`: `can.approve` chỉ khi bước của mình là `current`; `can.fast_track` khi bước của mình đang `waiting`.
- **Khuyết chức danh & đẩy cấp (§7.2)** — `domain/workflow/index.ts` `assignUsers` + `dropVacantSteps`: cấp không có người bị bỏ khỏi chuỗi, KHÔNG thêm cấp ngoài ma trận (CTA khuyết PGĐ, khoản < 50 triệu ⇒ KTT là cấp cuối). Chỉ khi cả chuỗi không còn ai có người phụ trách thì bước CAO NHẤT được đẩy lên cấp cao hơn còn người (`state-machine.ts` `escalatedTopRole`). Chủ tịch KHÔNG được đẩy lên chỉ vì cấp dưới khuyết: chỉ vào chuỗi khi vượt ngưỡng (`withChairman`, `matrix.ts`), hoặc khi cả chuỗi không còn ai có người phụ trách (tránh duyệt xong ngay khi gửi). Chuỗi mặc định phiếu chi theo khoảng tiền khi chưa có dòng ma trận khớp (`defaultSpendSteps`, `matrix.ts`): < 50 triệu KTT → PGĐ; 50 triệu – 5 tỷ KTT → PGĐ → GĐ; > 5 tỷ thêm P.TGĐ. Test: `assign-users.test.ts`, `state-machine.test.ts`, `matrix.test.ts`.
- **Quyền hành động không phải quyết định** — `queue_payment` cần `payment:mark` (FG-RBAC-001), như `pay`.
- **Thực thi phiếu chi (§6.3, §8)** — số thực chi không vượt số đã duyệt (FG-VAL-001); thấp hơn thì bắt buộc lý do ≥ 5 ký tự (FG-WF-004), ghi vào lịch sử (`domain/vouchers/lifecycle.ts` `actualAmountProblem`). Route `POST /documents/:id/transition` với `pay` trên phiếu chi: `execution.bank_ref` và chứng từ UNC (loại `bank_order`) là tuỳ chọn, không chặn thực thi. Lượt tự động (`executeAutoVoucher`) không đi qua route nên không bị ảnh hưởng.
- **Xoá phiếu đã thực thi (§8)** — `domain/vouchers/reversal.ts` `reverseLedgerForDocument`: đảo từng bút toán gốc (`reverses` = id gốc, khoá `rev:<dedupe_key gốc>`, chạy lại không đảo trùng), dựng lại số dư. Làm TRƯỚC khi xoá hồ sơ (lỗi đảo thì phiếu còn nguyên). Route xoá không còn gọi `purgeLedgerForDocuments`. Trả về `reversed_entries`. `domain/rebuild/balances.ts` `purgeOrphanLedgerEntries` bỏ qua phiếu đã có bút toán đảo (giữ cả gốc lẫn đảo; job cleanup không xoá vết).
- **US-VOU-05** — `roundLocksEdit(status, approvedFromKttUp)`: phiếu `changes_requested` được sửa và xoá dù cấp KTT+ đã duyệt ở vòng trước (vòng mới bắt đầu khi gửi lại). Áp dụng cho PATCH, DELETE và `approved_from_ktt_up` trong chi tiết.
- **§6.2 tag** — `PATCH /documents/:id/tags` chỉ người lập hoặc người có `tag:manage` (`mayChangeVoucherTags`); `can.tag` trong chi tiết theo cùng quy tắc. Kiểm tag khi gắn phiếu: `resolveVoucherTagIds` (`domain/vouchers/refs.ts`), nguồn duy nhất.
- **Dữ liệu phiếu** — PATCH ghi số tiền theo số thập phân của tiền tệ (`voucherAmountField`, USD = 2). PATCH đổi `contract.value` sang dạng lưu (`minor` BigInt), không ghi thẳng dạng wire. POST lưu `contract.signed_at` và số thập phân đúng.
- **Bỏ** `GET /documents/payees` (không còn client gọi).

### 22.2 Web

- **Form phiếu (US-VOU-01)** — "Tạo & gửi duyệt" lỗi sau khi đã tạo nháp: lần bấm sau SỬA nháp đó (`draftRef`), không tạo DRAFT thứ hai. Chặn ngay ở client khi gửi duyệt thiếu tài khoản nguồn hoặc danh mục (khi đã cấu hình danh mục cho loại phiếu). Thêm các ô §6.1: danh mục (`/admin/categories`), dòng ngân sách (`/admin/budgets`, cần `budget:read`), "Khoản trong kế hoạch" (ngoài kế hoạch ⇒ người duyệt phải gõ lại số tiền), mã công nợ, giá trị và ngày ký hợp đồng, mức ưu tiên "Thấp". Hướng dẫn của luồng chuyển nội bộ (kind `internal`) đã sửa cho đúng hành vi thực tế.
- **Duyệt (§7.2)** — "Duyệt trước" hiện đúng (chỉ với bước đang chờ); nhãn "Đã duyệt trước bởi <vai trò>" ở hồ sơ và danh sách.
- **Thực thi (US-EXE-01)** — modal thực thi có ngày thực chi (mặc định hôm nay, không quá hôm nay), số tham chiếu ngân hàng (tuỳ chọn), không cảnh báo thiếu UNC và không khoá nút xác nhận.
- **Xoá phiếu** — modal liệt kê tác động: đảo sổ cái (phiếu đã thực thi), phiếu đối ứng và đối tượng tự động không tự xoá, liên kết sẽ gỡ.
- **Ô tag** — tạo tag xong không ghi đè các tag vừa chọn trong lúc chờ (`valueRef`).

### 22.3 File mới

- `apps/api/src/domain/vouchers/lifecycle.ts` (quy tắc thuần) và `lifecycle.test.ts`; `apps/api/src/domain/vouchers/reversal.ts`.
- `apps/api/src/domain/workflow/fast-track.test.ts` (chuỗi PGĐ rồi GĐ, quyền approve/fast_track).
- `apps/web/src/app/v2/vouchers.ts` (hook danh mục và dòng ngân sách).

### 22.4 Đã xoá (không còn nơi gọi)

- `domain/tags`: `resolveTagIds`, `tagRefsFor`, `groupTagsAcrossCompanies`, `groupTagsByNameKey` (và kiểu `TagRef`, `TagNameGroup`, `TagUsageRow`); test tương ứng trong `tags.test.ts`.

### 22.5 Chưa làm / cần quyết định

- ~~**R1 (§11.6)**: phiếu thu tự sinh vẫn ghi `payee`~~ — payee không còn được ghi (§23.1); phiếu thu R1 không có đối tác là ngoại lệ có chủ ý (§23.2); phiếu chuyển nội bộ (`kind = internal`) không bắt buộc đối tác (chỉ cần công ty và TK nhận). Còn mở: quyết định sản phẩm về đối tác của phiếu thu đối ứng (§24).
- **Kind `internal` (form NOI-BO)** vẫn là luồng riêng, không tự sinh phiếu thu bên nhận. Cần chọn một mô hình: phiếu chi + "Nhận: tài khoản nội bộ" (§11.6) hoặc mở rộng R1. Chưa đổi.
- **Ngoại tệ**: ô số tiền chỉ nhập VND; form chưa chọn tiền tệ / tỷ giá (`fx`). API đã nhận các trường này.
- ~~**Dashboard không lọc theo tag** (§6.2)~~ — ĐÃ LÀM: `?tag_ids=` lọc số liệu theo phiếu (dự kiến thu–chi hôm nay, chờ duyệt, thiếu chứng từ), thẻ "Theo tag" (`/reports/theo-tag`). Tiền, dự báo, công nợ, vay NH, đáo hạn luôn theo toàn công ty (không gắn tag). Xem §16.2.
- **Popup đối tác chưa kiểm trùng trước khi lưu** (§5.2): thuộc khu vực đối tác.
- ~~**Dọn code v1 còn lại**~~ — ĐÃ LÀM ở vòng hoàn thiện (§24): `usePayeeNames`, `usePayeeAccountOptions`, type `PayeeAccountOption`, `GET /bank-accounts/payee-options`; `ensureCounterpartyFromLabel`, `syncCounterparties`, `parsePayeeAccountLabel`, `resolvePayeeAccount`, `detectInternalTransferTarget` đã xoá cùng file.
- **Báo cáo theo tag**: tổng thu/chi đã tính từ phiếu (không từ các nhóm đã cắt), nên không cộng trùng. Không đổi ở đây.
- **Lưu ý cho báo cáo và dashboard**: bút toán đảo có chiều ngược. Mọi chỗ cộng thu/chi thực tế từ `cash_entries` phải loại cặp gốc + đảo (`reverses`) để không tính hai lần.
- **Chưa chạy trên MongoDB thật**: đảo bút toán khi xoá phiếu, truy vấn `distinct('document_id', { reverses })` của job cleanup.

### 22.6 Sửa tối thiểu ngoài khu vực được giao

- `domain/workflow/index.ts` (`transition`, import `actualAmountProblem`), `domain/workflow/state-machine.ts` (`applyDecision`), `domain/entitlement/index.ts` (`approve`), `domain/rebuild/balances.ts` (`purgeOrphanLedgerEntries`), mục Tag ở trên trong file này (sửa các dòng về hàm đã xoá).

## 23. Tự động hoá — sửa khoảng trống so với v2/v2.md §11.2–11.7, §14.3 (agent AUTO-FIX)

### 23.1 Đã làm

- **Kích hoạt khoản vay theo liên kết giải ngân (gap 1)**: R2 nghe mọi phiếu thu (`payload.kind = income`); bước `activate_loan` kích hoạt MỌI liên kết `disbursement` hiệu lực khi phiếu đã thực thi — không phụ thuộc cờ vay hay chế độ. Khoản do R2 sinh dùng `activateLoan` (gốc = số thực thu, hạn mặc định tính lại theo ngày giải ngân); khoản khác dùng `activateLoanOnDisbursement` (debt). Gán tay trên phiếu ĐÃ thực thi (`POST /documents/:id/links`) kích hoạt ngay; gán khi phiếu chưa thực thi được kích hoạt khi phiếu thực thi (`voucher.paid`).
- **Điều khoản mặc định theo công ty (gap 2)**: form phiếu không còn gửi 12 tháng / +11 tháng cứng; ô trống ⇒ server dùng tham số công ty và tính lại hạn theo ngày giải ngân (R2). Endpoint mới `GET /automation/loan-defaults?company_id=` (quyền `doc:create | doc:read`; `GET /automation/rules` nay chỉ cho `automation:config | audit:read`). R3: ngày gốc = ngày duyệt cuối = ngày giải ngân, nên không cần đổi.
- **Không tạo khoản trùng khi gỡ liên kết (gap 3)**: `origin.source_document_id` được ghi trên khoản vay tự sinh (`db/models.ts` `originEmbed`, và `origin` của phiếu sinh tự động). `findAutoLoanFor` tìm theo phiếu nguồn trước, rồi mới theo liên kết / lượt chạy (dữ liệu cũ). Liên kết `Tự động` không gỡ tay được (`DELETE /documents/:id/links/:linkId`, `unassignLoanLink`) trừ `funded_by` (§11.5). Xoá phiếu nguồn: khoản tự sinh CHƯA có tiền được huỷ trước khi gỡ liên kết (`releaseLoansOfSource`).
- **R2 phục hồi / bỏ cờ vay (gap 3, mở rộng)**: `mayReviveLoan` cho phép phục hồi khi phiếu còn trước duyệt (không phải từ chối). Bỏ cờ vay hoặc đổi "để sau"/"khoản có sẵn" ⇒ huỷ khoản tự sinh chưa có tiền và gỡ liên kết tự sinh.
- **R6 (gap 3, 7)**: tìm khoản vay theo phiếu nguồn (kể cả đã gỡ liên kết) qua `actions/source.ts` (dùng chung với xoá phiếu). Phiếu thu do phiếu nguồn sinh (`generated`, VD R3) đang `approved` ⇒ huỷ theo `transition` (`cancel`, quyền hệ thống `approval:override`); không huỷ được ⇒ bước lỗi, lượt `Lỗi`, KTT chạy lại (không tạo trùng vì `request_id` = khoá bước + phiếu).
- **Cấp duyệt hạ số tiền chi dưới số tiền vay riêng (gap 4)**: `transition()` từ chối (FG-VAL-001) khi số tiền chi sau duyệt < `options.loan.amount_minor` của phiếu chi vay để chi (`policy.loanExceedsSpend`). Không khoá lượt lỗi không có đường sửa.
- **Đối chiếu outbox (gap 5)**: `events.reconcileTransitionEvents()` chạy khi hàng sự kiện rảnh, tối đa 5 phút/lần (`engine.processPendingEvents`). Với mỗi phiếu đổi trong 3 ngày, nếu thao tác GẦN NHẤT trong `history` là thao tác chuyển trạng thái (đã chờ ≥ 2 phút) mà không có sự kiện nào sau thời điểm đó ⇒ cảnh báo KTT (`automation_run_failed`, khoá `outbox_gap:<phiếu>:<thời điểm>`). Chỉ CẢNH BÁO, không phát lại sự kiện. Index `documents.updated_at` (`db/indexes.ts`).
- **Cấu hình quy tắc (gap 6)**: `PATCH /automation/rules/:id` — công tắc tổng, tham số mặc định, `company_ids` chỉ người có phạm vi toàn tập đoàn (FG-RBAC-002). `company_overrides`: chỉ thay ghi đè TRONG phạm vi; ghi đè ngoài phạm vi được giữ nguyên (gửi lại đúng như đang lưu thì chấp nhận). Thêm `if_updated_at` (contract `automationRuleUpdateBody`): lệch ⇒ FG-WF-011 (409). Web gửi `if_updated_at`; công tắc tổng chỉ hiện ở "Tất cả công ty".
- **Phiếu tự động không còn ghi `payee.*` (gap 8)**: `createAutoVoucher` bỏ `payee`; R1/R3 không truyền. Phiếu thu R1 không có `partner_id` — **ngoại lệ có chủ ý** (đã ghi §11.6): nhận diện nội bộ theo `origin.rule_code = R1` (`domain/queries` `decisionPack`).
- **Dọn code v1 (gap 9)**: xoá `domain/counterparty/`, `routes/counterparty.ts`, `domain/workflow/auto-income.ts` và test. `AUTO_INCOME_PREFIX` chuyển vào `rules/r1-internal-transfer.ts`.
- **Cảnh báo lượt lỗi theo lần thử (gap 11)**: khoá `automation_run_failed:<run>:<attempts>` (`runFailureAlertKey`); mỗi lần thử lỗi được báo lại.
- **loan.settled từ phía phiếu (gap 12)**: `POST /documents/:id/links` gọi `emitLoanSettledAfterPayment` khi phiếu chi đã thực thi và liên kết là trả nợ.
- **Gap 10**: đã được chủ phần nợ ngân hàng gỡ sẵn trong checkout (không còn hook `syncLoansOnVoucherPaid` / `releaseLoansOfCancelledVoucher` / `createLoanForAutomation`); không đổi thêm.
- **Xoá phiếu giải ngân đã thực thi (gap 13)**: `domain/debt/loan-on-delete.ts`. Khoản `active` mà phiếu thu đã thực thi là giải ngân duy nhất (không còn phiếu giải ngân thực thi khác) ⇒ về `pending_disbursement` (`action: revert_disbursement`, audit `bank_debt.revert_disbursement`); nếu khoản đã có phiếu trả nợ thực thi ⇒ chặn xoá (FG-WF-001, xoá phiếu trả nợ trước). Kiểm TRƯỚC khi đảo sổ cái (`loansToRevertOnDelete`), revert SAU đảo và TRƯỚC `releaseLoansOfSource`, nên khoản tự sinh còn chờ giải ngân bị huỷ theo quyết định R6 chung. Chủ tịch/TGĐ cũng chịu chặn này. Trước đây khoản giữ `active` và liên kết giải ngân bị gỡ mềm, không còn chứng từ nào giải thích khoản vay. Kiểm thử: `domain/debt/loan-on-delete.test.ts` (7 ca, mock Models).
- **Tạo khoản vay thủ công ở trạng thái chờ giải ngân (gap 14)**: `POST /bank-debts` nhận `disbursed?: boolean` (mặc định `true` = đang vay như trước). `disbursed: false` ⇒ `pending_disbursement`, không có ngày giải ngân (bỏ qua `disbursed_date`, không kiểm hạn thanh toán so với ngày giải ngân). Quy tắc nằm ở `manualLoanDisbursement` (`domain/debt/rules.ts`). Form LOAN-03 có ô "Chờ giải ngân (chưa có tiền về)". Sửa khoản đã tạo: `PATCH /bank-debts/:id` nhận `disbursed` và `disbursed_date` (`loanDisbursementToggle`, `domain/debt/loans.ts` `updateLoan`). Đang vay → chờ giải ngân chỉ khi khoản chưa có liên kết nào (FG-WF-001). Chờ giải ngân → đang vay chỉ khi chưa gán phiếu thu giải ngân nào (tiền về theo phiếu thu); `disbursed_at` = `disbursed_date` (mặc định hôm nay), kiểm hạn thanh toán sau ngày đó. Form sửa hiện ô "Chờ giải ngân" và chỉ gửi khi tích/bỏ tích khác trạng thái đang lưu. Nhập theo lô (LOAN-05) vẫn tạo khoản đang vay. Kiểm thử: `domain/debt/loan-create-pending.test.ts`.

### 23.2 Quyết định / chính sách (đã ghi vào v2/v2.md)

- §11.5: cấp duyệt hạ số tiền chi dưới số tiền vay ⇒ từ chối, trả về để hạ số tiền vay hoặc giữ số tiền chi.
- §11.2: liên kết tự động không gỡ tay (trừ `funded_by`).
- §11.6: phiếu thu R1 không có đối tác ngoài (ngoại lệ có chủ ý).
- §14.3 (4): thực thi tự động (R1, R3) chạy dưới phiên hệ thống (`payment:mark`, miễn xác thực lại); kiểm soát nằm ở duyệt phiếu gốc (gap 13 — chính sách, không đổi code).
- Gap 14 (kind `internal` độc lập, không tạo phiếu thu bên nhận): **chưa đổi** — cần quyết định nghiệp vụ (giữ kind hay chỉ dùng phiếu chi + `transfer_target`).

### 23.3 Còn lại / lưu ý

- Đối chiếu outbox chỉ xét thao tác GẦN NHẤT của mỗi phiếu và chỉ cảnh báo; outbox vẫn best-effort (ADR-03).
- Xoá phiếu CHI nguồn không huỷ phiếu thu tự sinh còn `approved` (xoá không phát sự kiện huỷ) — còn mở.
- Gỡ `funded_by` tay với khoản vay CHƯA giải ngân để lại khoản "chờ giải ngân" không liên kết (dự báo còn tính) — hiếm, vì R3 thực thi ngay trong cùng lượt.
- Chưa có kiểm thử tích hợp MongoDB cho: kích hoạt theo liên kết, khoá theo phiếu nguồn, đối chiếu outbox, PATCH có `if_updated_at`.
- Kiểm thử: `pnpm -F @fingate/api typecheck` và `pnpm -F @fingate/web typecheck` xanh; `pnpm -F @fingate/api test`: 469 pass, 1 lỗi ở `domain/debt/v2.test.ts` (`unlinkBody` yêu cầu lý do, test kỳ vọng `{}` hợp lệ — ngoài khu vực này); `pnpm -F @fingate/web test` xanh.

---

## 21. Công nợ & nợ ngân hàng — sửa khoảng trống (agent DEBT-FIX, v2/v2.md §2.3, §3.2, §7.3, §9, §10, §11.2, §11.4–11.5, US-DEBT-01…04, US-LOAN-01…04)

**Đã làm** (file đều thuộc `apps/api/src`, `apps/web/src`, `packages/shared/src` trừ khi ghi khác):

- **Quyền (§3.2)** — `packages/shared/src/permissions/index.ts`: KTV (`staff`) thêm `loan:read`, `loan:write`, `debt:update`; `director`, `deputy_director`, `deputy_chairman`, `chairman` bỏ `loan:write`, `debt:update`, `debt:delete` (giữ xem). Thêm quyền `loan:delete` (chỉ KTT mặc định). Đã kiểm bằng `ROLE_PERMISSIONS` đã build.
- **Đảo hạn (§7.3, §10.3, US-LOAN-04)**:
  - `routes/documents.ts`: phương án đảo hạn (POST/PATCH) bắt buộc `loan_id`; `assertLoanForRollover` (`domain/debt/loans.ts`) kiểm cùng công ty, cùng ngân hàng (đối tác), khoản đang vay / quá hạn.
  - `POST /documents/:id/rollover-result`: bắt buộc `new_maturity_date` (cũng có trong plan); `assertRolloverResultForLoan` kiểm TRƯỚC khi đổi trạng thái phiếu; sau đó `applyRolloverResultToLoan` cập nhật hạn thanh toán, kỳ kế tiếp, hạn mức, lãi suất, số HĐ (`contract_no`), ghi lịch sử `rollover_result` trước → sau. Gốc không đổi; idempotency giữ theo `processed_requests`.
  - Contract: `rolloverResultBody.new_maturity_date`, `documentFields.rollover.new_maturity_date`; model `documents.rollover.new_maturity_date`, `rollover.result.new_maturity_date`.
  - UI: form phương án (`create-form.tsx`) chọn khoản vay của ngân hàng đã chọn (đang vay / quá hạn) và ngày đáo hạn mới; nhận `?loan_id=&partner_id=&kind=rollover`. RENEW-04 (`document-detail.tsx`) có ngày đáo hạn mới. Chi tiết khoản vay có nút "+ Lập phương án đảo hạn".
- **Chỉ tiêu giải ngân (§10.1–10.2)** — `rules.ts › disbursementFigures`: khoản tạo tay / nhập lô (đang vay, không có liên kết giải ngân) ⇒ đã giải ngân = gốc; "chưa giải ngân" chỉ tính cho khoản chờ giải ngân. Test: `fixes.test.ts`.
- **Xoá (§2.3)** — khoản vay: chỉ khoản chờ giải ngân CHƯA từng có liên kết (kể cả đã gỡ), quyền `loan:delete`; công nợ: chưa từng có liên kết. Liên kết đã gỡ được giữ làm lịch sử (không còn `deleteMany`).
- **Gỡ liên kết (§11.2)**: lý do bắt buộc (`unlinkBody`, không mặc định ở route). Không gỡ giải ngân / trả nợ khi phiếu đã thực thi (`unassignLoanLink`). Chi bằng vốn vay (`funded_by`) gỡ được: `DELETE /bank-debts/:id/funded-by/:linkId` + nút Gỡ trên chi tiết.
- **Huỷ khoản chờ giải ngân (§10.2)**: `cancelPendingLoan` chặn khi còn phiếu chưa huỷ / chưa từ chối liên kết tới khoản (nêu mã phiếu).
- **Trường mới (§10.1)**: `bank_debts.contract_no`, `collateral`, `responsible` (model `db/models.ts`, `domain/debt/bodies.ts`, tạo / sửa / nhập lô, form, chi tiết). Không còn ghi vào ghi chú (phần R2/R3 tự động: xem mục "Chưa làm").
- **Lịch trả nợ (§10.1)**: `GET /bank-debts/:id/schedule` bắt đầu từ `disbursed_at` (chưa giải ngân ⇒ ngày lập); hạn thanh toán phải sau ngày giải ngân (`assertMaturityAfterDisbursement`, tạo / sửa / nhập lô).
- **Hướng công nợ (§9.1, US-DEBT-04)**: form `debt.tsx` không mặc định "Phải thu"; bắt buộc chọn; `?side` (v1) chỉ dùng khi có tham số đó.
- **Lịch sử (§2.3)**: sửa công nợ / khoản vay / đảo hạn / kích hoạt ghi `history[].fields.changes = { field: {from, to} }`; màn chi tiết có `ChangeHistoryCard` (`components/change-history.tsx`). Helper: `historyRowsOf`, `HISTORY_FIELD_LABEL` (`app/v2/debts.ts`).
- **Chống gửi lặp (§11.2)**: `request_id` (≥ 8 ký tự) trên `POST /debts` và `POST /bank-debts` (lưu trong `history.request_id`): gửi lại ⇒ trả bản ghi đã tạo. Nhập lô bỏ qua dòng trùng (cùng ngân hàng, gốc, hạn, khoản chưa huỷ) và dòng trùng trong cùng lô, báo ở `failed`. UI giữ một mã cho mỗi form (`newRequestId`).
- **Danh sách công nợ (§9)**: phân trang server (`page` trên URL, 50 dòng); `GET /debts` trả `truncated` khi chạm trần 5000 dòng, UI cảnh báo. Tìm theo mã (CN-…) và số hợp đồng; không tìm theo bản sao `party_name`.
- **Đối tác trên khoản đã có liên kết (§5.1)**: `PartnerPicker` có prop `lockSelection` (chỉ khoá việc chọn); "Sửa đối tác" / "+ Tạo đối tác" chỉ cần `partner:write`.
- **Dư nợ theo ngân hàng (US-LOAN-02)**: bảng "Dư nợ theo ngân hàng" (số khoản, dư nợ, đáo hạn ≤ 7 / ≤ 30 ngày) trên Bảng đáo hạn — `bankTotalsOf` (`app/v2/debts.ts`).
- **Trùng helper (§14.3)**: `domain/debt/index.ts` chỉ re-export từ `rules.ts`. Đã xoá `syncLoansOnVoucherPaid`, `releaseLoansOfCancelledVoucher`, `createLoanForAutomation` (không có người gọi). Mục 12 phía trên ("điểm nối") không còn đúng cho các hàm này; luồng tự động hiện nằm ở `domain/automation/actions/loan.ts`.
- **Sức chứa (§9.2)**: dùng `reservingLinks` (`domain/links/index.ts`, do agent khác thêm) — liên kết tới phiếu đã huỷ / từ chối / hết hạn không chiếm sức chứa; công nợ và khoản vay đều dùng cùng hàm.
- **Kiểm thử**: `domain/debt/fixes.test.ts` (chỉ tiêu giải ngân, lịch sử, kiểm hạn, zod); `domain/debt/v2.test.ts` cập nhật (lý do gỡ bắt buộc); `apps/web/src/app/v2/debts.test.ts` (tổng theo ngân hàng, lịch sử, cảnh báo liên kết, request_id). `pnpm -r typecheck` và `pnpm -F @fingate/api test` xanh tại thời điểm bàn giao.

**Chưa làm / lưu ý**:
1. **Quy tắc tự động R2 / R3 / R6** (`domain/automation/actions/loan.ts`, `rules/r2-*`, `rules/r3-*`): HĐ / TSĐB đã ghi vào `contract_no` / `collateral` (ĐÃ XỬ LÝ, không còn vào `note`); liên kết R2 chọn khoản có sẵn ghi nguồn Thủ công (`ensureManualLink`). Còn lại: `activateLoan` vẫn đặt gốc = số thực thu của một phiếu (không xét đợt khác đang gán); vẫn có bản logic thứ hai ngoài `domain/debt`, cần chuyển sang `activateLoanOnDisbursement` (thuộc khu vực tự động hoá).
2. `bank_debts.bank_name`, `debt_vouchers.party_name` (và bản sao khi tạo) vẫn được ghi vì model còn `required`; bỏ sau khi M2 / M3 xong và model bỏ bắt buộc. `bank_name` v1 không còn là dự phòng khi đọc khoản vay.
3. Dashboard (`screens/dashboard.tsx`) vẫn hiện top 5 ngân hàng; bảng đầy đủ đã có ở Bảng đáo hạn.
4. Kết quả đảo hạn không có transaction (ADR-03): nếu `applyRolloverResultToLoan` lỗi sau khi phiếu đã ghi kết quả, cần cập nhật khoản bằng tay; kiểm trước giảm rủi ro.
5. Chưa chạy trình duyệt (AGENTS.md); chưa có test tích hợp MongoDB cho các đường ghi mới.

---

## 24. Trạng thái cuối — vòng hoàn thiện (final pass)

Mục này ghi trạng thái đã kiểm chứng sau vòng hoàn thiện. Các mục trước ghi trạng thái lúc bàn giao của từng agent (xem banner đầu tệp).

### 24.1 Lệnh kiểm chứng

| Lệnh | Kết quả |
| --- | --- |
| `pnpm -F @fingate/shared build` | exit 0 |
| `pnpm -r typecheck` | exit 0 (shared, api, web) |
| `pnpm -r lint` | exit 0, 0 problem (cảnh báo cũ ở `pagekit.tsx` đã sửa) |
| `pnpm -r test` | exit 0: shared 97/97 (6 file); api 411/411 (37 file) + `node --test` migration 0004: 8/8; web 26/26 (2 file) |
| `pnpm -F @fingate/api build` (sau khi xoá `apps/api/dist` cũ) | exit 0 |

Trước vòng này, `pnpm -F @fingate/api test` báo 486 test: 75 test nằm trong `apps/api/dist/**/*.test.js` (bản biên dịch cũ, gồm cả test của `auto-income` đã xoá) bị vitest chạy nhầm. Đã loại `dist/` khỏi bộ kiểm thử (`apps/api/vitest.config.ts`).

### 24.2 Thay đổi trong vòng này

API
- `routes/finance.ts`: gỡ `GET /bank-accounts/payee-options` (không còn client).
- `domain/partner/index.ts`: gỡ `partnerBasicList` (chỉ phục vụ alias `/counterparties` đã gỡ).
- `db/models.ts`, `db/indexes.ts`: gỡ model `Counterparty` và index `counterparties`. Collection vẫn còn; migration 0004 đọc bằng driver.
- `packages/shared/src/contracts/admin.ts` (`recurringUpsertBody`) và `routes/admin.ts` (`POST /admin/recurring`): bên nhận khoản chi định kỳ **bắt buộc là đối tác** (`partner_id`, đúng công ty, đang hoạt động). Không còn nhận hoặc ghi `payee` nhập tự do (v2 §5.2).
- `apps/api/vitest.config.ts` (mới): loại `dist/` khỏi vitest. `apps/api/package.json`: `test` chạy thêm `node --test ../../db/migrations/0004-v2-data.test.mjs`, nên `pnpm -r test` có cả kiểm thử migration.
- `routes/automation.ts`, `db/models.ts`: sửa chú thích cho khớp code.

Shared
- `packages/shared/test/v2-recurring.test.ts` (mới, 2 kiểm thử).

Web
- `app/queries.ts`, `app/types.ts`: gỡ `usePayeeNames` (gọi `/documents/payees` đã bỏ), `usePayeeAccountOptions` và type `PayeeAccountOption`.
- `app/v2/exec.ts`, `screens/admin.tsx`: form khoản định kỳ không gửi `payee`.
- `screens/admin.tsx` (`ADMIN_TABS`): thêm tab "Quản lý tag" (`tag:manage`).
- `routes.tsx`: `AdminHomeRedirect` thêm nhánh `automation:config` → Tự động hoá và `doc:create` → Chi định kỳ (trước đây người chỉ có các quyền này bị đưa về `/403`). `PATH_PERMS` của `/quantri/dinh-ky` = `doc:create`, khớp tab.
- `components/shell.tsx`: mục "Quản trị" trên rail hiện khi có **bất kỳ** quyền nào của các tab (thêm `admin:backup`, `tag:manage`, `automation:config`, `doc:create`). Trước đây người có `doc:create` không có đường vào Chi định kỳ.
- `components/pagekit.tsx`: `useColdStart` đăng ký lắng nghe thay cho effect phụ thuộc biến ngoài (sửa cảnh báo `react-hooks/exhaustive-deps`); hành vi "đang thức dậy" sau 3 giây giữ nguyên.

Gốc
- `package.json`: thêm `db:migrate:v2:dry-run` (`node db/migrations/0004-v2-data.js --dry-run`).

Dọn v1 đã thực hiện (đối chiếu §20.2, §22.5): không còn `usePayeeNames`, `usePayeeAccountOptions`, `payee-options`, `ensureCounterpartyFromLabel`, `syncCounterparties`, `parsePayeeAccountLabel`, `resolvePayeeAccount`, `detectInternalTransferTarget`, `domain/counterparty`, `routes/counterparty.ts`, `workflow/auto-income.ts`, `workflow/auto-bank-debt.ts`. Không còn đường ghi `document_links`, `repayment_links`, `create_bank_debt`, `auto_source_document_id`, `auto_created`.

### 24.3 Rà soát nhất quán

- **Route**: 11 nhóm trong `routes/index.ts` đăng ký dưới `/api/v1` (auth, documents, dashboard, finance, debt, bank-debt, partners, admin, backup, tags, automation); `systemRoutes` đăng ký trong `app.ts`. Kiểm tự động: mọi lời gọi `apiCall` / `apiData` / `downloadFile` / `openDownload` của web (121 lời gọi) khớp một khai báo route phía server. Đây là so khớp đường dẫn bằng script, không thay cho kiểm thử tích hợp.
- **Màn hình**: mọi `screens/*.tsx` đều được import; mọi màn có route trong `routes.tsx`; mục rail, tab Quản trị và `PATH_PERMS` dùng cùng bộ quyền:

| Mục | Đường dẫn | Quyền hiển thị (rail / tab / PATH_PERMS) | Gác ở server (đã đối chiếu) |
| --- | --- | --- | --- |
| Tổng quan | `/dashboard` | `doc:read` | — |
| Chờ tôi duyệt | `/cho-toi-duyet` | `approval:act` ∨ `payment:mark` | theo thao tác |
| Cần xử lý | `/can-xu-ly` | `doc:read` | — |
| Cảnh báo (v2) | `/canh-bao` | `doc:read` | `GET /alerts`: `doc:read` |
| Chi / Thu / Hồ sơ | `/chi`, `/thu`, `/ho-so/:loai/:id` | `doc:read` | — |
| Ngân hàng, chuyển nội bộ | `/ngan-hang/taikhoan`, `/ngan-hang/chuyen-noi-bo` | `bank:read` | — |
| Nợ ngân hàng (v2) | `/ngan-hang/khoan-vay`, `…/:id/lich-tra` | `loan:read` | — |
| Đáo hạn (nhãn "Đang phát triển") | `/ngan-hang/dao-han`, `…/chuan-bi` | `loan:read` | — |
| Công nợ | `/cong-no`, `/cong-no/phieu/:id` | `debt:read` | — |
| Đối tác (v2) | `/doi-tac`, `/doi-tac/:id` | `partner:read` | `GET /partners`: `partner:read`; ghi: `partner:write` |
| Dòng tiền | `/dong-tien` | `forecast:read` | — |
| Báo cáo / Bản tin | `/baocao`, `/ban-tin/ngay` | `report:view` | — |
| Quản trị (rail) | `/quantri` | hợp quyền của các tab (dưới) | — |
| Nhân sự · Công ty · Ma trận · Ngưỡng | `/quantri/nguoidung`, `…/cong-ty`, `…/quy-trinh-duyet`, `…/nguong-duyet` | `hr:invite` · `admin:settings` · `admin:matrix` · `admin:settings` | theo route admin |
| Chi định kỳ (v2) | `/quantri/dinh-ky` | `doc:create` | `GET /admin/recurring`: `doc:read`; `POST`: `doc:create` |
| Tự động hoá (v2) | `/quantri/tu-dong` | `automation:config` ∨ `audit:read` | `GET /automation/rules`, `…/runs`: `automation:config` ∨ `audit:read`; `PATCH` rule: `automation:config`; chạy lại: KTT ∨ `automation:config` |
| Quản lý tag (v2) | `/quantri/tags` + mục rail | `tag:manage` | `POST /tags`: `tag:create`; sửa (`PATCH /tags/:id`) và gộp (`POST /tags/merge`): `tag:manage`; danh sách không khoá (dùng để chọn tag) |
| Audit log | `/quantri/audit` | `audit:read` | theo route |
| Sao lưu | `/quantri/sao-luu` + nút rail | `admin:backup` | theo route |

- Đường vào `/quantri` (`AdminHomeRedirect`) theo thứ tự: `hr:invite` → Nhân sự; `admin:settings` → Công ty; `admin:matrix` → Ma trận; `audit:read` → Audit log; `tag:manage` → Tag; `admin:backup` → Sao lưu; `automation:config` → Tự động hoá; `doc:create` → Chi định kỳ; còn lại → `/403`. Thứ tự giữ nguyên để KTT vào Audit log như trước.

### 24.4 Giữ lại có chủ ý (đọc hoặc ghi v1 còn lại, bỏ ở migration 0005)

- `domain/ledger/planned.ts` đọc cờ `create_bank_debt` để nhận diện phiếu thu đi vay trong dự báo. Lý do: phiếu v1 đang dở chưa được chuyển sang `options.loan`. Điều kiện bỏ: xem 25.5.
- `payee.*` chỉ còn là **bản sao hiển thị** do server dẫn xuất từ đối tác (`domain/vouchers/refs.ts`), và là **fallback tên** khi phiếu hoặc khoản chưa có đối tác (`domain/queries`, `routes/finance.ts`, `routes/admin.ts`, `domain/recurring`). Không còn đường nào nhận `payee` làm đầu vào, trừ khoá tuỳ chọn `documentFields.payee` mà server bỏ qua. Điều kiện bỏ: M2 gán `partner_id` cho mọi bản ghi.
- Trường và index v1 trong schema: `payee.*`, `create_bank_debt`, `auto_source_document_id`, `auto_created`, `document_links`, `repayment_links`, `party_*`, `bank_name` / `branch`, `target` (ghi song song với `transfer_target`), `recurring_rules.payee`. Điều kiện bỏ: migration 0005, sau khi M6 xanh trên production.
- Collection `counterparties`: chỉ migration đọc; không có code runtime nào đọc.

### 24.5 Còn mở (cần quyết định, không làm trong vòng này)

1. **Docker entrypoint** (`deploy/docker-entrypoint.sh`) chạy migration rồi vẫn khởi động API khi migration lỗi (`|| echo …`). Trên Render, `preDeployCommand` vẫn chặn đúng. Với v2 nên dừng khi migration lỗi; chưa đổi vì thay đổi hành vi triển khai cần quyết định.
2. Chuyển nội bộ: đối tác của phiếu thu đối ứng, và phiếu chi chuyển nội bộ; gap 14 (`kind internal` độc lập) — §22.5, §23.2.
3. Popup đối tác chưa kiểm trùng trước khi lưu (§5.2); form phiếu chưa có tiền tệ / tỷ giá (§22.5).
4. Chưa có kiểm thử tích hợp MongoDB (§23.3); chưa chạy trình duyệt (không tự chạy `pnpm dev` theo AGENTS.md).
5. Chưa commit, chưa push trong vòng này. AGENTS.md yêu cầu commit và push sau khi xong việc; người điều phối cần thực hiện.

---

## 25. How to migrate — chuyển dữ liệu v1 → v2 (`pnpm db:migrate` · dry-run)

Áp dụng **một lần** khi triển khai v2 (migration `0004-v2-data`). Nguyên tắc: thêm trước, bỏ sau. Không có bước "down"; chạy lại an toàn (idempotent). Quy tắc M1–M6 xem mục 15.

### 25.1 Chuẩn bị

1. **Sao lưu CSDL** trước mọi bước khác: trong app, nút "Sao lưu & tải về" ở rail (cần `admin:backup`, gọi `POST /system/backups`), hoặc `mongodump` (container: `BACKUP_MONGO_CONTAINER`, xem `.env.example`). Đây là đường khôi phục duy nhất.
2. `.env` ở gốc repo có `MONGODB_URI` trỏ đúng CSDL cần migrate (`db/_common.js` nạp `.env` trước khi kết nối).
3. **Build trước**: runner đọc `apps/api/dist`, không đọc `src`:
   ```
   pnpm -F @fingate/shared build
   pnpm -F @fingate/api build
   ```
   Nếu nghi `dist` còn file cũ: `rm -rf apps/api/dist` rồi build lại.
4. **Kiểm thử logic, không cần DB**: `pnpm -F @fingate/api test` (có bước `node --test db/migrations/0004-v2-data.test.mjs`).
5. Không chạy `pnpm db:seed` trên CSDL thật (seed là dữ liệu demo).

### 25.2 Xem trước, không ghi DB: `pnpm db:migrate:v2:dry-run`

- Tương đương `node db/migrations/0004-v2-data.js --dry-run`. Tính M1–M6 trên trạng thái mô phỏng và đối chiếu M6. **Không ghi** CSDL.
- In JSON ra màn hình và lưu `data/migrations/0004-dry-run-<thời điểm>.json` (thư mục đã gitignore). Báo cáo chỉ có số đếm và id, không có tên đối tác hay số tiền cá nhân.
- Mã thoát: `0` = M6 KHỚP; `1` = M6 LỆCH (in tối đa 20 mục); `2` = gọi sai cờ (chạy `node db/migrations/0004-v2-data.js` không kèm `--dry-run` sẽ báo và thoát 2).
- Cần đọc trong báo cáo:
  - `partners.planned_new`, `partners.unassigned_new`: số đối tác sẽ tạo, kể cả "Chưa xác định" của từng công ty;
  - `links.planned.total`: số liên kết `business_links` sẽ tạo;
  - `review.total` và lý do (`inferred_type`, `link_partner_<loại>`, `unassigned_<lý do>`): danh sách rà soát;
  - `before` / `after` (`applied_total`, `repaid_total`, `outstanding_by_company`, `balances`): M6 đã đối chiếu; báo cáo phải không có mục LỆCH.
- Rà soát không chặn việc áp dụng, nhưng nên xử lý trên web trước giờ vận hành: gán lại đối tác "Chưa xác định", sửa loại đối tác, chọn đối tác cho phiếu.

### 25.3 Áp dụng: `pnpm db:migrate`

- Runner chạy các migration chưa ghi trong collection `settings` (key `migrations.applied`). 0004 áp dụng thật (M1–M6). M6 lệch ⇒ ném lỗi và **không** đánh dấu đã áp dụng; sửa nguyên nhân rồi chạy lại.
- Tóm tắt lưu trong `settings` với key `migration.0004.summary`.
- Trên Render: `preDeployCommand` = `pnpm db:migrate && pnpm db:indexes` (lỗi ⇒ dừng deploy). Trên Docker: xem 25.6.
- Chọn lúc ít giao dịch. Giao dịch v1 ghi đồng thời có thể làm M6 lệch; khi đó migration dừng an toàn và chạy lại được.
- **Thứ tự**: migrate **trước** khi API v2 nhận lưu lượng. Code v2 không còn đọc `document_links` / `repayment_links`.

### 25.4 Kiểm tra sau khi áp dụng

1. `pnpm check:tie -- --v2` (chỉ đọc): phủ đối tác, hướng công nợ, liên kết mồ côi / số tiền / tách / khác công ty. Lỗi cứng ⇒ thoát 1.
2. Chạy lại `pnpm db:migrate`: phải báo "đã áp dụng, không có gì chờ".
3. Soát mẫu trên giao diện: Công nợ, Nợ ngân hàng (chi tiết có liên kết), Dashboard (dư nợ, đáo hạn), Đối tác (tab Công nợ / Nợ NH).

### 25.5 Trước migration 0005 (bỏ trường v1)

- Kiểm phiếu v1 đang dở còn cờ vay:
  `db.documents.find({ create_bank_debt: true, status: { $nin: ['paid', 'rejected', 'cancelled'] } }, { code: 1, status: 1 })`
  Mỗi phiếu: chuyển sang `options.loan` (sửa trên web) hoặc chấp nhận không sinh khoản vay tự động. Sau đó bỏ đọc cờ ở `domain/ledger/planned.ts`.
- Sau khi M6 xanh trên production và rà soát xong: migration 0005 bỏ các trường và index v1 (mục 24.4), và bỏ collection `counterparties` sau khi đã sao lưu.
- Quay lại (không có "down"): khôi phục bản sao lưu ở 25.1.

### 25.6 Cảnh báo cho triển khai Docker

`deploy/docker-entrypoint.sh` chạy `node db/migrate.js || echo "… tiếp tục khởi động"`. Migration lỗi, kể cả M6 lệch, vẫn khởi động API; với v2, điều này để `business_links` thiếu dữ liệu. Trước khi triển khai v2 bằng Docker: chạy `pnpm db:migrate` thủ công và kiểm tra mã thoát, hoặc đổi entrypoint để dừng khi lỗi (chưa đổi trong vòng này).


## 26. Sửa lỗi theo kiểm thử E2E — nhóm fix4 (tags · phiếu · R2 · khoản vay)

Kiểm chứng: `e2e/fix4-verify.spec.ts` (spec riêng). Các thay đổi hành vi:

- **Sửa tag**: tab Audit của phiếu và ADM-12 nêu TÊN tag thêm / bỏ (lịch sử `tags_update` có `fields.added/removed` dạng `{id, name}`; audit `diff_fields` chỉ có tên, không có id). ADM-12 đọc được dạng `{from, to}` (đổi tên / màu / ẩn tag) thành trước → sau.
- **Nhãn thao tác lịch sử khoản vay / công nợ**: `LOAN_HISTORY_ACTION_LABEL` và `DEBT_HISTORY_ACTION_LABEL` (`components/labels.ts`) cho cột "Thao tác" của thẻ "Lịch sử thay đổi".
- **Đưa vào hàng thanh toán**: `can.queue_payment` (phiếu Đã duyệt + `payment:mark`; không áp dụng cho phương án đảo hạn) hiện nút "Đưa vào hàng thanh toán" trên hồ sơ. Từ Đang thanh toán vẫn "Thực thi".
- **FG-WF-007**: tiêu đề theo tình huống (`ApiError.title` / `ProblemInput.title`): tăng số tiền, ngoài ngân sách, hay vượt ngưỡng. `lib/http.ts` truyền `title` xuống problem.
- **Duyệt hạ số tiền xuống dưới số đã phân bổ**: khi cấp duyệt đổi số tiền, `assertDocumentAmountCoversLinks` chạy trước khi ghi ⇒ FG-LINK-002.
- **"Tạo khoản vay mới" khi phiếu còn giải ngân thủ công**: `assertDocumentFreeForNewLoan` chặn LƯU (FG-LINK-002), trừ liên kết do R2 tự sinh và liên kết tới khoản đã chọn trước đó (lần lưu này gỡ). Nếu bước nối giải ngân của R2 vẫn lỗi, khoản vay vừa tạo ở chính lượt đó được huỷ (không để khoản "Chờ giải ngân" mồ côi).
- **Gỡ tay liên kết theo lựa chọn "Gắn khoản vay đã có"**: bị chặn FG-WF-005 như liên kết tự động. Muốn gỡ thì đổi lựa chọn vay trên phiếu.
- **Ngày và lãi suất**: ô "Ngày thực hiện" / "Ngày đáo hạn mới" của kết quả đảo hạn là DatePicker DD/MM/YYYY (lưu YYYY-MM-DD). Lãi suất hiển thị theo dấu phẩy (`interestRateText`: `9,5`). Nhập theo lô và kết quả đảo hạn giữ dấu phẩy; `rolloverResultBody.new_rate` nhận cả `,` và `.`.
- Spec đã cập nhật theo quy tắc trên: `e2e/v2-auto-r2.spec.ts` R2-33 (gỡ tay liên kết theo lựa chọn bị chặn 422 FG-WF-005) và `e2e/v2-loans.spec.ts` US-LOAN-04 (ô ngày gõ DD/MM/YYYY). R2-34 tạm `skip`: kịch bản tạo lượt R2 lỗi bằng cách lưu "vay mới" khi còn giải ngân thủ công không còn tạo được (lưu bị chặn, xem R2-32).

## 27. Cấn trừ khoản vay trên phiếu thu / phiếu chi — R7 (gán tự động khi duyệt xong)

### 27.1 Yêu cầu & hành vi

- Khi lập / sửa phiếu chi, người dùng đánh dấu **"Phiếu này cấn trừ khoản vay"** và chọn khoản cần cấn trừ:
  - **khoản vay ngân hàng** (trả nợ): liên kết `repayment`, có thể tách lãi và phí;
  - **công nợ phải trả** của KH/NCC: liên kết `offset`.
- Khi phiếu được **duyệt xong** (sự kiện `voucher.approved`), quy tắc R7 tự gán phiếu vào khoản đã chọn. Liên kết có nguồn `Tự động` và mã `R7`, nên phân biệt được với liên kết người dùng gán tay trên tab Liên kết.
- **Phiếu chi**: cấn trừ khoản vay ngân hàng (trả nợ) hoặc công nợ phải trả. Không dùng cùng lúc với "Vay ngân hàng để chi" (R3): server chặn, form khoá checkbox.
- **Phiếu thu**: chỉ cấn trừ **công nợ phải thu** (KH / NCC đang nợ công ty; form gọi là "Cấn trừ khoản vay phải thu"). Không có khoản vay ngân hàng để trả, nên không tách lãi / phí. Không dùng cùng lúc với "Đây là khoản vay ngân hàng (đi vay)" (R2): gốc khoản vay bằng số tiền phiếu nên cấn trừ cùng lúc mâu thuẫn. Liên kết `offset` (phiếu thu ↔ phải thu) và cơ chế chỉ tiêu / gỡ liên kết giống phiếu chi.
- **Số tiền cấn trừ**: để trống = toàn bộ số tiền phiếu, đọc tại thời điểm duyệt (nên cấp duyệt hạ tiền thì cấn trừ theo). Nhập số riêng = cấn một phần, phần còn lại là chi tiền thường.
- **Chỉ tiêu**: liên kết được tạo khi duyệt nhưng chỉ trừ dư nợ / đã cấn trừ khi phiếu **đã thực thi** (`paid`), đúng cơ chế chung (`offsetEffectOf`: "Chờ thực thi — chưa trừ").

### 27.2 Dữ liệu

- `documents.options.offset` = `{ target: 'bank_debt' | 'debt_voucher', target_id, amount_minor, interest_minor, fee_minor }` (`db/models.ts`, `offsetOptionsEmbed`). `amount_minor` null = theo số tiền phiếu (lưu null khi nhập đúng bằng số tiền phiếu). `interest_minor` / `fee_minor` chỉ cho khoản vay ngân hàng; gốc = số tiền hiệu lực − lãi − phí.
- Contract (`packages/shared/src/contracts/documents.ts`): `offsetOptions` trong `options` của phiếu (ghi); `offsetOptionsView` trong `documentDetail` (đọc).
- Đọc phiếu: `buildVoucherRefView` trả `options.offset` = `{ target, target_id, target_code, amount_minor, effective_amount_minor, interest_minor, fee_minor }`.
- Liên kết do R7 tạo: `repayment` (phiếu → `bank_debt`, có `split` principal/interest/fee) hoặc `offset` (phiếu → `debt_voucher`), `origin = automation`, `rule_code = R7`, `run_id` = lượt chạy.

### 27.3 Kiểm khi lưu (không gán)

- **Thuần** (`domain/vouchers/rules.ts`, `planOffsetOptions`, có test): chỉ phiếu thu / phiếu chi; phiếu thu chỉ `debt_voucher`; không cùng vay (để chi / đi vay); phiếu phải có đối tác; số tiền cấn trừ > 0 và ≤ số tiền phiếu; lãi / phí chỉ cho khoản vay; lãi + phí ≤ số tiền cấn trừ. Lỗi `FG-VAL-001` gắn đúng ô: `options.offset.<field>`.
- **Bản ghi** (`domain/vouchers/refs.ts`, `resolveOffsetPlan`; chỉ chạy khi cấn trừ đổi so với lần lưu trước):
  - khoản thuộc công ty của phiếu và **đúng đối tác** của phiếu;
  - đối tác đúng loại: khoản vay ⇒ Ngân hàng; công nợ ⇒ KH/NCC;
  - khoản vay phải **đang vay** (cùng quy tắc `assignRepayment`: `loanStatusOf` ∈ `active` / `overdue`) và còn sức chứa trả nợ (`assertLoanRepaymentCapacity`, không tính trả nợ của chính phiếu);
  - công nợ đúng hướng với phiếu (`assertOffsetDirection(…, kind)`: phiếu chi ↔ phải trả, phiếu thu ↔ phải thu), không phải công nợ nhân viên (TK 334), còn sức chứa (`assertDebtOffsetCapacity`);
  - phiếu còn đủ tiền sau các liên kết gán tay khác của chính phiếu.
- Lưu trước khi duyệt **chỉ kiểm, không gán**: liên kết chỉ tạo khi duyệt, để không giữ sức chứa của khoản cho phiếu chưa được duyệt.

### 27.4 Khi duyệt (R7 — `domain/automation/rules/r7-offset-on-approval.ts`)

- Trigger `voucher.approved`, điều kiện `payload.kind ∈ {spend, income}`, `occurrenceEvents: ['voucher.approved']` (duyệt lại sau khi yêu cầu bổ sung ⇒ lượt mới). Một bước `link`.
- Gỡ liên kết R7 cũ không còn khớp lựa chọn (đổi khoản, bỏ cấn trừ) bằng `unlinkAutomationLink`. Cùng khoản thì `ensureAutomationLink` đồng bộ số tiền / lãi / phí (gỡ rồi tạo lại khi khác).
- Lỗi bước (lượt `Lỗi`, KTT sửa rồi chạy lại): khoản không còn đang vay; hết sức chứa (FG-LINK-002); lãi + phí vượt số tiền sau khi cấp duyệt hạ tiền. Phiếu đã duyệt vẫn giữ trạng thái duyệt; việc gán không làm hỏng luồng duyệt.
- Bật / tắt và phạm vi công ty của R7 theo cấu hình quy tắc (màn Quy trình tự động). Tắt ⇒ không tự gán.

### 27.5 Đổi cấn trừ sau khi lưu

- Phiếu chỉ sửa được ở nháp / bổ sung / từ chối (và phiếu bị yêu cầu bổ sung sau duyệt). Khi cấn trừ đổi (khoản, số tiền, lãi, phí) hoặc phiếu đổi đối tác, PATCH **gỡ** liên kết R7 đã gán trước đó (`releaseOffsetRuleLinks`, có lý do). Lúc phiếu chờ duyệt lại không còn liên kết giữ sức chứa cũ; duyệt lại sẽ gán theo lựa chọn mới. Liên kết gán tay không bị đụng.
- Phiếu đã huỷ / từ chối / hết hạn: liên kết R7 vẫn ở trạng thái hiệu lực trong DB nhưng không giữ sức chứa (`reservingLinks`) và không tính đã trả / đã cấn trừ, cùng cơ chế với liên kết khác.
- R6 không đụng liên kết này: R6 chỉ xử lý khoản vay sinh ra từ phiếu (`disbursement` / `funded_by`).

### 27.6 Giao diện

- **Form phiếu thu / chi** (`screens/create-form.tsx`, mục "Cấn trừ khoản vay"): checkbox; phiếu chi có thêm ô loại (khoản vay / công nợ phải trả), phiếu thu cố định công nợ phải thu; khoản (theo đối tác: khoản vay đang vay qua `usePartnerLoans`, công nợ còn dư qua `usePartnerDebts` lọc theo hướng phiếu); số tiền cấn trừ (trống = cả phiếu); lãi / phí (chỉ khoản vay); gốc tự tính. Bật "vay để chi" (hoặc "đi vay" trên phiếu thu) thì tắt cấn trừ. Đổi đối tác thì bỏ khoản đã chọn. Mọi lần lưu gửi `options.offset` (kể cả null) để sửa phiếu có thể bỏ cấn trừ đã lưu.
- **Hồ sơ phiếu** (tab Tóm tắt): `OffsetBanner` (`components/voucher-v2.tsx`): "sẽ tự gán khi duyệt xong" / "đã gán — xem tab Liên kết" / "không còn hiệu lực" (huỷ, từ chối, hết hạn).

### 27.7 Kiểm thử

- API: `domain/vouchers/offset-rules.test.ts` (kiểm thuần: `planOffsetOptions` kể cả phiếu thu / đi vay, `offsetLinkSpecOf`, lưu / đọc, `sameOffsetPlan`). Cập nhật danh sách quy tắc R1..R7 trong `engine.test.ts` / `engine.keys.test.ts`.
- Web: `app/v2/offset-options.test.ts` (form → body, nhãn ô chọn); `screens/create-form.test.ts` (đổi đối tác bỏ cấn trừ).
- **Chưa có** test tích hợp DB cho luồng lưu → duyệt → R7 và chưa có E2E cho kịch bản này. Cần kiểm trên app đang chạy.

### 27.8 Chưa làm / lưu ý

- Mỗi phiếu chỉ cấn trừ **một** khoản. Muốn cấn nhiều khoản: tách phiếu, hoặc gán tay thêm liên kết trong phần sức chứa còn lại.
- Sửa cấn trừ sau khi đã duyệt: phiếu phải được yêu cầu bổ sung (về bước sửa), sửa rồi duyệt lại.
- Lãi / phí chỉ cho khoản vay ngân hàng; công nợ không tách.

## 28. Chủ tịch đổi đối tác của phiếu thu / chi

Chủ tịch (`chairman`) đổi lại bên nộp tiền (phiếu thu) hoặc bên nhận tiền (phiếu chi) của một phiếu, ở **mọi trạng thái** kể cả đã thực thi. Vai trò được khai báo ở `PARTNER_REASSIGN_ROLES` (`domain/entitlement/index.ts`), cùng kiểu với `UNRESTRICTED_DELETE_ROLES`.

### 28.1 Backend

- `PATCH /documents/:id/partner` (`routes/documents.ts`), body `documentPartnerBody` (`partner_id`, `if_match`, `request_id`). Không cần step-up: đây không phải thao tác phá huỷ.
- Chặn: actor không phải Chủ tịch (FG-RBAC-001); kind khác thu / chi (FG-VAL-001); phiếu còn `options.loan` / `options.offset` (gỡ trước); đối tác không cùng công ty, ngừng giao dịch, hoặc loại không hợp lệ (qua `resolveVoucherPartner`); liên kết cấn trừ / trả nợ / giải ngân khớp đối tác cũ (FG-LINK-001, qua `assertPartnerChangeKeepsLinks`); phiếu chuyển nội bộ **đã thực thi** đổi sang / khỏi "Công ty trong tập đoàn".
- Phiếu chi: đích chuyển nội bộ tính lại theo đối tác mới (`resolveTransferTarget`, cùng cách PATCH thường).
- Không đụng số tiền và sổ cái: sổ không lưu đối tác, số liệu công nợ và đối tác tính sống theo `partner_id`.
- Ghi lịch sử `partner_update` (`fields.from` / `fields.to` = `{id, name}`), audit `document.partner_update`, idempotent theo `request_id`, CAS theo `version`.
- `can.partner_change` (`documentPermissions`): true khi actor thuộc `PARTNER_REASSIGN_ROLES`, phiếu thu / chi, trong phạm vi công ty.

### 28.2 Giao diện

- Tab Tóm tắt, thẻ "Đối tác" (`PartnerCard`, `components/voucher-v2.tsx`): nút **Đổi đối tác** đặt cạnh **Sửa đối tác**; mở `ChangePartnerModal` với `PartnerPicker` (phiếu thu: ngân hàng / khách hàng / NCC; phiếu chi: mọi loại).
- Lịch sử hồ sơ hiển thị "Đối tác: cũ → mới" (`historyDetailText`, `screens/document-detail.tsx`); nhãn `partner_update` / `document.partner_update` trong `components/labels.ts`.
- Hook `useChangeDocumentPartner` (`app/v2/documents.ts`) làm tươi công nợ, khoản vay, đối tác và phiếu.

### 28.3 Kiểm thử

- `domain/entitlement/document-v2-permissions.test.ts`: cờ `partner_change` theo vai trò, loại phiếu, phạm vi công ty.
- **Chưa có** test tích hợp DB hoặc E2E cho luồng đổi đối tác trên phiếu đã thực thi. Cần kiểm trên app đang chạy.

### 28.4 Lưu ý

- Phiếu đang có khoản vay / cấn trừ không đổi được đối tác qua API này: phải gỡ trước. Hiện chưa có nút gỡ trên phiếu đã thực thi, nên các phiếu này phải xử lý riêng nếu cần.
- Liên kết do quy trình tự động tạo không được kiểm tra khi đổi đối tác (giống luồng sửa phiếu thường).

## Quyết định thiết kế bổ sung (chờ duyệt đưa vào v2/v2.md)

Các điểm agent phát hiện khi triển khai, spec chưa nêu:

- **Đưa về bổ sung từ Đang thanh toán (§7.1 DangThanhToan → YeuCauBoSung):** người có `approval:act`, trong hạn mức duyệt, đủ chứng từ (hoặc có `approval:override`) được đưa phiếu đang thanh toán về bổ sung — không cần đang giữ bước (phiếu đã qua hết chuỗi duyệt). `can.request_changes` và nhánh `recall` của `transition()` dùng cùng luật. Chuỗi duyệt cũ giữ làm lịch sử; KTV sửa và gửi lại thì dựng chuỗi mới theo ma trận. Duyệt / từ chối / yêu cầu bổ sung chỉ có ở bước `pending.*` (đúng máy trạng thái).
- **TK nhận của chuyển nội bộ (§11.6):** gửi duyệt, duyệt, đưa vào hàng và thực thi đều kiểm TK nhận theo ID (có, đang hoạt động, thuộc công ty nhận) — cùng luật như khi lưu. Nháp lưu trước khi có kiểm tra này bị chặn 422 FG-VAL-001 "Chọn tài khoản nhận của công ty đích" ở bước gửi; phiếu đã gửi thiếu TK bị chặn ở duyệt / đưa vào hàng / thực thi, để tiền không ra khỏi công ty nguồn khi R1 không có nơi ghi phiếu thu.

- Liên kết do quy trình tự động tạo (nguồn `Tự động`) **không gỡ tay**: muốn đổi thì đổi lựa chọn trên phiếu (VD "vay mới" → "để sau") để quy trình cập nhật liên kết và khoản vay chưa giải ngân. Ngoại lệ: liên kết `funded_by` (vay để chi) gỡ được khi cần giữ khoản vay cho mục đích khác (§11.5). Khoản vay do quy trình tự sinh được tìm lại theo phiếu nguồn ghi trên khoản vay — gỡ liên kết không sinh khoản trùng.
- | Cấp duyệt hạ số tiền chi xuống **dưới** số tiền vay riêng (vay một phần) | Từ chối duyệt (FG-VAL-001): số tiền chi sau duyệt không được nhỏ hơn số tiền vay. Người duyệt **trả về** để KTV hạ số tiền vay, hoặc giữ số tiền chi. |
- - Phiếu thu do R1 sinh ra **không có đối tác ngoài** (`partner_id` = null) — ngoại lệ có chủ ý: không có danh bạ đối tác liên công ty. Được nhận diện là nội bộ theo nguồn gốc (`origin` của quy tắc R1) và liên kết `internal_transfer`, không theo tên đối tác.
- 4. **Đi qua nghiệp vụ chuẩn**: bước tự động gọi đúng các hàm nghiệp vụ người dùng gọi (kiểm tra quyền hệ thống, ghi lịch sử, sổ cái), không ghi DB tắt. *Chính sách:* thực thi tự động (R1, R3, và phiếu thu tự thực thi khi duyệt) chạy dưới phiên hệ thống, được cấp `payment:mark` và miễn xác thực lại; kiểm soát nằm ở việc duyệt phiếu gốc, không kiểm tra quyền thanh toán của người duyệt cuối.
