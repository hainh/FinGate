# FinGate

Công cụ nội bộ: lập phiếu thu/chi → duyệt theo cấp → ghi nhận đã trả → dòng tiền, đáo hạn, công nợ → báo cáo + bản tin.

Kiến trúc: `docs/04_architecture.md` · Blueprint `docs/01_Blueprint.md` · Design system `docs/02_design_system.md` · Screens `docs/03_screens.md`

## Yêu cầu

| Thành phần | Phiên bản |
| --- | --- |
| Node.js | 24 LTS (`>=24.10 <25`) |
| pnpm | 12.4.2 (đã khai trong `packageManager`) |
| Docker | để chạy MongoDB local (`pnpm infra:up`) |

## Chạy local (≤ 5 phút)

```bash
corepack enable                 # hoặc: npm i -g pnpm@12.4.2 (nếu corepack không có quyền)
pnpm install
cp .env.example .env            # rồi sửa SESSION_SECRET / FIELD_KEY / TASK_TOKEN
pnpm infra:up                   # MongoDB 8.0 single-node replica set rs0 (port 27017)
pnpm dev                        # shared (tsc -w) + api (node --watch) + web (vite :5173)
```

Kiểm tra nhanh:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm start                      # chạy API từ apps/api/dist/server.js
pnpm infra:down                 # tắt MongoDB local
```

## Cấu trúc

```text
apps/web/        React 19 + Vite 8 + antd 6 (SPA, build ra apps/web/dist)
apps/api/        Fastify 5 + mongoose 9 (API + serve SPA + /api/v1/tasks/:name)
packages/shared/ status · money · contracts · permissions · errors · text · api-types · ui
db/              models · migrations · indexes · seed · scripts
deploy/          compose.yml (mongo local) — Profile O
.github/         ci.yml · tasks.yml · backup.yml
```

Luật phụ thuộc: `apps/* → packages/shared`; `packages/shared` không import React ngoài `src/ui` (§4 architecture).

## Ghi chú phiên bản

- **TypeScript**: các package dùng `typescript@7.0.2` để build/typecheck. Riêng root dùng `typescript@6.0.3` chỉ để `typescript-eslint@8` chạy được — typescript-eslint chưa hỗ trợ API TS 7 (xem `typescript-eslint#10940`). Đây là cách "chạy song song TS 6" mà chính TypeScript khuyến nghị; không ảnh hưởng code đã compile.
- **`otp`**: architecture ghi `13.5.0` nhưng npm chỉ có tới `2.0.1` cho package `otp`. Đang dùng `2.0.1`; nếu ý định là `otplib` (v13) thì đổi lại trước P1.
- **`pnpm-workspace.yaml`**: `allowBuilds` chặn postinstall của `mongodb-memory-server` (tải binary Mongo ~100MB). Bật `true` khi viết API integration test (§15).
- `db/*.js` (migrate/indexes/seed/reset/bootstrap/check-tie/…) là việc của P0 T-6 — đã có đủ trong `db/`.
- **Tài khoản quản trị đầu tiên**: tự tạo khi DB rỗng (`BOOTSTRAP_ON_BOOT=true`, hoặc `pnpm db:bootstrap`) — mặc định `admin@fingate.local` / `fingate-demo-2026`, vai trò `admin` **quản lý thuần** (nhân sự · công ty/bộ phận · ma trận · cấu hình · audit; KHÔNG có quyền hoá đơn/phiếu thu chi). Xoá sạch DB: `pnpm db:reset --yes`.

## Debug app bằng MCP

`.mcp.json` (project — pi tự đọc qua `pi-mcp-adapter`, Cursor/Claude Code cũng đọc được):

| Server | Dùng để | Ghi chú |
| --- | --- | --- |
| `chrome-devtools` | console · network · DOM snapshot · performance trace · heap snapshot | pi đã có sẵn tool `browser_*` (pi-browser-use bọc chính chrome-devtools-mcp) → trùng khi dùng pi, nhưng hữu ích cho host khác |
| `playwright` | điều khiển browser, chạy 8 luồng vàng, sinh test E2E | |
| `mongodb` | soi collection/schema/index, aggregate, EXPLAIN | chạy `--readOnly`; `connectionId` mặc định = `preconfigured` |
| `node-inspector` | breakpoint · step · watch biến trong tiến trình Node của API | tự `launch` được, hoặc attach vào `pnpm -F @fingate/api dev:debug` (`--inspect=9229`) |

Sau khi sửa `.mcp.json`, chạy `/reload` trong pi (hoặc khởi động lại) — adapter chỉ đọc config lúc nạp, và mọi server là **lazy** (chỉ kết nối khi gọi tool nên không tốn context).

Connection string Mongo local nằm trong env `MDB_MCP_CONNECTION_STRING` của `.mcp.json`. Muốn cho phép ghi thì bỏ `--readOnly`. Đổi sang Atlas thì sửa env đó (đừng commit chuỗi có mật khẩu).

## Deploy

- **Profile C — Render free**: `render.yaml` đã khai web service + env + health check. Cần điền secret trong Render dashboard: `MONGODB_URI`, `FIELD_KEY`, `TASK_TOKEN`, `R2_*`, `SMTP_URL`.
- **Profile O — server thật bằng Docker** (VPS/VM nội bộ): `deploy/Dockerfile` + `deploy/compose.yml`.

```bash
cp deploy/fingate.env.example deploy/fingate.env   # điền secret + PUBLIC_URL
pnpm infra:prod                                    # = docker compose --profile onprem up -d --build
curl -s http://localhost:8080/healthz              # db: up
```

Chi tiết (HTTPS qua Caddy, job cron, backup/restore): `docs/runbook.md` §7.
