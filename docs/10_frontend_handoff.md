# FinGate — Brief cho session FRONTEND

**Dành cho:** session pi riêng chạy `apps/web` (React 19 + Vite 8 + antd 6).
**Đọc trước khi code:** `02_design_system.md` (token/component/pattern) + `03_screens.md` (danh mục màn + DoD §23) + `04_architecture.md` §5 · §12.5 · §19.5.
**Backend đã xong và đang chạy** — chi tiết + bằng chứng kiểm chứng ở `09_implementation_log.md`.

---

## 0. Bối cảnh ngắn

Backend (Fastify 1 service) đã: serve `/api/v1/*`, serve luôn SPA từ `apps/web/dist`, có OpenAPI tại `/api/v1/openapi.json`, DB đã seed dữ liệu demo thật nghiệp vụ.
Việc còn lại: **dựng web** theo đúng design system, bắt đầu từ P0 (không bắt đầu bằng 102 màn hình).

## 1. Chạy để làm việc

```bash
pnpm install
pnpm infra:up                      # Mongo local (rs0)
node apps/api/dist/server.js       # hoặc: pnpm dev (api + web + shared watch)
# nếu sửa backend: pnpm -F @fingate/api build
```

Cổng dev: web `5173` (vite), api `8080`. **Vite cần proxy `/api` → `http://localhost:8080`** (kiến trúc K-1 là same-origin khi production; khi dev dùng proxy để cookie + không CORS).

### Tài khoản demo (mật khẩu chung: `fingate-demo-2026`)

| Email | Vai trò | Phạm vi |
| --- | --- | --- |
| `chairman@fingate.local` | Chủ tịch HĐQT | toàn tập đoàn (scope_all) |
| `admin@fingate.local` | Quản trị | toàn tập đoàn |
| `director.ap@fingate.local` | Giám đốc | công ty An Phú (AP) |
| `ktt.mp@fingate.local` | Kế toán trưởng | Minh Phúc (MP) |
| `cv.mp@fingate.local` | Chuyên viên kế toán | MP |
| `kt.mp@fingate.local` | Nhân viên kế toán | MP |
| `director.hh@fingate.local` | Giám đốc | Happy Home (HH) |

Dữ liệu: 3 công ty (MP/AP/HH), 7 tài khoản NH (có 1 tài khoản **Tập đoàn**), 15 quy trình duyệt, 74 hồ sơ phủ hầu hết trạng thái (`PC-2026-00011` 420 tr đang chờ chuyên viên…), 4 khoản vay (1 khoản **đáo hạn hôm nay** 20 tỷ BIDV), công nợ có khoản quá hạn.

> Ghi chú đã biết: `dashboard/overview` trả **Tiền hiện có = 0 ₫** vì seed chưa nhập số dư đầu ngày. Gọi `POST /api/v1/bank-accounts/balances` (màn BANK-04) hoặc bổ sung vào `apps/api/src/db/seed.ts`. **Không phải bug UI.**

## 2. Luật cứng (đỏ — không được "tối giản")

1. **Mọi số tiền qua `@fingate/shared`** (`money()`, `formatMoney()`, `parseMoneyInput()`, `moneyToWire`). Tiền trên wire là **string minor units** → parse bằng `money(v)`, **cấm** `Number()`, `parseFloat`, `toFixed`, `toLocaleString`.
2. **Mọi trạng thái qua `status/registry`**: `STATUS_REGISTRY`, `statusLabel()`, `statusTone()`, `statusChipLabel()`, `maturity()/maturityLabel()`. Không tự đặt status mới, không dịch key.
3. **Chỉ dùng semantic token** từ `@fingate/shared/tokens.css` (`--fg-bg-surface`, `--fg-text-muted`, `--fg-status-danger-text`…). **Cấm hex literal trong `apps/**`** (lint `fg/no-raw-color`).
4. `pending.*` luôn hiển thị **đang ở bàn của ai** + **đã chờ N ngày**; `overdue` là chip **thêm vào**, không thay status.
5. Quyền: server trả `entitlements` + `document.can` (kèm `reason` khi bị chặn) → UI **ẩn** nút/cột theo đó. Ẩn chỉ là mỹ thuật, server đã chặn thật.
6. Deep-link phải hoạt động: `/ho-so/{chi|thu|dao-han|noi-bo}/:id`, URL là state của danh sách (`?status=pending.gd&q=ABC&sort=-waiting`).
7. Mỗi màn phải đủ **8 trạng thái**: default · loading(skeleton đúng hình) · empty(khác no-results) · error · partial · 403 · stale · (và 409 khi hồ sơ bị người khác duyệt).
8. Không có số liệu "Lorem"; dùng dữ liệu demo thật (`2,50 tỷ` · `VCB •••• 4521` · `đảo hạn` · `Công ty A → B`).
9. Keyboard-only cho toàn luồng duyệt (`Tab/Enter/Ctrl+Enter/Alt+D/Alt+X`), touch target ≥44 trên mobile.
10. Không PWA/web push kỳ 1. Mobile = cùng data contract, khác layout (§5.4: không phải desktop thu nhỏ).

## 3. Data contract đã kiểm chứng

| Endpoint | Trả về (rút gọn) |
| --- | --- |
| `POST /api/v1/auth/login` `{email,password}` | `200 {data:{need_2fa:boolean,user_id}}` · cần 2FA → `{data:{need_2fa:true,challenge,method:'totp',resend_after_s}}` |
| `GET /me` | `{data:{user_id,display_name,role…,assignments[],scope{company_ids,all,active_company_id},entitlements{permissions,actions,columns[],amount_limit_minor},prefs}}` |
| `GET /dashboard/overview?scope=` | `{data:{kpi{cash_total,income_today,spend_today,awaiting_me}·{label,amount{minor,currency},compact,breakdown[]}, bank{debt_total,maturity_today,maturity_7d,maturity_30d,by_bank[]}, exceptions[{severity,tone,glyph,text,amount,compact,href,cta}], awaiting_me_rows[{code,compact,company_name,created_by_name,status,waiting_days,next_role_label,overdue,href}], counts, partial_companies[], business_date, generated_at}}` |
| `GET /queue?limit=` | `{items[QueueRow], total, summary{count,amount,compact}}` — QueueRow: `code,kind_label,company_name,title,status,status_label,overdue,waiting_days,current_owner,owner_name,fast_tracked_by,payee_name,amount{minor},compact,planned_date,version,missing_evidence_count,href` |
| `GET /documents?kind=&status=&mine=&q=&sort=&limit=` | `{items[],total}` (projection, không có `purpose/history/attachments`) |
| `GET /documents/:id` | hồ sơ đầy đủ + `can{read,edit,submit,approve,reject,request_changes,fast_track,pay,override,attach,export,over_limit,step_order,reason}` + `approval.steps[]` + `evidence{required,present,missing}` + `history[]` |
| `GET /documents/:id/decision-pack` | `{data:{q1_payee,q2_amount,q3_purpose,q4_basis,q5_source,q6_impact{available_now,balance_after,min_balance,breach},q7_plan{in_plan,used,limit,percent},evidence,matrix_label}}` → **tab Tóm tắt / OVL-02, FE zero logic tiền** |
| `POST /documents/:id/transition` | body `{action,opinion?,reason?,verify{method,value},confirm_amount_minor?,if_match,request_id,execution?}` → `200 {data,transition}` · `409 FG-WF-011` (ai vừa sửa) · `422 FG-WF-003` (thiếu chứng từ) · `403 FG-RBAC-012` (vượt hạn mức, có số tiền trong detail) · `401 FG-AUTH-008` (cần step-up) · `422 FG-WF-007` (cần gõ lại số tiền) |
| `GET /reports/:preset` | `{data:{columns[{key,label,type,align}],rows,totals,kpi[],chart{type,x_key,series[],threshold},row_count,truncated,title,scope_label,as_of,generated_by}}` — 13 preset: `thu-chi-ngay thu-chi-thang so-du-ngan-hang cong-no-phai-thu cong-no-phai-tra vay-ngan-hang dao-han dong-tien chi-bo-phan chi-loai theo-cong-ty cho-duyet hs-ketoan` |
| `GET /rollovers?bucket=today|3d|7d|30d` | `{items[maturityRow], kpi{today,d3,d7,d30}, prepared_percent}` |
| `GET /cashflow/forecast?horizon=30` | `{data:{rows[{date,weekday,opening,inflow,outflow,net,closing,min_balance,breach}],totals,first_breach_date,shortfall_by_company[]}}` |
| `GET /newsletter/daily` | `{data:{date,lines{…12 chỉ tiêu},warnings[{tone,text,href}],sections[],print_url}}` |
| `GET /bank-accounts`, `/debts?kind=`, `/loans`, `/alerts`, `/notifications(+unread-count)`, `/search?q=`, `/admin/matrix`, `/personnel`, `/audit-log` | đều đã chạy, cùng phong cách `{items|data,…}` |

Error envelope: `application/problem+json` → `{type,title,status,code,detail,errors{field:msg},data,trace_id}`. Mã `FG-*` map hành động ở `shared/errors.ts` (`parseProblem`, `problemHint`: `refetch|retry|auth|scope|contact_admin|none`).

Sinh type tự động (khi backend đổi): `pnpm api:types` → `packages/shared/src/api-types/index.ts` (cần server đang chạy).

## 4. Thứ tự làm (khớp §17 kiến trúc / §22 screens)

**P0 — nền, chứng minh token đủ dùng**
1. `apps/web/src/app/theme.ts`: `ThemeConfig` antd 6 map 1-1 token (DS §12.3, dùng `cssVar`, `darkAlgorithm`), `ConfigProvider` đọc `data-fg-theme`. Import `@fingate/shared/tokens.css`.
2. `AppContext` (~60 dòng): scope · density · theme, persist `localStorage`.
3. Component `Fg*` nền: `FgButton FgText FgField FgInput FgTable FgMoney FgStatusChip FgAppShell` (+ `FgSpinner/FgSkeleton/FgEmptyState/FgAlert`). Screen **chỉ import `Fg*`**, không raw antd.
4. `routes.tsx`: mỗi route mang `screen` + `perms`; script CI đối chiếu screenId (làm sau được).
5. `DASH-01` skeleton 5 tầng với dữ liệu thật từ `/dashboard/overview`.
6. `ERR-01/02/04` + cold-start UX: request đầu > 3s → skeleton + "Máy chủ đang thức dậy, vui lòng chờ…", `retry:2` backoff 2s **chỉ cho GET**.

**P1** `AUTH-01/03/04` · `apiClient` (401→AUTH-06 giữ draft, 403→ERR-02, 409→thông điệp "ai vừa duyệt lúc nào" + refetch) · `FgFilterBar/FgDrawer/FgModal/FgPagination/FgTabs/FgToast` · `APPR-01` (bulk bar có **tổng tiền**) · `CHI-01/CHI-04` · `THU-01` · `BANK-01` · `FgApprovalTimeline` + `FgApprovalActionBar` (nút duyệt **chứa số tiền**, 7 câu hỏi confirm, stripe "Bạn đang duyệt trước").

**P2** `DOC-01` (5 tab + decision-pack) · `CHI-02/03/05/06/07` · upload prepare→PUT thẳng→confirm · `BANK-04` (bảng nhập số dư, lỗi inline per dòng) · `LOAN-01/02` · `RENEW-01/02/03` · `ADM-01/04/12`.

Query chuẩn: react-query, `refetchInterval: 30_000`, `refetchOnWindowFocus: true`, `placeholderData: keepPreviousData`. Không WebSocket.

## 5. Nghiệm thu từng màn (DoD §23, bắt buộc tự check)

- [ ] Action chính nằm trong viewport đầu ở 1440×900.
- [ ] Đủ 8 trạng thái; skeleton đúng hình nội dung thật.
- [ ] Mọi status qua registry, mọi số qua formatter (lint `no-raw-color`/`no-raw-number-format` pass).
- [ ] Light + dark; grayscale test vẫn phân biệt được rủi ro.
- [ ] Keyboard-only cho luồng duyệt; SR label cho status + số tiền.
- [ ] Deep-link từ notification mở đúng hồ sơ, **giữ bộ lọc nguồn**.
- [ ] Responsive 6 breakpoint; mobile <768 chỉ còn: Tiền → Cần duyệt → Cảnh báo → Đáo hạn → Dòng tiền.
- [ ] Cột/nút/export ẩn khi không có quyền **kèm giải thích vì sao ẩn**.
- [ ] Không có "Lorem"; dữ liệu demo đúng nghiệp vụ.

## 6. Ghi chú kỹ thuật đã chốt ở backend (đỡ đoán)

- Một service same-origin → **không CORS, không cấu hình cookie cross-site**. Cookie `fgs` là HttpOnly, cùng site → `credentials: 'same-origin'` (mặc định) là đủ.
- Đổi scope công ty: gửi header `x-company-scope: <companyId>` (hoặc `?scope=`), server vẫn kiểm tra quyền; đổi scope → refetch mọi số liệu, giữ nguyên bộ lọc (DS §7.7).
- Mutation luôn kèm `request_id` (UUID) — double-click/retry không tạo 2 bước duyệt.
- Đọc hồ sơ/transition dùng `if_match` = `version` (ETag). Nhận 409 → hiện `FG-WF-011.detail` + refetch, **không ghi đè im lặng**.
- Hành động nhạy cảm (duyệt, export, ngừng nhân sự, chuyển nội bộ) → server trả `FG-AUTH-008`/`data.need_verify` → mở dialog nhập **mật khẩu hoặc OTP** rồi gọi lại kèm `verify`.
- Báo cáo: 1 khung `report runner` + `columns[].type` (`money|compact|percent|date|number|status|days`) quyết định cách render → **không design 14 layout**.
- Excel/PDF: Excel qua `POST /exports` (stream, có watermark); PDF = route `/in/*` + print CSS, người dùng `Ctrl+P` (K-12) — **không** dựng render service.
- Bundle budget: initial gzip ≤ 350 KB, `manualChunks` tách `antd`+`@ant-design/plots`, font Inter self-host subset `vietnamese`, route `report/`+`admin/` lazy.

## 7. Kịch bản bấm thử sau khi xong P0+P1 (luồng vàng 1→3)

1. Đăng nhập `ktt.mp@fingate.local` → dashboard thấy exception + KPI.
2. Vào `Chờ tôi duyệt` → mở hồ sơ → tab **Tóm tắt** đủ 7 câu hỏi → bấm `Duyệt khoản 4,80 tỷ` → confirm → step-up OTP/mật khẩu → thành công, badge giảm ≤30s.
3. Đăng nhập `director.ap@fingate.local` → cố duyệt hồ sơ của MP → 403 `FG-RBAC-002`, UI phải hiện giải thích chứ không crash.
4. Hai trình duyệt cùng mở 1 hồ sơ → một bên duyệt trước → bên kia nhận 409 với đúng thông điệp.
