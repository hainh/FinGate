# FinGate — Nhật ký triển khai (Implementation Log)

**Ngày:** 15/09/2026 · **Phạm vi:** đợt xây đầu tiên (P0 hoàn chỉnh + nền tảng P1/P2)
**Tài liệu đối chiếu:** `01_Blueprint.md` · `02_design_system.md` · `03_screens.md` · `04_architecture.md`

> File này ghi lại **đã làm được gì, đã kiểm chứng tới đâu, lệch gì so với tài liệu, và việc còn lại**.
> Không thay thế 4 tài liệu thiết kế — chỉ là hồ sơ thi công.

---

## 1. Trạng thái tổng thể

| Tầng | Trạng thái | Kiểm chứng |
| --- | --- | --- |
| `packages/shared` | ✅ xong (P0 T-4) | **58 unit test pass**; build ra `dist/` có `.d.ts` |
| `apps/api` khung | ✅ xong (P0 T-7) | boot thật, `/healthz` trả `db: up`, problem+json hoạt động |
| `apps/api` domain | ✅ xong (P0 T-8/T-9 + P2 một phần) | chạy qua API thật với dữ liệu seed |
| `db/` scripts | ✅ xong (P0 T-6) | `pnpm db:seed --force` seed thành công 3 công ty / 12 user / 74 hồ sơ |
| `apps/web` | ⏸ **chưa làm** — giao cho session riêng (xem `10_frontend_handoff.md`) | — |
| lint rule tuỳ biến (`fg/*`) | ⏸ chưa viết (kiến trúc §15 yêu cầu) | — |
| Playwright E2E 8 luồng vàng | ⏸ chưa (cần web) | — |

**TypeScript:** `apps/api` + `packages/shared` typecheck 0 lỗi. **ESLint:** 0 lỗi.
**Build:** `pnpm -r build` sinh `apps/api/dist` chạy được bằng `node apps/api/dist/server.js`.

---

## 2. Đã làm chi tiết

### 2.1 `packages/shared` — nguồn duy nhất cho UI + API + Excel + email

| Module | Nội dung | Nguồn tham chiếu |
| --- | --- | --- |
| `status/` | 15 workflow status (exact literal), 3 trạng thái tài khoản **registry riêng**, maturity ladder 4 mức, doc kinds, actions, evidence types | DS §3.1–§3.5 |
| `money/` | `Money{minor:bigint}`,BigInt math (`add/sub/sum/cmp/divRound/convert/percentOf`), formatter `full/compact/kpi` chuẩn vi-VN, `parseMoneyInput` (paste Excel), `normalizeViNumber`, ngày nghiệp vụ `vnDate/ddmmyyyy/shortDate/weekdayDate/relativeTime` | DS §4, arch §8.5 |
| `errors/` | 40 mã `FG-*` + `ApiError` + `toProblem`/`parseProblem` (RFC 7807) | arch §6, §16 |
| `permissions/` | 28 quyền, ma trận 7 chức danh × quyền, hạn mức mặc định, `buildEntitlements()` trả actions + **cột bị ẩn kèm lý do** | blueprint §III, arch §7.1 |
| `contracts/` | Zod 4 là nguồn: documents/transition/matrix/attachments, auth+nhân sự+delegation, bank/loan/rollover/debt/forecast/budget, dashboard/newsletter/13 report presets/alerts/audit/search/tasks. `toJsonSchema()` → OpenAPI | arch §8.2, §10 |
| `text/` | toàn bộ nhãn UI tiếng Việt theo voice & tone | DS §11 |
| `ui/tokens.css` | 3 tầng token (primitive→semantic→component), **light + dark**, chart palette, density, focus ring, print CSS | DS §2 |
| `ui/index.ts` | re-export cho DS §12.5 (API không import file này) | ADR-09 |

**Test đã chứng minh** (`packages/shared/test/`):
- Tiền là số nguyên: `money(2.5)` **ném lỗi**; `Number()` ở quy mô > 2⁵³ sai số → BigInt đúng.
- Cấm cộng trừ khác loại tiền.
- `full` = `2.500.000.000 ₫`; `compact` = `2,50 tỷ` / `850 tr` / `−4,00 tỷ`; `kpi` = `125,6 tỷ`; `—` ≠ `0 ₫`.
- Parse `2.500.000.000` · `2,5 tỷ` · `850 tr` · `1,2 nghìn tỷ`; round-trip với formatter.
- Tỷ giá: 25.000,00 USD × 26310,50 → `657.762.500 ₫` (không dùng float).
- `vnDate` đúng múi VN tại thời điểm 18:00Z → 08/09 (chống bug "suy ngày từ UTC").
- Registry: mọi status có icon + nhãn + tone; `pending.*` luôn có owner; `deactivated` **không** dùng danger; maturity luôn kèm số ngày.
- Quyền: KT không tự duyệt; Chủ tịch không nhập liệu; cột nhạy cảm ẩn **kèm lý do**.
- `FG-AUTH-002` luôn là "Email hoặc mật khẩu không đúng" (chống dò email).

### 2.2 `apps/api` — 1 service Fastify (API + SPA), không transaction, không Redis

**Hạ tầng**
- `env.ts` zod fail-fast; dev tự sinh secret + cảnh báo; production **chặn boot** nếu thiếu `FIELD_KEY`/`TASK_TOKEN`.
- `db/models.ts`: 24 schema cho đúng collection §8.1 (+ `categories`, `recurring_rules`, `counters`); tiền `{minor: BigInt}`; `documents.history[]` nhúng; TTL index `sessions.expires_at`; unique `(account_id,value_date,ref)` chặn import sao kê trùng.
- `db/cas.ts`: **compare-and-swap 1 document** — `matchedCount 0 → 409 FG-WF-011` kèm `current_version/status` để UI báo "ai vừa sửa"; `alreadyProcessed(request_id)` chặn double-click tạo 2 bước duyệt.
- `db/indexes.ts`: đúng danh mục index §8.4 + JSON Schema validator chặn dữ liệu rác từ import.
- `lib/mongo.ts`: `withScope/scopedFind/scopedAggregate` — **`$match` scope ép vào đầu pipeline**, không đường nào đọc chéo công ty (§7.5).
- `lib/http.ts`: session cookie `fgs` (random id + hash, cache 60s, sliding idle 15'), thu hồi tức thì, guard đọc `config.perms` của route, error handler → problem+json, `defineRoute` **ném lỗi nếu route thiếu `perms`**.
- `lib/password.ts` scrypt (built-in, `maxmem` khai báo rõ); `lib/totp.ts` **tự hiện thực RFC 6238 + base32** ((xem mục 4)); `lib/crypto.ts` AES-256-GCM cho TOTP secret; `lib/cache.ts` TTL thay Redis; `lib/serialize.ts` `jsonSafe` (BigInt→string) + ETag/`max-age`.
- `storage/`: `StorageAdapter` + `s3` (R2 presigned PUT/GET, chỉ import AWS SDK khi `STORAGE_DRIVER=s3`) + `fs`; key `uploads/{co}/{doc}/{id}_v{n}_{sha8}.{ext}` → "chỉ thêm không xoá" bằng cấu trúc key; magic-bytes check PDF/DOCX/XLSX/JPG/PNG.
- `mail/sender.ts`: nodemailer + quiet hours 22:00–06:00 VN (non-danger), template invite/2FA/bản tin/SLA.

**Domain**
- `workflow/state-machine.ts`: đồ thị `TRANSITIONS` mọi cạnh; fast-track (§IV): cấp cao duyệt trước → các cấp chưa xử lý = `skipped` **không xoá**; ngưỡng gõ lại số tiền; step-up actions.
- `workflow/matrix.ts`: ma trận là **dữ liệu**, resolve lúc submit + **snapshot** `matrix_version/steps` vào phiếu; `withChairman()` theo ngưỡng cấu hình (`settings: approval.chairman_threshold_minor`, mặc định > 5 tỷ); mặc định §XX khi chưa cấu hình.
- `workflow/index.ts`: `submitDocument()` + `transition()` theo **đúng thứ tự 8 bước §9.1** (perms → step-up verify → đúng người/ủy quyền → hạn mức (nêu rõ trong detail) → evidence (trừ `override` + reason ≥20 ký tự) → CAS 1 doc → mirror audit/balances/notifications best-effort → email async).
- `entitlement/`: `resolveIdentity`, `scopeFor`, `documentPermissions()` trả `can` per hồ sơ (server-side, UI chỉ ẩn).
- `audit/`: history entry builder, `mirrorAudit` best-effort + `queueReconcile`, `rebuildAudit()` dựng lại feed từ `history[]`, `diffFields()` cho "trước/sau".
- `queries/`: `queryQueue` (projection, không trả `purpose/history/attachments`), `awaitingBadge` cache 60s, `accountSnapshots` (số dư mới nhất/TK + `stale` + `breach`), `maturityLadder` 4 bucket, `decisionPack` **đủ 7 câu hỏi** server tính 100%, `forecast` 7/30/60/90 + `first_breach_date` + shortfall per company, `dashboardOverview` một endpoint `Promise.all`.
- `reports/`: **1 runner + 13 preset** (`thu-chi-ngay` … `hs-ketoan`), mỗi preset có `columns()` khai báo cách format + `chart` + watermark; RPT-13 **không xếp hạng khi < 10 hồ sơ**.
- `alerts/`: 8 loại §XVIII, dedupe `rule+subject+period`, fanout theo `to_roles`, email chỉ severity 3.
- `newsletter/`: bản tin §XIV "tính khi đọc", cache vào `settings` (không thêm collection).
- `recurring/`: vật phiếu nháp theo kỳ + `last_run_period` chống trùng + nhắc 7/3/1.
- `rebuild/balances.ts`, `tie/` (+ `tie-lock.ts` khoá export khi lệch), `numbering/` (counter `$inc`), `calendar/` (SLA trừ ngày nghỉ).

**Routes** (`/api/v1`, mỗi route khai `perms` + `screen`)
`auth` (login 2 bước → challenge, 2FA/recovery code, logout, forgot/reset **cùng thông điệp chống dò**, activate gắn tự động công ty+chức danh, `/me`, prefs, đổi mật khẩu thu hồi mọi phiên) ·
`documents` (list, `/queue`, `/queue/processed`, `/needs-attention`, create, patch (khóa khi đã qua cấp), detail + `can`, decision-pack, history, transition, opinions, attachments prepare/confirm, `/attachments/:id` check quyền **từng lần** rồi 302) ·
`dashboard` (overview, today mobile, newsletter + lịch sử, forecast, reports list/runner, notifications + unread-count, alerts + ack, search) ·
`finance` (bank accounts + status **chặn khoá khi còn hồ sơ tham chiếu**, balances bulk **tự kiểm đầu+vào−ra=cuối** báo lỗi per dòng, history, statement import chặn trùng, loans, obligations, rollovers 4 bucket + preparation 30 ngày, debts + aging matrix, internal transfer **chặn cùng công ty**, export Excel stream có watermark + tự hạ cấp thành job khi vượt trần dòng) ·
`admin` (personnel list/invite/resend/deactivate (**bắt buộc chỉ định người thay** khi đang giữ hồ sơ)/transfer, delegations APPR-04 (chặn tự ủy quyền, chặn ủy vượt hạn mức, chặn trùng khoảng), matrix CRUD version++, companies/departments/categories (chỉ ẩn không xoá khi đã dùng), recurring, budgets, audit-log, sessions + revoke, db-stats, alert rules, settings) ·
`system` (`/healthz` degraded khi DB lỗi, `POST /api/v1/tasks/:name` so token **constant-time** + trả 202 rồi chạy background, tie status).

**Jobs** — `runTask()` với `claimJob()` dedupe → cron đến muộn không chạy đúp: `newsletter`, `sla-scan`, `alerts`, `recurring`, `maintenance`, `reconcile`, `rebuild-*`, `check-tie`, `archive`, `cleanup`.

**Scripts `db/`** — `migrate.js` (bảng trạng thái trong `settings`, idempotent, chỉ chạy file `NNNN-*.js`), `apply-indexes.js`, `seed.js --force`, `rebuild-balances.js`, `rebuild-audit.js`, `check-tie.js` (exit 1 khi lệch), `archive.js` (mặc định **dry-run**), `scripts/mail-test.js`.

---

## 3. Đã kiểm chứng bằng chạy thật

```bash
pnpm -F @fingate/shared build && pnpm -F @fingate/api build
pnpm db:seed --force     # 3 công ty · 12 user · 7 tài khoản · 15 matrix · 74 hồ sơ · 4 khoản vay · 6 công nợ
node apps/api/dist/server.js
```

| Kiểm tra | Kết quả |
| --- | --- |
| `GET /healthz` (Mongo đang chạy / đang chết) | `{"status":"ok","db":"up"}` / `{"status":"degraded","db":"down"}` — **boot không sập**, đúng mô hình PaaS ngủ/dậy |
| `POST /auth/login` (Giám đốc công ty AP) | `200 {need_2fa:false}`; sai mật khẩu → `FG-AUTH-002` một thông điệp duy nhất |
| `GET /queue` | phiếu thật: `PC-2026-00011 · 420 tr · Chờ kế toán kiểm tra · đang ở bàn Chuyên viên kế toán (Võ Thị Lan) · đã chờ 2 ngày` |
| `GET /dashboard/overview` | chờ duyệt **15 khoản · 56,01 tỷ**; đáo hạn 30 ngày **30 tỷ**; top rows kèm cấp duyệt kế tiếp; exception list tự xếp theo severity (ví dụ thực: `VietinBank •••• 4501 dưới ngưỡng tối thiểu`) |
| `GET /reports/cho-duyet` | 16 dòng + KPI nhóm theo cấp duyệt (Chuyên viên kế toán, Chủ tịch HĐQT…) |
| `GET /documents/:id/decision-pack` | đủ 7 mục: `q2_amount` là **string minor**, `q6_impact.breach=true`, `evidence.missing=[]` |
| `GET /api/v1/openapi.json` | sinh từ Zod, có tags + body schema |
| `pnpm test` (shared) | 58/58 pass |

---

## 4. Lệch so với tài liệu (có chủ đích, cần xác nhận)

| # | Lệch | Lý do |
| --- | --- | --- |
| L-1 | **Bỏ package `otp@2.0.1`**, tự hiện thực RFC 6238 + base32 trong `lib/totp.ts` (~90 dòng) | README đã ghi: kiến trúc chốt `13.5.0` nhưng npm không có. Tự làm = không phụ thuộc package dừng protect, không native dep (đúng tinh thần K-17), có test. |
| L-2 | `attachments:prepare` → **`attachments/prepare`** | `:` trong path bị path-to-regexp hiểu là tham số. Cùng hành vi. |
| L-3 | Context request gắn trên `req.fg` + **truyền tường minh**, không AsyncLocalStorage | Fastify không cho `preHandler` bọc phần còn lại của pipeline trong `als.run()`. Vẫn bảo đảm §7.5 vì mọi query đi qua `withScope/scopedAggregate`. |
| L-4 | `validationAction: 'error'` + validator chỉ cho `documents.amount` | Tránh chậm mọi insert trên Atlas M0; sẽ mở rộng khi có dữ liệu thật. |
| L-5 | Route khai `schema` (JSON Schema) nhưng **AJV tắt** (`noValidator`) | Một nguồn validation là Zod để chạy được `superRefine` (ràng buộc cross-field mà JSON Schema không diễn đạt được); JSON Schema vẫn喂 cho Swagger/OpenAPI. |
| L-6 | Thêm collection `categories`, `recurring_rules`, `counters` (24 schema / §8.1 ghi 16) | `categories` và `recurring_rules` là bắt buộc cho §VI/§XVII/Q-04; `counters` để sinh mã phiếu bằng CAS 1 doc. Ghi chú vào data dictionary khi viết. |

---

## 5. Việc còn lại (thứ tự khuyến nghị)

1. **Frontend P0–P2** — session riêng, xem `10_frontend_handoff.md` (brief đã viết sẵn: routes, data contract, DoD 8 trạng thái, token, component `Fg*`).
2. **ESLint custom rules** `fg/no-raw-color` · `fg/no-raw-number-format` · `fg/no-db-transaction` · `fg/no-raw-model-find` + script CI check mọi route có `perms` và screenId có route (arch §15).
3. **API integration test** (`app.inject()` + mongodb-memory-server — cần bật `allowBuilds.mongodb-memory-server: true`): mọi route 200/403/409/422, `history[]` có bản ghi cho mọi mutation, CAS conflict → 409, idempotency theo `request_id`, `reconcile` rebuild `audit_log`.
4. **Unit test domain** (chưa viết): `TRANSITIONS` mọi cạnh, matrix resolver + chairman threshold, calendar/SLA, forecast breach.
5. Seed **số dư đầu ngày** vào `balances_daily` — hiện dashboard "Tiền hiện có = 0 ₫" vì seed tạo tài khoản nhưng chưa nhập số dư (đây là **thiếu data demo**, không phải lỗi API; BANK-04 hoặc thêm vào `seed.ts`).
6. `docs/05_data_dictionary.md` + `06_er_diagram.md` + `runbook.md` + `adr/01–18` (§19.3 còn thiếu).
7. Quyết định hạ tầng BA-0/§12.5 (A/B/C/D) trước P1.


---

## 6. Session FRONTEND (web) — P0+P1 xong, một phần P2

**Đã dựng** (`apps/web/src/`) theo đúng thứ tự handoff `10_frontend_handoff.md` §4:

- `app/theme.ts` — ThemeConfig antd 6 map 1-1 token sáng/tối (file duy nhất được chứa hex);
- `app/store.tsx` — AppContext (theme/density persist localStorage + sync prefs server) + AuthContext (me/scope/entitlements) + QueryClient defaults (`refetchInterval 30s`, `keepPreviousData`, retry ở api-client);
- `app/api.ts` — envelope + `parseProblem`, `request_id` UUID tự sinh cho mutation, header `x-company-scope`, retry GET 2×2s, cold-start >3s → "Máy chủ đang thức dậy…"; **401 FG-AUTH-008/005 (step-up) không đá về login** (phiên còn sống);
- `components/` — FgButton/FgText/FgField/FgInput/FgSelect/FgMoneyInput/FgMoney/FgStatusChip/FgTable/FgCard/FgKpiCard/FgExceptionList/FgApprovalTimeline/FgDecisionPack/FgFilterBar(URL-state)/FgTabs/FgModal/FgDrawer/FgToast/FgErrorBoundary/FgAppShell (rail 240/72; mobile <768 còn 5 mục approval-first: Tổng quan · Chờ tôi duyệt · Cần xử lý · Đáo hạn · Dòng tiền);
- `screens/` — AUTH-01(+2FA)/03/04 · DASH-01 5 tầng · DASH-05 · APPR-01/02/03 (bulk bar có TỔNG TIỀN qua `sum()` BigInt) · DOC-01 5 tab + action bar chứa số tiền + phím tắt Alt+D/Alt+X + ladder: confirm 7 câu hỏi (decision-pack) → step-up mật khẩu/OTP (FG-AUTH-008) → gõ lại số tiền (FG-WF-007) → 409 FG-WF-011 modal "ai vừa sửa" (không ghi đè im lặng) · CHI-01/02/03/04/07 · THU-01/02/04 · BANK-01/04 · LOAN-01 · RENEW-01/02 · DEBT-01/03 · CASH-01 (SVG + ô breach đỏ) · RPT-00 + report runner 1 khung theo `columns[].type` · DASH-03 bản tin + In · NOTI-01 · SRCH-02 · ADM-01/04/12 · PREF-01 · ERR-01/02/04.

**Luật cứng giữ nguyên**: mọi tiền qua `money()/formatMoney()/parseMoneyInput()` shared; mọi status qua registry; chỉ token `--fg-*` (lint `fg/no-raw-color` đăng ký trong `eslint.config.js`, loại trừ theme.ts); mọi màn đi qua `FgQuery` (skeleton đúng hình · empty ≠ no-results · error có trace_id · 403 kèm giải thích · partial · stale).

**Kiểm chứng bằng bấm thật (chrome)**: luồng vàng 1→4 đạt — đăng nhập ktt.mp → dashboard exception/KPI → hàng chờ (8 hồ sơ · 36,55 tỷ) → mở DOC-01 → confirm 7 câu hỏi → "Duyệt khoản 3,50 tỷ" → step-up mật khẩu → FG-WF-004 (thiếu chứng từ, cần lý do ≥20 ký tự) → FG-WF-007 (gõ lại 7,08 tỷ) → **approved, version+1, history ghi nhận, modal tự đóng**; chairman fast-track; director.ap đọc hồ sơ AP đúng phạm vi; rail mobile còn 5 mục; dark mode đạt tương phản token.

### 6.1 Bug backend tìm ra nhờ web — đã sửa + rebuild + reseed

1. `lib/serialize.ts` — `jsonSafe` nay serialize ObjectId (bson) → hex chuỗi; trước đó `source.account_id`/`steps[].user_id` trả về `{i0,i1,…}` làm UI mù id;
2. `db/seed.ts` — 60 hồ sơ "extras" đặt step 1 `current` bất kể status → không user nào là người xử lý hợp lệ (`can.approve` false toàn hệ thống, luồng vàng chết). Nay đồng bộ `statusStepState[status]` như hồ sơ PLAN;
3. `routes/documents.ts` + `domain/workflow/index.ts` — so `user_id` step (ObjectId từ `.lean()`) với `actor.user_id` (string) bằng `===` → không bao giờ khớp; chuẩn hoá `String()`;
4. `domain/alerts` + `domain/queries` — `$match` aggregate không cast string→ObjectId (cùng họ bug, sửa nốt).

### 6.2 Lệch còn lại — việc backend kỳ sau

- email seed `giám đốc.mp@fingate.local` chứa dấu → zod `email` trả 422 — tài khoản GĐ MP KHÔNG đăng nhập được; đổi thành `director.mp@`;
- decision-pack `q6_impact` trừ tiền cả PHIẾU THU (thu phải cộng) → "Sau giao dịch −3,5 tỷ" khi xử lý phiếu thu;
- `documentPermissions.inScope` cho đọc mọi công ty khi có `doc:read` — chặn đọc chéo nên là FG-RBAC-002 ở route đọc;
- queue `mine=to_approve` tính cả bước `waiting` của mình → "Chờ tôi duyệt" lẫn hồ sơ đang ở bàn khác (UI đã ẩn nút theo `can`, nhưng danh sách gây nhiễu);
- `created_by_name` đôi khi sai người (lookup id → tên khác).

### 6.3 Ghi chú build/dev

- Initial gzip ≈ 381 KB (antd 312 + react 14 + app 55) — vượt nhẹ budget 350; gọt tiếp bằng cách bỏ re-export antd không dùng;
- Vite 8 = rolldown: **không dùng `output.manualChunks` function** (tách đôi react-router → crash runtime `basename of null` ở lazy chunk). Đã chuyển sang `advancedChunks.groups` + `optimizeDeps.include`; màn reports/admin đang import tĩnh cho chắc;
- API cache danh sách file static lúc boot → **restart api sau mỗi `vite build`**, nếu không `/assets/*` fallback về index.html (MIME sai, trắng màn);
- `pnpm api:types` (openapi sau auth) + font Inter self-host subset + E2E playwright: chưa chạy — việc kế tiếp.
