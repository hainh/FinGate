# FinGate — Audit khoảng trống (re-check toàn dự án)

> Ngày: 2026-09-16 · Phạm vi: `apps/*`, `packages/shared`, `db/`, `scripts/`, `.github/`, `docs/`
> Đối chiếu: `docs/01…04` (§4 cấu trúc, §10 API, §15 kiểm thử, §16 quy ước & DoD, §17 lịch thi công, §19 còn thiếu gì)

## 0. Kết luận nhanh

Nền tảng **P0 + phần lớn P1 + một phần P2 chạy được và sạch**: `lint` / `typecheck` / `test` / `build` đều **PASS**.
Các khoảng trống còn lại tập trung vào **kiểm thử (§15)**, **artefact tài liệu (§16/§19.3)**, **hợp đồng OpenAPI → types**, và **độ phủ màn hình** (mới ~40/127 mã trong `docs/03_screens.md`).

### Trạng thái chất lượng hiện tại

| Lệnh | Kết quả |
| --- | --- |
| `pnpm lint` | PASS — **0 error, 2 warning** (`react-hooks/exhaustive-deps` tại `apps/web/src/components/pagekit.tsx:51`, `shell.tsx:65`) |
| `pnpm typecheck` | PASS (shared `tsconfig.check.json`, api `--noEmit`, web `tsc -b`) |
| `pnpm test` | PASS nhưng **chỉ có test của `packages/shared`** (2 file / 58 test). `apps/api` và `apps/web` chạy `--passWithNoTests` → **0 test** |
| `pnpm build` | PASS. Cảnh báo: `advancedChunks` deprecated (Vite 8), `antd` chunk 983 kB > 500 kB |

---

## 1. Kiểm thử — lỗ hổng lớn nhất (§15)

§15 yêu cầu 4 tầng + test kiến trúc. Hiện **chỉ tầng Unit của `shared` là có**.

| Tầng §15 | Yêu cầu | Hiện trạng |
| --- | --- | --- |
| Unit (Vitest) | `money` (property sum/round/FX), `status/registry`, `workflow/transition` (mọi cạnh), matrix resolver, forecast, calendar | Chỉ có `money.test.ts`, `registry.test.ts`. **Chưa có** test cho `workflow/state-machine`, `workflow/matrix`, `calendar`, `reports`, `alerts`, `entitlement` |
| API integration | Vitest + `app.inject()` + `mongodb-memory-server`: mọi route 200/403/409/422; `history[]` mọi mutation; CAS → 409; idempotency `request_id`; upload prepare/confirm; `reconcile` rebuild audit | **Không có test nào**. `mongodb-memory-server` đã khai devDep nhưng bị `allowBuilds: false` |
| Frontend | Vitest + `@testing-library/react`: 8 trạng thái màn (DS §7.20), keyboard path, render `FgMoney`/`FgStatusChip` | **Không có test**. **Chưa có dep `@testing-library/react`** |
| E2E | Playwright (chromium + 1 mobile), 8 luồng vàng, seed cố định | **Không có `playwright.config.*`, không có `tests/`**. `pnpm e2e` và dep `@playwright/test` đã khai nhưng **sẽ fail** |
| Kiến trúc | route coverage theo `screenId`, import direction, `fg/no-*`, redaction snapshot | Chỉ có 1 phần `fg/no-raw-color` + cấm `parseFloat` trong `eslint.config.js`. **Thiếu** script route-coverage, redaction snapshot, import-direction |

- Chưa cấu hình **coverage ≥ 85%** cho `packages/shared` + `apps/api/src/domain`.
- `ci.yml` mới chạy `lint → typecheck → test → build → audit --prod`. **Thiếu**: `api:types` diff, script kiến trúc, `pnpm -r test --changed`.
- Chưa chạy `autocannon -c50 -d60` một lần trên Profile C để ghi trần vào runbook.

---

## 2. Hợp đồng API → types (`api:types`)

- Endpoint `GET /api/v1/openapi.json` **đã có** (`app.ts` + `@fastify/swagger`).
- **Nhưng** `packages/shared/src/api-types/index.ts` **chưa tồn tại** (thư mục chỉ có `.gitkeep`). Script `pnpm api:types` chưa chạy lần nào.
- Hệ quả: FE dùng types **viết tay** ở `apps/web/src/app/types.ts` → **nguy cơ lệch hợp đồng** với backend.
- `ci.yml` không có bước diff `api:types` như §16 quy định.

**Việc cần làm:** chạy `pnpm api:types` khi API sống, import type từ `@fingate/shared` thay vì khai lại, thêm bước CI kiểm tra diff.

---

## 3. Tài liệu / artefact còn thiếu (§16, §19.3) — thiếu **toàn bộ**

| Artefact | Trạng thái |
| --- | --- |
| `docs/adr/0001-*.md … 0018-*.md` (§18) | **Thư mục rỗng** |
| `docs/05_data_dictionary.md` (§8) | Thiếu |
| `docs/06_er_diagram.md` (Mermaid, 16 collection) | Thiếu |
| `docs/runbook.md` (cài mới · deploy · backup/restore · 8 sự cố §13) | **Đã có** — §7 đã bổ sung deploy Profile O bằng Docker (Dockerfile/compose/Caddy/cron/backup); **restore drill vẫn chưa chạy** |
| `docs/07_uat_scripts.md` | Thiếu |
| `docs/08_permission_matrix.xlsx` | Thiếu |
| `NOTICE.md` (license, MongoDB SSPL cho Profile O) | Thiếu |
| `CHANGELOG.md` (§16) | Thiếu |

---

## 4. Độ phủ màn hình

- `docs/03_screens.md` định nghĩa **127 mã màn hình**; `apps/web/src/routes.tsx` có **41 route** (bao gồm auth/errors). Khu Quản trị đã có web: `ADM-01` nhân sự, `ADM-04` ma trận, `ADM-06/07` công ty & bộ phận, `ADM-12` audit.
- **0 thuộc tính `data-screen`** trong toàn bộ web — quy ước §16 (`screenId ↔ screens/<...>/ ↔ data-screen`) **chưa được áp dụng**.
- Chưa có `/dev/components` hoặc Storybook (T-5, mức MAY).

**Nhóm màn hình còn thiếu (chưa có route):**
`MOB-01…06` · `IMP-01` · `SRCH-01` · `OVL-01…21` (catalog trạng thái DS §7.20) · `CASH-02…06` · `BANK-02/03/05/06/09` (gồm import sao kê CSV, đối chiếu) · `CHI-05/06/08/09` · `THU-03/05/06` · `DEBT-02/04/05/06` · `LOAN-02/03/04` · `ADM-02/03/05/08/09/10/11/13/14` · `APPR-04` · `DASH-02/04/08` · `NOTI-02/03` · `ERR-03/05/06` · `RPT-14` · `PREF-*` còn lại.

> Điều này **phù hợp tiến độ** (mới P0/P1 + phần P2), nhưng cần đối chiếu với bảng §17 trước khi chốt phạm vi kỳ 1 (§19.2 BA-10).

---

## 5. Việc kỹ thuật P0/P1 §19.4 còn dở

| # | Việc | Trạng thái |
| --- | --- | --- |
| T-1 | Spike deploy Render + Atlas M0 + R2 (cold start, presign) | Chưa có log/kết luận trong repo |
| T-2 | Spike mongoose 9 trên M0 (CAS, bulkWrite, replSet CI) | Chưa có test/kết luận |
| T-3 | Bootstrap + eslint custom rule + CI + `render.yaml` | **Xong** (eslint mới có 1 phần rule) |
| T-4 | `shared`: status/money/errors/contracts/tokens | **Xong** |
| T-5 | 8 `Fg*` + `AppShell` (+ `/dev/components`) | Xong kit, **thiếu `/dev/components`** |
| T-6 | `db/` models + indexes + seed 400 + `check:tie` + `rebuild-audit` | **Xong** (script ở `db/*.js`, models/seed nằm trong `apps/api/src/db`) |
| T-7 | API khung session/perms/scope/problem+json/OpenAPI/`api:types` | Xong, **`api:types` chưa sinh** |
| T-8 | `domain/workflow` + test mọi cạnh | Code xong, **thiếu test** |
| T-9 | `StorageAdapter` s3+fs + presign + version/key | **Xong** |
| T-10 | `tasks.yml` + `backup.yml` + restore drill | Workflow xong, **restore drill chưa có log** |

---

## 6. Rác / lệch tài liệu (nên dọn)

- `apps/web/README.md` — vẫn là template Vite mặc định.
- Rác template: `apps/web/public/vite.svg`, `apps/web/src/assets/react.svg`.
- `.gitkeep` thừa khi thư mục đã có file thật: `apps/web/src/{api,lib,app,screens}/.gitkeep`, `packages/shared/src/{api-types,contracts,errors,money,permissions,status,text}/.gitkeep`.
- `README.md` mục "Ghi chú phiên bản" ghi *"`db/*.js` … file chưa tạo"* — **đã lỗi thời**, tất cả script đã có.
- Log tạm ở gốc: `.tmpapi/*.log`, `frontend-session.log` (đã `.gitignore`, nhưng nên xoá tay).
- 2 warning lint `react-hooks/exhaustive-deps` cần sửa.
- Cảnh báo build Vite: `advancedChunks` deprecated → chuyển `codeSplitting`; tách `antd` chunk.

---

## 7. Nghiệp vụ / hạ tầng đang chặn (§19.1, §19.2)

Chưa có văn bản, **chặn code thật** (không chặn P0):

- **BA-1…BA-11**: ma trận duyệt thật, hạn mức chức danh, danh mục khoản chi/thu + chứng từ bắt buộc, ngưỡng `minBalance`, danh sách TK + định dạng sổ phụ, lịch nghỉ/lễ, nguồn ngân sách, UAT + ẩn danh dữ liệu.
- **10 câu hỏi mở `docs/03_screens.md` §24 (Q-01→Q-10)** chưa trả lời → chặn P2.
- **Cloudflare Access** (K-19) chưa cấu hình — hạ tầng, ngoài repo nhưng cần trước go-live.
- **Restore drill** chưa chạy → theo §13/§19.5-10 coi như **chưa có backup**.
- Chưa có văn bản đồng ý của Ban lãnh đạo trước khi đưa **số liệu tiền thật** lên Atlas M0/R2 free (BA-0).

---

## 8. Thứ tự ưu tiên đề xuất

1. **P1 — Kiểm thử**: dựng `playwright.config.ts` + 8 luồng vàng; bật `mongodb-memory-server` cho API integration; thêm `@testing-library/react` cho web; test mọi cạnh `workflow/state-machine` + `matrix`.
2. **P1 — `api:types`**: sinh types từ OpenAPI, bỏ types viết tay, thêm bước CI diff.
3. **P2 — Tài liệu**: `docs/adr/0001…0018`, `05_data_dictionary`, `06_er_diagram`, `runbook`, `07_uat_scripts`, `NOTICE.md`, `CHANGELOG.md`.
4. **P2 — Dọn dẹp**: xoá rác template, sửa 2 warning lint, sửa README lỗi thời, thêm `data-screen`.
5. **P3 — Bổ sung màn hình** theo §17 (docs) sau khi chốt phạm vi §19.2 BA-10.
6. **Song song** — thúc BA-1…BA-11 và chốt Q-01→Q-10; chạy `autocannon` + restore drill và ghi số vào runbook.

---

## 9. Ghi chú

- `db/` chỉ chứa **script chạy** (`migrate/indexes/seed/rebuild-*/archive/check-tie`) import từ `apps/api/dist`; models/seed thật nằm ở `apps/api/src/db`. Đây là **lệch có chủ ý** so với §4 (mô tả `db/` chứa models/indexes/seed) — nên ghi 1 dòng ADR để tránh nhầm sau này.
- `db/migrations/` hiện rỗng → `pnpm db:migrate` chạy vô hại với 0 migration.
