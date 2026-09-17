# FinGate — Runbook

> Hướng dẫn chạy & tự kiểm thử. Bổ sung cho `README.md` (bản ngắn) và `docs/09_audit_gaps.md` (khoảng trống).

## 1. Yêu cầu

| Thành phần | Phiên bản | Kiểm tra |
| --- | --- | --- |
| Node.js | 24 LTS (`>=24.10 <25`) | `node -v` |
| pnpm | 12.4.2 | `pnpm -v` (hoặc `corepack enable`) |
| Docker | để chạy MongoDB local | `docker --version` |

## 2. Chạy local (đã kiểm chứng end-to-end)

```bash
# 1) Cài dependency
pnpm install

# 2) Tạo .env từ mẫu (bắt buộc — app fail-fast nếu thiếu secret ở production; dev tự sinh nhưng nên đặt)
cp .env.example .env

# 3) Bật MongoDB 8.0 single-node replica set rs0 (port 27017)
pnpm infra:up

# 4) Build shared + api  ← BẮT BUỘC trước khi chạy db:* (script import từ apps/api/dist)
pnpm -F @fingate/shared build
pnpm -F @fingate/api build

# 5) Khởi tạo schema/index + dữ liệu demo
pnpm db:migrate        # 0 migration nếu thư mục db/migrations rỗng
pnpm db:indexes        # tạo ~40 index
pnpm db:seed           # seed demo (chỉ chạy khi users rỗng — thêm --force để seed đè)

# 6) Chạy dev: shared (watch) + api (:8080) + web (:5173)
pnpm dev
```

> **Muốn DB trắng (không dữ liệu demo)?** `pnpm db:reset --yes` (xoá sạch mọi collection) rồi
> `pnpm db:bootstrap` — tạo **tài khoản quản trị đầu tiên** + pháp nhân Tập đoàn (`GROUP`) làm gốc.
> Server cũng tự chạy bootstrap khi DB rỗng nếu `BOOTSTRAP_ON_BOOT=true` (mặc định).

Mở **http://localhost:5173** → đăng nhập bằng tài khoản demo (§3).

> Dev: Vite proxy `/api` → `http://localhost:8080` (same-origin, không CORS).
> Production: API tự serve SPA từ `apps/web/dist` (`WEB_DIST`).

Kiểm tra nhanh API:

```bash
curl -s http://localhost:8080/healthz
# {"status":"ok","version":"0.1.0","uptime_s":..,"db":"up","memory_mb":..,"profile":"cloud"}
```

## 3. Tài khoản demo (mật khẩu chung: `fingate-demo-2026`)

> **Tài khoản quản trị đầu tiên (bootstrap)**: `admin@fingate.local` / `fingate-demo-2026`
> (đổi bằng `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`, hoặc mật khẩu mới trong *Cá nhân*).
> Vai trò `admin` là **quản lý thuần** — nhân sự · công ty/bộ phận · ma trận duyệt · cấu hình ·
> tài khoản tập đoàn · audit — **KHÔNG** có quyền trên hồ sơ/hoá đơn/phiếu thu chi; sau đăng nhập
> được đưa thẳng vào khu **Quản trị** (`/quantri/nguoidung`). Danh mục dưới đây là **dữ liệu demo**,
> chỉ có sau `pnpm db:seed`.

Dữ liệu demo ẩn danh (BA-11), 3 công ty: **MP** (Minh Phúc), **AP** (An Phú), **HH**.

| Email | Vai trò | Công ty |
| --- | --- | --- |
| `chairman@fingate.local` | Chủ tịch (TGĐ) | tất cả |
| `admin@fingate.local` | Quản trị hệ thống | tất cả |
| `giám đốc.mp@fingate.local` | Giám đốc | MP |
| `pgd.mp@fingate.local` | Phó giám đốc | MP |
| `ktt.mp@fingate.local` | Kế toán trưởng | MP |
| `cv.mp@fingate.local` | Chuyên viên kế toán | MP |
| `kt.mp@fingate.local` | Nhân viên | MP |
| `director.ap@fingate.local` | Giám đốc | AP |
| `ktt.ap@fingate.local` | Kế toán trưởng | AP |
| `staff.ap@fingate.local` | Nhân viên | AP |
| `director.hh@fingate.local` | Giám đốc | HH |
| `ktt.hh@fingate.local` | Kế toán trưởng | HH |

> `admin` có `mfa_required: true` nhưng seed **chưa bật TOTP** → đăng nhập không hỏi 2FA. Muốn thử luồng 2FA: `Cá nhân → Bật 2FA`, quét QR bằng app xác thực.

## 4. Kịch bản test gợi ý

| # | Việc | Cách làm |
| --- | --- | --- |
| 1 | Đăng nhập & phân quyền theo công ty | Đăng nhập `ktt.mp` vs `ktt.ap` → scope chỉ công ty mình |
| 2 | Tạo phiếu chi thiếu chứng từ bị chặn inline | `Chi → Tạo phiếu` (CHI-02) → bỏ trống chứng từ → submit |
| 3 | Duyệt nhiều cấp | Login `ktt.mp` duyệt → `pgd.mp` → `giám đốc.mp` (mỗi cấp thấy ở *Chờ tôi duyệt*) |
| 4 | Yêu cầu bổ sung → resubmit giữ lịch sử | Ở màn duyệt chọn *Yêu cầu bổ sung*, rồi sửa + gửi lại; xem timeline ở DOC-01 |
| 5 | Decision-pack 7 mục + duyệt từ email | Mở hồ sơ (DOC-01) → *Duyệt* |
| 6 | Tranh chấp CAS (2 người duyệt cùng lúc) | Mở 2 tab duyệt cùng 1 phiếu → tab sau nhận 409 |
| 7 | Đáo hạn / đảo hạn | `Ngân hàng → Đáo hạn` (RENEW-01/02) |
| 8 | Báo cáo + export Excel | `Báo cáo` (RPT-00) → chạy 1 preset → Export |
| 9 | Import sao kê CSV, số dư | `Ngân hàng → Số dư` (BANK-04), `Ngân hàng → Tài khoản` (BANK-01) |
| 10 | Công nợ, dòng tiền | `Công nợ` (DEBT-01/03), `Dòng tiền` (CASH-01) |
| 11 | Đổi theme sáng/tối | Nút theme trên header; kiểm tra token `--fg-*` |
| 12 | Audit log | `Quản trị → Audit` (ADM-12) |
| 13 | Tạo công ty con | `Quản trị → Công ty & bộ phận` (ADM-06/07): **+ Thêm công ty** (mã HOA, không dấu cách) → thêm bộ phận |

> Kiểm tra tính toàn vẹn tiền: `pnpm check:tie` (lệch thì phải khoá export — §19.5-9).

## 5. Lệnh hữu ích

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # chất lượng
pnpm start                    # chạy API production từ apps/api/dist
pnpm db:rebuild-balances      # dựng lại số dư tổng hợp
pnpm db:rebuild-audit         # dựng lại audit_log từ history[]
pnpm db:reset                 # xoá sạch dữ liệu app (thêm --yes để xác nhận)
pnpm db:bootstrap             # tạo tài khoản quản trị đầu tiên nếu DB rỗng
pnpm db:archive               # lưu trữ dữ liệu cũ
pnpm check:tie                # kiểm tra cân đối
pnpm mail:test                # thử gửi mail (SMTP_URL)
pnpm api:types                # sinh types từ OpenAPI (⚠ xem §6)
pnpm infra:down               # tắt MongoDB local
```

## 6. Sự cố thường gặp

| Triệu chứng | Nguyên nhân / cách xử lý |
| --- | --- |
| `listen EADDRINUSE ... :8080` hoặc web nhảy sang `:5174` | Còn tiến trình cũ. Tìm & diệt: `netstat -ano \| grep -E ":8080\|:5173"` rồi `taskkill //PID <pid> //T //F` |
| `Env không hợp lệ: SESSION_SECRET ...` | Thiếu `.env`. `cp .env.example .env` |
| `db:*` báo `secret tự sinh` / trỏ sai DB | **Đã sửa:** `db/_common.js` nạp `.env` gốc repo trước `loadEnv()` (`process.loadEnvFile`), nên script dùng đúng `MONGODB_URI`/secret/`BOOTSTRAP_ADMIN_*` (biến môi trường đã đặt vẫn được ưu tiên). |
| Mongo không kết nối (`db":"down"`) | `pnpm infra:up`; đợi healthcheck `healthy` (`docker ps`) |
| Đăng nhập không được / sai mật khẩu | Mật khẩu demo là `fingate-demo-2026`; nếu DB đã bị seed bằng `FIELD_KEY` khác thì reset: `pnpm db:seed --force` |
| Banner **"Máy chủ đang thức dậy"** kẹt ở màn đăng nhập | **Đã sửa** (`apps/web/src/app/api.ts`: reset `coldStart` khi nhận *bất kỳ* response, kể cả 401 của `/me`) |
| TOTP mất sau khi restart | Dev tự sinh `FIELD_KEY` mỗi lần nếu `.env` không đặt → đặt `FIELD_KEY` cố định trong `.env` |
| **Mọi phiên "ghi nhớ" chết sau deploy** (ADR-19) | Token hash = HMAC(`SESSION_SECRET`) → `SESSION_SECRET` đổi là mất hết. `render.yaml` để `generateValue: true`: giá trị **được giữ qua các lần deploy**, nhưng **tạo lại service mới từ blueprint = secret mới = tất cả đăng xuất**. Muốn an toàn tuyệt đối: chuyển sang `sync: false` và dán một chuỗi ≥ 32 byte cố định trong Render Environment. `FIELD_KEY` đổi thì TOTP không giải mã được (không đăng xuất, nhưng phải bật lại 2FA). |

## 7. Deploy / Backup / Restore

> Chưa hoàn thiện — xem `docs/09_audit_gaps.md` §3 (thiếu `runbook` đầy đủ theo §19.3).

- Deploy: `render.yaml` (Profile C — Render free). Điền secret trong dashboard: `MONGODB_URI`, `FIELD_KEY`, `TASK_TOKEN`, `R2_*`, `SMTP_URL`.
- GitOps jobs: `.github/workflows/{ci,tasks,backup}.yml`.
- **Restore drill chưa chạy** → theo §13, chưa test restore = coi như chưa có backup.
