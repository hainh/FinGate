# FinGate — Kiến trúc hệ thống (System Architecture)

**Phiên bản:** 3.0.0 (deploy PaaS free — Render + MongoDB free tier) · **Trạng thái:** Draft for approval · **Ngày:** 15/09/2026
**Phạm vi:** blueprint `01` · design system `02` · screen inventory `03`.

> **Tinh thần:** FinGate là **công cụ nội bộ**, chạy được trên **nền tảng kiểu Render với bậc miễn phí**, không cần DevOps riêng, không cần Kubernetes.
> Thứ tự ưu tiên: **(1) đúng nghiệp vụ & đúng số tiền → (2) ít thành phần nhất có thể → (3) triển khai bằng 1 file cấu hình → (4) nâng cấp khi thật sự cần (§20).**
> Bản 3.0.0 thay bản 2.0.0 ở đúng một trục: **môi trường triển khai là PaaS free**, nên filesystem không bền và MongoDB free **không có transaction**. Hai ràng buộc đó ép kiến trúc **đơn giản thêm**, không phức tạp thêm (§2.3).

---

## 0. Đọc thế nào

| Bạn là | Đọc |
| --- | --- |
| Tech Lead | §1, §2, §3, §12, §18 |
| Backend | §3, §5, §6, §7, §8, §9 |
| Frontend | §3, §4, §6 |
| Người deploy (1 người, không chuyên) | §12, §13, §19.2 |
| BA / Design | §2.1, §9, §19, §21 |

**BẮT BUỘC** = không làm khác nếu chưa có quyết định mới (§18). **NÊN** = lệch thì ghi lý do trong PR. **MAY** = tuỳ đội.

---

## 1. Hệ thống này thực chất là gì

Web app nội bộ: lập phiếu thu/chi → duyệt theo cấp → ghi nhận đã trả → xem trước dòng tiền, đáo hạn, công nợ → báo cáo + bản tin. Có audit. Có bản responsive cho điện thoại.

Quy mô để thiết kế (không phải cam kết):

| Đại lượng | Dự kiến |
| --- | --- |
| Người dùng | 200–500, **đồng thời ~30–80** |
| Phiếu | ~300/ngày → ~100k / 5 năm |
| Dung lượng DB | ~0.4–0.6 GB / 5 năm (→ xem trần free tier §12.6) |
| Chứng từ | ~1.500 file/tháng, ~50 MB/file → ~90 GB / 5 năm |
| Đỉnh request | ~10 req/s |
| Sự cố | sửa trong ngày là chấp nhận được |

**Hai profile triển khai, cùng một codebase** (§12):

| | **Profile C — Cloud free** (mục đích của bản tài liệu này) | **Profile O — On-prem** (dữ liệu thật, dài hạn) |
| --- | --- | --- |
| App | Render Web Service (free 512 MB) hoặc $7/tháng | 1 VM/1 server nội bộ, Docker Compose |
| DB | MongoDB **Atlas M0 free** (512 MB, shared) | MongoDB Community 8.0 self-host (RS 1 node) |
| Files | Cloudflare **R2** 10 GB free (S3-compatible) | thư mục đĩa `./data/uploads` |
| Cron | GitHub Actions schedule → `POST /v1/tasks/:name` | `setInterval` trong app + cron hệ thống |
| Backup | GH Actions `mongodump` → đẩy lên R2 | `mongodump` + rsync NAS |
| vào được từ | internet (có Cloudflare Access) | mạng nội bộ/VPN |
| Dùng cho | demo, UAT, pilot 1 công ty, staging | **go-live chính thức** |

> **Điểm trung thực phải nói trước:** Atlas M0 + Render free **không dành cho dữ liệu tiền thật lâu dài** (512 MB, không backup tự động, không transaction, instance ngủ khi không dùng). Nó **rất tốt** cho demo/UAT/pilot. Kiến trúc dưới đây được thiết kế để: **chạy được ngay trên free, và lên production chỉ bằng cách đổi env + upgrade tier, không đổi code.** (ADR-02, §19.2 BA-0.)

---

## 2. Quyết định kiến trúc

### 2.1 Chốt phương án

| # | Quyết định | Vì sao |
| --- | --- | --- |
| K-1 | **Một service duy nhất**: Node/Fastify vừa serve API vừa serve SPA build sẵn (tài nguyên tĩnh nằm trong image) | same-origin → **không CORS, không cấu hình cookie cross-site**, 1 URL, 1 chỗ deploy |
| K-2 | **Không microservices, không NestJS.** Fastify 5 + plugin + folder-per-domain | thêm DI/decorator không mua lại được gì ở quy mô 1 người vận hành |
| K-3 | **MongoDB + mongoose**, kết nối `MONGODB_URI` — Atlas M0 (cloud) hoặc self-host (on-prem) | cùng code, chỉ đổi env |
| K-4 | **KHÔNG dùng multi-document transaction.** Mọi mutation = **1 conditional update trên 1 document** (compare-and-swap) + audit **nhúng trong document đó** | Atlas shared tier (M0/M2/M5) **không hỗ trợ transaction**; ràng buộc này hoá ra làm code đơn giản hơn và ít deadlock hơn (§7.3, §8.6) |
| K-5 | **`document.history[]` là nguồn sự thật của audit**; collection `audit_log` chỉ là "feed" suy diễn để tìm kiếm trên nhiều hồ sơ, có script rebuild | không cần atomicity 2 collection (§7.4) |
| K-6 | **Không Redis.** Session trong Mongo + cache in-memory TTL 60s | 1 thành phần ít đi; session vẫn thu hồi tức thì được |
| K-7 | **Không queue (BullMQ), không cron trong tiến trình.** Job = collection `jobs` + **"tính khi đọc, cache kết quả"**; việc bắt buộc đúng giờ (bản tin 06:30, nhắc SLA) gọi qua `POST /v1/tasks/:name` do **GitHub Actions schedule** đánh thức | instance free **ngủ khi không có request** → cron trong tiến trình sẽ không chạy; GH Actions free 2000 phút/tháng là đủ và không thêm dịch vụ |
| K-8 | **Chứng từ để ở object storage S3-compatible** (Cloudflare R2 10 GB free / B2 10 GB free) qua **presigned PUT** — **không** ghi đĩa, **không** stream qua RAM của app | filesystem trên Render **bị xoá khi deploy/restart**; app chỉ có 512 MB RAM nên không nhận file 25 MB rồi chuyển tiếp an toàn |
| K-9 | `StorageAdapter` interface với 2 implementation: `s3` (cloud) và `fs` (on-prem/dev) | chọn bằng env `STORAGE_DRIVER`; không có branch code nào khác |
| K-10 | **Không Sentry/OTel/Prometheus.** `pino` → stdout → log của Render; `/healthz` | Render có log UI + alert cơ bản; người vận hành là 1 người |
| K-11 | **Không WebSocket/SSE.** FE **poll 30s** + refetch khi focus window | badge trễ 30s không sao; hết reconnect, hết fan-out |
| K-12 | **PDF bằng trình duyệt in** (route `/in/*` + print CSS); Excel bằng `exceljs` **stream trực tiếp response** | hết render service, hết Playwright, hết 300 MB image |
| K-13 | **Không PWA/web push** kỳ 1: mobile = web responsive + **email** cho khoản danger | blueprint §XXIV yêu cầu responsive + notification; email đạt; web push iOS không tin được. MAY thêm PWA sau |
| K-14 | **Không search engine / không Atlas Search.** Mongo index + regex/text | M0 không cho Atlas Search; dữ liệu 100k doc thì index thường đủ |
| K-15 | **Tiền = số nguyên `minor units`** (`Long`) + `currency`; wire format **string**; tính bằng `BigInt` | "không được sai số tiền" — cái này **không** nằm trong phạm vi được đơn giản hoá |
| K-16 | **Workflow tập trung**: 1 hàm duy nhất đổi `status`, quyền + ngưỡng + step-up verify **server-side**, mọi request | yêu cầu "không chỉ duyệt, phải kiểm soát" (§XXVII) |
| K-17 | **Mật khẩu bằng `node:crypto.scrypt`** (built-in) | không native dependency → build trên Render free không risk fail vì compile binary |
| K-18 | **Không tự đăng ký tài khoản.** Chỉ login; mọi user do người có quyền mời (§XXIX) → đóng cửa tự đăng ký, bớt 1 lớp tấn công khi đưa app ra internet | app nằm trên internet công cộng |
| K-19 | Chốt lớp cổng: **Cloudflare Access (free ≤ 50 user)** trước domain app, hoặc IP allowlist, *ngoài* login + TOTP | chi phí 0, chặn gần hết scanner/brute-force vào một hệ thống tài chính |
| K-20 | **pnpm workspace 2 package** (`apps/{web,api}` + `packages/shared`), không Turbo/Nx, không Docker **cho cloud** (build Node trực tiếp) | Render free **không hỗ trợ Dockerfile deploy**; `Dockerfile` chỉ dành cho Profile O |

### 2.2 Loại có ý thức (ghi để sau này đừng "tối ưu" thành thêm thứ)
Kubernetes · NestJS · Next.js/SSR · Redis · Kafka/RabbitMQ · BullMQ · MinIO/S3 tự dựng · Elasticsearch/Meilisearch · GraphQL · gRPC · CQRS/event-sourcing · Terraform/Helm · Service mesh · CI self-hosted · mobile native · SSO/OIDC (để dành, chỉ chừa interface) · chữ ký số · multi-region · auto-scaling · feature-flag system.

### 2.3 Sơ đồ (Profile C)

```text
  trình duyệt (PC / tablet / điện thoại — cùng một web, responsive)
        │
        ▼  https://fingate.company.com
  ┌──────────────────────────┐
  │ Cloudflare Access (free) │  chỉ user được phép + device do công ty quản lý
  └────────────┬─────────────┘   (MAY: bỏ lớp này nếu chấp nhận public + 2FA mạnh)
               ▼
  ┌───────────────────────────────────────────────┐
  │ Render Web Service (Node 24, free 512MB/0.1CPU)│  ← ngủ sau 15' không có request
  │  Fastify 5                                    │     (cold start ~30–50s → §12.5)
  │   ├─ /            apps/web/dist (SPA)         │
  │   ├─ /api/v1      routes + zod + services     │
  │   ├─ /api/v1/tasks/:name  ← GH Actions 6:30   │
  │   └─ /healthz                                 │
  └───────┬───────────────────────┬───────────────┘
          │ mongoose (no tx)      │ presigned PUT/GET (file đi thẳng browser↔R2)
          ▼                       ▼
  ┌───────────────────┐   ┌────────────────────────┐
  │ Atlas M0 free     │   │ Cloudflare R2 (10GB)   │
  │ 512MB · shared    │   │ uploads/{co}/{doc}/{id}│
  │ no transactions   │   │ /v{n}_{sha8}.{ext}     │
  └───────────────────┘   └────────────────────────┘
          ▲
          │ nightly mongodump → cùng file nén đẩy sang R2 (private)
  ┌───────────────────────────────────────────────┐
  │ GitHub Actions (free): cron tasks · backup ·  │
  │ CI (lint/typecheck/test/build) · restore drill│
  └───────────────────────────────────────────────┘
  SMTP công ty (nodemailer) · Email digest  ← mail đi ra ngoài, không có dịch vụ mail riêng
```

**Không có gì khác.** Không worker riêng, không CDN riêng, không "infra" folder phức tạp.

---

## 3. Stack & phiên bản

### 3.1 Chung

| Thành phần | Phiên bản / chọn |
| --- | --- |
| Node.js | **24 LTS** — `24.21.0`; `engines: ">=24.10 <25"`. Node 26 chưa LTS (28/10/2026) → chưa dùng |
| pnpm | **12.4.2** (`packageManager` field để Render dùng đúng bản) |
| TypeScript | **7.0.2** |
| Zod | **4.6.5** (một nguồn schema cho web + api + OpenAPI) |
| Vitest / Playwright / ESLint / Prettier | **5.0.1 / 1.63.0 / 10.10.0 / 3.9.6** |
| MongoDB Server | **8.0** — Atlas M0 (cloud) hoặc Community self-host (Profile O) |

### 3.2 Frontend (`apps/web`)

| Package | Phiên bản | Vai trò |
| --- | --- | --- |
| react / react-dom | **19.3.0** | UI |
| antd | **6.6.4** | design engine (`cssVar` + ThemeConfig) |
| @ant-design/icons | **6.3.4** | icon chung |
| @ant-design/plots | **2.6.8** | area/line/bar cho Dashboard + forecast (1 lib duy nhất) |
| react-router | **8.3.1** | routing SPA |
| @tanstack/react-query | **5.102.8** | server state + poll 30s |
| dayjs | **1.11.23** (+ plugin `utc`,`timezone`) | date; **Render chạy UTC** → mọi "ngày nghiệp vụ" format theo `Asia/Ho_Chi_Minh` |

**Bỏ:** zustand → `AppContext` ~60 dòng (scope/density/theme) persist `localStorage` · Tailwind → `tokens.css` + antd `cssVar` · react-hook-form → antd `Form` + `zodResolver` · localforage → `localStorage` cho draft · echarts → plots đủ · dompurify → render ý kiến **as text**.

### 3.3 Backend (`apps/api`)

| Package | Phiên bản | Vai trò |
| --- | --- | --- |
| fastify | **5.12.4** | HTTP + serve SPA |
| @fastify/cookie | **11.1.2** | session cookie |
| @fastify/helmet | **13.1.1** | CSP + headers |
| @fastify/rate-limit | **11.2.0** | brute-force login, `/tasks` |
| @fastify/static | **10.1.3** | `apps/web/dist` |
| @fastify/swagger | **9.8.1** | OpenAPI 3.1 từ JSON Schema do Zod sinh |
| mongoose / mongodb | **9.10.1 / 7.6.0** | ODM; `maxPoolSize: 10` (trần connection của M0) |
| @aws-sdk/client-s3 + s3-request-presigner | **3.1132.0** | R2/B2/S3 — **chỉ dùng khi `STORAGE_DRIVER=s3`** |
| @fastify/multipart | **10.1.1** | chỉ cho **import Excel/CSV** (file nhỏ); chứng từ → presigned |
| otp | **13.5.0** | TOTP 2FA |
| nodemailer | **10.0.10** | SMTP công ty |
| exceljs | **4.4.0** | export Excel (stream) |
| pino | **10.3.1** | log |
| openapi-typescript (dev) | **7.13.0** | sinh type API cho web |

**Bỏ:** NestJS, ioredis, bullmq, argon2 (native), jsonwebtoken, OTel, Sentry, pdfmake/pdf-lib, gridfs, sharp, helmet-extras.

### 3.4 Trần của bậc free — phải biết trước (xác nhận lại trên dashboard trước khi go-live)

| Nền tảng | Giới hạn đã biết | Hệ quả lên thiết kế |
| --- | --- | --- |
| Render Free Web Service | 512 MB RAM · 0.1 CPU · **ngủ sau ~15' không có traffic** · cold start tới ~50s · **filesystem ephemeral** (mất khi restart/deploy) · **Dockerfile không có ở bậc free** · build minutes có hạn | presigned upload (K-8), không cache dữ liệu lên đĩa, không cron trong tiến trình (K-7), build Node trực tiếp (K-20), giữ bundle gọn |
| Atlas M0 free | **512 MB storage** · shared CPU/RAM · **không multi-document transaction** · **không backup/PITR** · số connection thấp · cluster có thể bị **pause** khi không dùng | CAS single-doc (K-4), `history[]` nhúng (K-5), archive hồ sơ đóng sang R2 (§8.7), dump nightly tự quản (§13), keep-warm ping (§12.5) |
| Cloudflare R2 free | 10 GB storage · có free operations · **không phí egress** · không có versioning tự nhiên như S3 (bucket policy + key theo version) | presigned 5 phút; **phiên bản chứng từ nằm trong key** `.../v2_ab12cd.pdf` → "chỉ thêm không xoá" vẫn đúng (DS §7.9) |
| GitHub Actions free (public/team) | 2000 phút/tháng, 1 job chạy đồng thời | đủ cho 5 cron task + nightly dump + CI (~15 phút/PR) |

---

## 4. Repo

```text
fingate/
├─ pnpm-workspace.yaml              # apps/* packages/*
├─ package.json                     # engines + packageManager + scripts (Phụ lục A)
├─ tsconfig.base.json               # strict:true
├─ render.yaml                      # ★ Blueprint: web service + env + health check + preDeploy
├─ .node-version                    # 24.21.0
├─ .github/workflows/
│   ├─ ci.yml                       # lint · typecheck · test · build · api:types diff
│   ├─ tasks.yml                    # ★ cron UTC: 23:30 (=06:30 VN) bản tin · /15 sla · nightly dump
│   └─ backup.yml                   # mongodump → gzip → upload R2 (private) + verify
├─ apps/
│  ├─ web/   src/{app,screens,api,lib} + routes.tsx          # 1 thư mục = 1 screenId
│  └─ api/   src/{server.ts,db,lib,domain,routes,jobs,mail,storage}
├─ packages/shared/src/{status,money,contracts,permissions,errors,text,api-types,ui}
├─ db/         models · migrations/NNNN-*.js · indexes.js · seed/ · scripts/
├─ deploy/     compose.yml · Dockerfile · Caddyfile · backup.sh · fingate.env.example   # ★ CHỈ cho Profile O
└─ docs/       01→04 · adr/ · runbook.md
```

```text
apps/api/src/
├─ server.ts                # wiring: plugins + routes + static + graceful shutdown
├─ env.ts                   # zod-validated env, fail-fast, có STORAGE_DRIVER, TZ mặc định
├─ db/                      # connect (pool 10), indexes.js apply, cas.js (compare-and-swap helper)
├─ domain/
│  ├─ workflow/             # ★ state machine — chỗ DUY NHẤT đổi status
│  ├─ entitlement/          # ★ role + scope + ngưỡng tiền + cột bị ẩn — chỗ duy nhất trả lời "được thấy gì"
│  ├─ money/                # BigInt, sum, fx, rounding
│  ├─ audit/                # ghi history[] trong document + mirror sang audit_log (best-effort) + rebuild
│  ├─ forecast/  alerts/  numbering/  calendar/
├─ routes/                  # 1 file = 1 nhóm; mỗi route khai báo { perms, schema }
├─ jobs/                    # newsletter · export · sla-scan · recurring · archive · cleanup · rebuild-audit
├─ storage/                 # adapter.ts + s3.ts + fs.ts
└─ mail/                    # templates (HTML gọn) + sender
```

**Luật phụ thuộc (chặn bằng lint):** `apps/web → packages/shared` · `apps/api → packages/shared` (không import `shared/src/ui`) · `packages/shared` không import react ngoài `src/ui`.
`status/registry` + `money` nằm ở `packages/shared` (code dùng được 2 phía), `shared/src/ui` re-export để Design System §12.5 giữ nguyên tên gọi. Không có package `ui` thứ ba — ít hơn 1 tầng config.

**Component `Fg*`** giữ nguyên danh mục DS §6/§7 — đây là cam kết thiết kế, không phải chỗ để tối giản.

---

## 5. Frontend

- **SPA React + Vite 8**, build ra `apps/web/dist`, được **chính service Node serve** (K-1). Không SSR, không Next.
- **Route khai báo 1 chỗ**, mỗi route mang `screen` (screenId) + `perms`:

```tsx
{ path: '/cho-toi-duyet',   element: <Appr01 />, screen: 'APPR-01', perms: ['approval:act'] }
{ path: '/ho-so/:kind/:id', element: <Doc01  />, screen: 'DOC-01',  perms: ['doc:read'] }
```
  `routes.tsx` được cả app lẫn CI dùng: script parse `03_screens.md` → screenId đã vào phase hiện tại mà thiếu route/test → **fail**.
- **URL là state của danh sách**: `?scope=co:A&status=pending.gd&sort=-waiting&page=2` → deep-link từ email + nút back hoạt động, không cần store.
- **Query chuẩn (poll 30s thay realtime):**

```ts
export const useQueue = (f: QueueFilter) => {
  const { scope } = useApp();
  return useQuery({
    queryKey: ['queue', scope, f],
    queryFn: () => api.queue(scope, f),
    refetchInterval: 30_000, refetchOnWindowFocus: true,
    staleTime: 15_000, placeholderData: keepPreviousData,
  });
};
```
- `apiClient` duy nhất: `credentials:'same-origin'` (không cần — same origin), 401 → màn `AUTH-06`, 403 → `ERR-02`, 409 → "hồ sơ đã bị người khác duyệt" + refetch, `FG-*` code map sang thông điệp.
- **Cold start UX (bắt buộc vì K-1):** request đầu > 3s → skeleton + dòng "Máy chủ đang thức dậy, vui lòng chờ…"; `retry: 2` với backoff 2s cho GET; **không** retry POST. Trang `ERR-04` phân biệt "mạng lỗi" vs "server đang ngủ".
- **Mọi số qua `shared/money`, mọi status qua `status/registry`**; lint `fg/no-raw-number-format`, `fg/no-raw-color` (cấm `toFixed`/`toLocaleString`/hex trong `apps/**`).
- Server trả `entitlements` (actions + cột bị ẩn) → UI ẩn nút. Ẩn chỉ là mỹ thuật; server vẫn chặn (§7).
- Bundle: `manualChunks` tách `antd`+`plots`; **budget initial gzip ≤ 350 KB**; font **Inter self-host** subset `vietnamese`; route `report/`, `admin/` lazy.
- **Mobile**: responsive DS §5.4 (touch 44px, layout dọc cho `MOB-*`/`DASH-08`) — **cùng data contract**, chỉ khác layout. Không PWA kỳ 1 (MAY: thêm manifest + "Thêm vào MH chính").

---

## 6. Backend

```ts
// apps/api/src/server.ts — toàn bộ wiring trong ~40 dòng
export async function build() {
  const env = loadEnv();                                   // zod, fail-fast
  const app = Fastify({ logger: pinoCfg(env), bodyLimit: 8 * 1024 * 1024, trustProxy: true });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(helmet, { contentSecurityPolicy: csp(env) });
  await app.register(swagger, { openapi: { openapi: '3.1.0', info: { title: 'FinGate API', version: '1.0.0' } } });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 5 } }); // chỉ import Excel/CSV
  await app.register(static, { root: env.WEB_DIST, prefix: '/', wildcard: false });   // SPA
  app.addHook('preHandler', sessionAuth);                   // cookie → session doc (cache in-memory 60s)
  app.addHook('preHandler', tenantScope);                   // AsyncLocalStorage: companyIds
  app.addHook('preHandler', permissionGuard);               // đọc meta { perms } của route
  routes.forEach(r => app.register(r));
  app.post('/api/v1/tasks/:name', taskGuard);               // K-7: chỉ nhận từ GH Actions (x-task-token)
  app.get('/healthz', health);
  return app;
}
```

- **Không DI.** Một domain = `{ schema.ts, service.ts, routes.ts }`; service nhận deps qua tham số → test truyền fake dễ hơn mock decorator.
- **1 request:** `cookie → session → scope → perms → zod validate → service → CAS update (1 doc) → mirror audit → email best-effort → response → 1 dòng log`.
- **Envelope:** OK = resource (không cache HTTP, §8.3.1); lỗi = `application/problem+json` (`type,title,status,code,detail,trace_id`), `code` bắt buộc có trong `shared/errors.ts` (`FG-WF-007`…).
- **Concurrency = CAS, không transaction:** mọi mutation kèm `If-Match` (version) → `updateOne({_id, version}, {..., $inc:{version:1}})`; `matchedCount === 0` → `409 FG-WF-011` "hồ sơ đã thay đổi".
- **Idempotency:** mutation từ UI gửi kèm `request_id` (UUID); `audit`/`history` lưu `request_id` unique-ish → double-click/retry không tạo 2 bước duyệt.
- **Tiền trên wire là string** `"2500000000"`, FE parse `parseMoney()`. Cấm `Number` arithmetic cho tiền ở mọi tầng.
- **OpenAPI:** `zod → zod-to-json-schema → @fastify/swagger → openapi.json → openapi-typescript → packages/shared/src/api-types`. `pnpm api:types` chạy trong CI; có diff mà quên commit → fail.
- **Upload chứng từ (K-8):**
  1. `POST /v1/documents/{id}/attachments:prepare { filename, size, mime, sha256 }` → server check magic-bytes-allowed-list (PDF/DOCX/XLSX/JPG/PNG), size ≤ 25 MB, hạn mức dung lượng per company → trả `{ upload_url, key, attachment_id, version }` (presigned PUT 5 phút, `Content-Type` bắt buộc).
  2. Browser PUT **thẳng lên R2** (không đi qua app → không ăn RAM/đĩa ephemeral).
  3. `POST /v1/documents/{id}/attachments:confirm { attachment_id }` → server `HeadObject` (tồn tại? đúng size? đúng sha256?) → CAS thêm phần tử vào `document.attachments[]` **và** `history[]` trong 1 update.
  4. Không có endpoint xoá. Tải về: `GET /v1/attachments/{id}?v=n` check quyền **từng lần** rồi 302 sang presigned GET 60s (hoặc stream từ `fs` ở Profile O).
- **Export Excel:** stream trực tiếp `reply.raw` qua `exceljs` (`workbook.xlsx.write(reply.raw)`), watermark "Xuất bởi {user} · {time}"; **limit 50.000 dòng** vì CPU 0.1 nhân; > limit → `jobs` trả file trên R2 + link hết hạn.
- **Graceful shutdown** (`SIGTERM` của Render): ngừng nhận request, để `reply` xong (timeout 10s < grace mặc định), đóng mongoose. Không có queue cần drain.

---

## 7. Quyền · phiên · audit · con người

### 7.1 Mô hình data (đủ §III + §XXIX, không hơn)

```text
Company     { name, code, tax_code, min_balance_minor, working_calendar, status }
User        { email, display_name, password:{kdf:'scrypt',hash,salt}, status: pending|active|disabled,
              totp:{enabled, secret_enc}, recovery_codes:[hash], mfa_required, prefs }
Assignment  { user_id, company_id, department_id, role, amount_limit_minor, scope_all,
              status, valid_from/to }        # 1 người nhiều assignment; role = 7 chức danh §III
Delegation  { user_id, to_user_id, role, valid_from/to, reason }          # APPR-04
ApprovalMatrix { company_id, doc_kind, category_id?, amount_min/max, currency,
                 steps:[{order, role, sla_hours, mandatory}], version, effective_from }
Session     { token_hash, user_id, company_scope, ip, ua, created_at, last_seen, expires_at (TTL index) }
Permission  (registry): doc:read doc:create doc:submit approval:act approval:override payment:mark
  bank:read bank:transfer loan:read rollover:act debt:read budget:read budget:write forecast:read
  report:view report:export alert:config hr:invite hr:disable admin:matrix admin:settings audit:read
```

### 7.2 Đăng nhập & 2FA (AUTH-01/02/06)

- Mật khẩu: `crypto.scrypt(pw, salt, 64, { N: 2**15, r: 8, p: 1 })` (built-in, không native dep cho build Render), so sánh `timingSafeEqual`.
- Session: cookie `fgs` = **random id**, doc trong `sessions` (`HttpOnly; Secure; SameSite=Lax`, Path=/). Cache in-memory `Map` TTL 60s.
- **Yêu cầu phiên (ADR-19): giữ đăng nhập LÂU NHẤT CÓ THỂ.** Mặc định mọi phiên là loại "ghi nhớ" (`loginBody.remember = true`) với hạn **cuộn 400 ngày** (`SESSION_REMEMBER_DAYS` — 400 là trần `Max-Age` trình duyệt, không đặt dài hơn được). Mỗi lần có hoạt động, hạn được nạp lại thành 400 ngày (write tối đa 1 lần/ngày/phiên) và server phát lại `Set-Cookie` để Max-Age đếm lại → **người dùng hoạt động định kỳ không bao giờ phải đăng nhập lại**. Bỏ chọn ở màn `AUTH-01` → quay về chế độ nghiêm: idle **15 phút**, absolute **8 giờ**, heartbeat 5 phút, quá hạn → `AUTH-06` giữ draft.
- `GET /me/session` trả `persistent` + `idle_limit_s` (`null` khi persistent) + `absolute_expires_at` để client không hiện đồng hồ đếm ngược sai.
- **Cái giá phải trả (đã chấp nhận — ADR-19):** máy tính bỏ trống trong ca làm việc còn phiên sống → người khác tạo được phiếu nháp và xem được số liệu. Lớp chặn còn lại là **step-up verify (ADR-14)** — `approve` / `reject` / `pay` / `report:export` / `hr:disable` / đổi cấu hình đều phải nhập lại mật khẩu hoặc OTP **kể cả khi đang đăng nhập**; cùng với CSP `frame-ancestors 'none'`, `SameSite=Lax`, lockout đăng nhập và ADM-13 (thu hồi phiên từ xa). Khi nhân sự nghỉ: ADM-01 disable → `revokeAllUserSessions` thu hồi mọi phiên remember ngay.
- **Thu hồi tức thì:** `disabled` / đổi vai trò / đổi mật khẩu → `sessions.deleteMany({user_id})` + xoá cache → request kế tiếp 401. (Lý do không JWT.)
- TOTP `otp` 13.5.0 (RFC 6238, 6 số/30s), secret mã hoá AES-256-GCM bằng `FIELD_KEY`; **bắt buộc** với KTT/PGĐ/GĐ/Chairman/Admin; 10 recovery codes dùng 1 lần.
- **Hành động nhạy cảm** (`approval:act`, `report:export`, `hr:disable`, internal transfer, đổi `min_balance`): dialog yêu cầu **mật khẩu hoặc OTP**, server verify lại trước khi CAS — không step-up token riêng (ADR-14).
- Chống dò: rate-limit `@fastify/rate-limit` (Redis không cần — store in-memory OK vì 1 instance) 5/giờ/IP+email, khoá 15 phút sau 8 lần, thông điệp luôn "Email hoặc mật khẩu không đúng".
- **Không có self-signup** (K-18); invite bằng email (`/kich-hoat` token 7 ngày, one-time).
- SSO/OIDC: **chưa**, chừa interface `verify()`; khi cần (Profile O + AD công ty) mở ADR mới.

### 7.3 Ghi dữ liệu an toàn khi **không có transaction**

Thứ tự cứng cho mọi mutation quan trọng:

```text
1. validate (perms, ngưỡng tiền, bằng chứng bắt buộc, version/If-Match)
2. CAS MỘT document: { status, approval.steps[i], history:[...push audit entry], version+1, updated_at }
   └─ matchedCount 0 → 409, không có side effect nào đã xảy ra
3. best-effort (sau khi commit, await nhưng swallow error + ghi jobs):
     mirror → audit_log · cập nhật balances_daily (CAS theo doc ngày) · notification/email
4. nếu bước 3 fail → jobs 'reconcile' chạy lại (idempotent theo request_id)
```

Vì **bước quyết định nằm trong 1 document**, không có trạng thái "phiếu đã duyệt mà audit chưa ghi". `history[]` là bằng chứng; `audit_log` có thể rebuild từ `history` bằng `pnpm db:rebuild-audit`.

### 7.4 Audit (blueprint §XIX)

- `document.history[]`: `{ at, actor:{user_id, role}, action, from, to, amount_at_decision, opinion, reason, request_id, ip }` — **chỉ thêm**, không có API sửa.
- `audit_log` (feed cross-document, cho ADM-12/DOC-01 tab Audit): `{ at, actor, action, subject:{type,id,code}, company_id, diff_fields, request_id }`. Insert-only ở tầng app + DB user **không có** `update/remove`.
- **Không** hash-chain / signed checkpoint (ADR-12) — nếu sau này cần bằng chứng chống sửa cho thanh tra → §20 trigger; phương án hash-chain đã thiết kế ở bản 2.0.0 (xem git history), bật lại mất ~2 ngày.
- Giữ ≥ 5 năm; không TTL. Khi M0 cận trần → archive hồ sơ đã đóng sang R2 (§8.7).
- **Không log**: mật khẩu, OTP, token, số TK NH đầy đủ, MST, email người khác (`pino.redact` cố định + test snapshot).

### 7.5 Đa công ty

`tenantScope` đặt `companyIds` vào `AsyncLocalStorage`; **mọi** helper query tự thêm `{ company_id: { $in: scope } }` (cấm `Model.find(` ngoài `lib/mongo.ts` — lint). Aggregate toàn tập đoàn = cộng từ từng công ty, không "cộng ngầm". Test chống rò: `leak.test.ts` dùng user công ty A gọi mọi endpoint với `company_id=B` → phải rỗng/403, chặn merge.

---

## 8. Dữ liệu MongoDB

### 8.1 Collections (16)

```text
companies departments users assignments sessions delegations approval_matrix
documents attachments budgets budget_lines bank_accounts bank_transactions
debt_items loans alerts notifications audit_log jobs settings
```
Gộp chủ đích: **một** `documents` cho mọi loại phiếu (`kind: spend|income|rollover|internal`); `debt_items` cho phải thu + phải trả; `alerts` chứa cả rule lẫn event (`type`); `attachments` chỉ là **mirror metadata** để query nhanh — bản nhúng trong `documents.attachments[]` mới là nguồn sự thật (không cần atomic 2 collection).

### 8.2 `documents`

```js
{ _id, code:"PC-2026-00123", kind:"spend", company_id, department_id, created_by,
  status:"pending.gd", version:12,                 // → If-Match, dùng cho CAS
  title, purpose, category_id,
  payee:{ name, tax_code, counterparty_id, is_internal },
  amount:{ minor: Long("2500000000"), currency:"VND", decimals:0 },
  fx:{ rate:"26310.50", at } | null,
  source:{ fund:"bank"|"cash", account_id, group_account_id, group_managed },   // §VIII
  planned_date, business_date, priority, contract:{ code, value }, loan_id,
  budget:{ budget_id, line_id, in_plan },
  approval:{ matrix_id, matrix_version,
    steps:[{ order, role, user_id, delegated_from, state:'done|current|waiting',
             action, decided_at, opinion, sla_deadline, amount_at_decision }] },
  evidence:{ required:['contract','invoice','acceptance'], present:[…], missing:[…] },
  attachments:[{ id, type, version, key, sha256, size, mime, added_at, added_by, referenced_by:[] }],
  execution:{ paid_at, bank_ref, executed_by, actual_amount_minor },
  override:{ fast_tracked:false, reason:null },
  history:[ …mục 7.4… ],                            // ★ audit nhúng, chỉ thêm
  created_at, updated_at, closed_at, archived_at }
```
`history[]` và `attachments[]` có trần mềm **1000 phần tử** (guard trong service); thực tế mỗi phiếu ≤ 60. Document < 200 KB → an toàn với ngưỡng 16 MB.

### 8.3 Chỉ số & tổng hợp — **tính khi đọc, cache khi cần**

| Nhu cầu | Cách làm (không read model phức tạp) |
| --- | --- |
| Badge "chờ tôi duyệt" | `countDocuments({'approval.steps':{$elemMatch:{user_id, state:'current'}}})` + covering index; **cache in-memory 60s per user** |
| `GET /v1/dashboard/overview` | 1 endpoint gộp (4 số dư + thu/chi hôm nay + chờ duyệt + đáo hạn + quá hạn), mỗi mục 1 query có index, chạy `Promise.all` |
| Dòng tiền theo ngày / forecast | `balances_daily { company_id, account_id, date, opening, planned_in, planned_out, closing, min_balance, breach }` — **CAS theo doc ngày** khi submit/payment/import sao kê; `forecast` đọc từ collection này; rebuild = `pnpm db:rebuild-balances` (idempotent) |
| Đáo hạn 4 bucket (RENEW-01) | query `loans` index `{company_id:1,next_due_date:1}` + group theo `days_to_due` (vài trăm doc) |
| Công nợ aging | aggregation trên `debt_items` (vài nghìn doc) |
| Báo cáo | aggregation trực tiếp `documents` với index + `$match` **trước** `$group`; > 3s → chạy như `jobs`, trả qua export |

Chỉ khi **đo thấy chậm** mới thêm lớp cache/read model (§20).

### 8.3.1 Cache HTTP — **TẮT toàn hệ thống** (no-store)

Mọi response `ok(...)` đều gắn `Cache-Control: private, no-store`; client `fetch` cũng đặt `cache: 'no-store'`. **Không** dùng `max-age`/`ETag`/304 cho API nữa: browser/proxy không được giữ số liệu tài chính, để mọi màn hình đọc tươi ngay sau thao tác (tạo/sửa/xoá) — tránh UI kẹt dữ liệu cũ. Các option `maxAge`/`etag`/`staleWhileRevalidate` trong `OkOptions` chỉ còn để tương thích, không có tác dụng.

Bù lại hiệu năng, vẫn giữ **cache in-memory TTL 60s** (K-6) cho session/badge/dashboard — cache này **vô hiệu hoá sau mutation** (`cacheInvalidate`) nên không gây stale. Trần CPU 0.1 nhân: "tính khi đọc" dựa vào index + `Promise.all`, không dựa vào HTTP cache.

### 8.4 Index (tập trung ở `db/indexes.js`, apply bằng script)

```js
documents: {company_id:1,kind:1,status:1,planned_date:-1} · {company_id:1,created_at:-1}
  {'approval.steps.user_id':1,'approval.steps.state':1} · {code:1} unique
  {company_id:1,'contract.code':1} · {status:1,'approval.steps.sla_deadline':1}
  {closed_at:1,archived_at:1}                                   // archive
balances_daily:{company_id:1,account_id:1,date:-1} unique   ·   bank_transactions:{account_id:1,value_date:-1,ref:1} unique  // chặn import trùng
audit_log:{company_id:1,at:-1} {actor.user_id:1,at:-1}      ·   loans:{company_id:1,next_due_date:1}
debt_items:{company_id:1,kind:1,due_date:1}                 ·   jobs:{state:1,run_at:1} {dedupe_key:1} unique
sessions:{user_id:1} {expires_at:1}(TTL)                    ·   notifications:{user_id:1,read_at:1,created_at:-1}
```
+ JSON Schema validator ở mức collection cho `amount` (bắt buộc `minor` là long, `currency` 3 ký tự) → chặn dữ liệu rác từ import Excel. **Số index bị giới hạn** vì trần 512 MB — mỗi index mới phải có lý do + `EXPLAIN` đính kèm PR.

### 8.5 Tiền — quy tắc cứng

| Chủ đề | Chuẩn |
| --- | --- |
| Lưu | `{ minor: Long, currency, decimals }`. VND `decimals:0`; USD/EUR/JPY theo `currencies.ts` |
| Tính | backend `BigInt` qua `add/sum/compare/percent` (`shared/money`); **cấm** `+` trên amount, cấm `Number()`, cấm `parseFloat` từ DB |
| Tỷ giá | snapshot `fx.rate` + `fx.at` tại ngày phiếu; tổng hợp dùng `rate_at(business_date)`; không tự quy đổi khi lưu |
| Làm tròn | chỉ ở tầng hiển thị; aggregate luôn trên minor units |
| Wire | string |
| Đối chiếu | task đêm `check:tie`: Σ `bank_transactions` vs Σ `execution.actual_amount` vs `balances_daily` → lệch thì tạo **alert danger + khoá export + thông báo KTT**, **không tự sửa** |
| `Decimal128` | chỉ cho `rate`/`percent`, không dùng cho tiền |

### 8.6 Kết nối & nhất quán

```ts
mongoose.connect(env.MONGODB_URI, {
  maxPoolSize: 10, serverSelectionTimeoutMS: 8_000, socketTimeoutMS: 20_000,
  retryWrites: true, writeConcern: { w: 'majority' },   // Atlas lo replica, app không cần tx
});
```
- **Không `session/transaction`** trong code nghiệp vụ — lint `fg/no-db-transaction` chặn.
- Thứ tự "ghi file trước, ghi metadata sau" (§6) thay cho 2-phase; file mồ côi do `cleanup` dọn sau 7 ngày (kê khai trong runbook: R2 có thể có file mồ côi, không phải lỗi mất dữ liệu).
- `jobs` unique `dedupe_key` thay cho distributed lock.
- Profile O (self-host) có transaction thì **vẫn không dùng** — giữ một đường code duy nhất, tránh "chạy trên cloud lỗi, trên on-prem đúng".

### 8.7 Sống với trần 512 MB

| Biện pháp | Chi tiết |
| --- | --- |
| Archive | task tháng: hồ sơ `closed_at < now-24 tháng` → xuất NDJSON sang R2 `archive/{company}/{yyyy-mm}.ndjson`, set `archived_at`, `$unset` `history` dư thừa (giữ `summary`), xoá doc gốc **chỉ sau khi** verify file archive `sha256` + `HeadObject` OK. Query history đọc qua `GET /v1/documents/{id}?archived=true` (đọc từ R2, hiện nhãn "hồ sơ lưu trữ") |
| Projection | mọi list API trả field cần thiết cho `FgTable`, **không** trả `purpose`, `history[]`, `attachments[]` |
| Dung lượng | `GET /v1/admin/db-stats` (usage, top collections, số index) — hiện trong ADM-13 |
| Cảnh báo | task nightly ghi `alert` khi DB > 60% / 80% trần |
| Khi nào hết cách | → upgrade Atlas (M2/M10) **không đổi code**, hoặc chuyển Profile O. §20 |

---

## 9. Engine phê duyệt · decision-pack · bản tin

### 9.1 State machine (1 chỗ duy nhất: `domain/workflow`)

```text
draft → pending.ktt → pending.pgd → pending.gd → pending.chairman
             ↓ changes_requested (resubmit → quay lại node đầu)
             ↓ rejected · cancelled · expired
                                      payment_queued → paid
```
11 status key **đúng literal** DS §3.1, đọc từ `shared/status/registry` (UI + API + Excel + email cùng nguồn).
`POST /api/v1/documents/{id}/transition { action, opinion?, otp?, reason?, if_match, request_id }`

`transition()` — thứ tự BẮT BUỘC:
1. session + `approval:act` → 2. verify OTP/mật khẩu lại → 3. node `current` đúng user (hoặc `delegation` đang hiệu lực) → 4. `amount ≤ assignment.amount_limit_minor` — sai thì **nêu hạn mức trong detail** (`FG-RBAC-012`) → 5. `evidence.missing` rỗng (trừ `approval:override` + `reason` bắt buộc) → 6. **CAS update document** (status + step + `history[]` + `version++`) → 7. mirror `audit_log` + `notifications` + `balances_daily` (best-effort, reconcile nếu fail) → 8. email người kế tiếp (không await).

- **Ma trận duyệt là dữ liệu** (`approval_matrix`), resolve lúc `submit` và **snapshot `matrix_version` + `steps` vào phiếu** → đổi cấu hình ADM-04 không làm lệch hồ sơ đang đi dở.
- Fast-track (§IV.201): `action='approve_with_reason'`, `reason` bắt buộc, chip "duyệt trước" trên `FgApprovalTimeline`.
- User `disabled` đang giữ node `current` → `409 FG-HR-003` + buộc chỉ định người thay (§XXIX.5).
- SLA: `sla_deadline = previous + sla_hours` trừ ngày nghỉ (`Company.working_calendar`); task `sla-scan` mỗi 15 phút (GH Actions) → nhắc + escalate; dedupe `key = doc_id+step+threshold`.
- Ủy quyền (APPR-04): resolve khi evaluate owner; `history` ghi cả `delegated_from`.
- Chi định kỳ (§XVII): task `recurring-materialize` 00:05 tạo phiếu nháp + nhắc 7/3/1 ngày.

### 9.2 Decision-pack — 7 câu hỏi §XXVII

`GET /v1/documents/{id}/decision-pack` trả **server-computed**: `payee · amount(+USD) · purpose+contract · evidence(required/present/missing) · source(account masked, group_managed) · impact(available_now, balance_after, min_balance, breach) · plan(budget, used/limit, percent, period)`.
→ `DOC-01 tab Tóm tắt` + `OVL-02`. **Zero** logic tiền/ngân sách ở FE.

### 9.3 Báo cáo & bản tin

| Loại | Cách |
| --- | --- |
| 14 preset báo cáo | 1 route + 1 zod schema + 1 aggregation + 1 `columns()` dùng `FgTable`/`FgCashFlowTable`/`FgMaturityTable` |
| Excel | `exceljs` stream (`report:export` check **server-side**), watermark "Xuất bởi {user} · {time} · {company}", limit 50k dòng → CSV |
| PDF / bản in | route `/in/ban-tin/:date`, `/in/ho-so/:id`, `/in/bao-cao/:preset` — HTML + print CSS (DS §13.5 P4), user `Ctrl+P` / "In" trên Chrome. **Không** render service |
| Bản tin 06:30 | GH Actions cron `23:30 UTC` → `POST /v1/tasks/newsletter` (header `x-task-token`) → dựng `settings` doc `newsletter:{date}:{company}` + email link `/ban-tin/ngay?date=` cho GĐ/PGĐ/KTT. Chạy muộn do instance ngủ **không sao**: task cũng tự rebuild khi có người mở `/ban-tin` mà cache thiếu ("tính khi đọc") |

### 9.4 Cảnh báo & notification (§XVIII)

`alerts` 1 collection (`type:'rule'|'event'`, dedupe `key = rule_id+subject+period`). Đánh giá: (a) inline sau mutation liên quan, (b) task `alerts-evaluate` mỗi 5–15 phút. UI đọc `notifications` + `unread-count` qua poll 30s. Email **chỉ** cho `severity=danger` + nhắc SLA + invite/reset; quiet hours 22:00–06:00 cho non-danger (giờ VN). SMTP công ty qua `nodemailer` (verify `SMTP_URL` ở §19.2 — đây là thứ hay thiếu nhất khi deploy free).

---

## 10. API

`/api/v1` · REST · resource số nhiều · cursor pagination cho danh sách, offset cho báo cáo · `problem+json` · money string · ngày nghiệp vụ `YYYY-MM-DD` (giờ VN) ≠ `*_at` UTC · `If-Match` (version) cho CAS hồ sơ · version trong path, giữ `/v1` ≥ 6 tháng khi breaking change.

```http
POST /v1/auth/login · /v1/auth/2fa · /v1/auth/logout · POST /v1/auth/password-reset · POST /v1/activate
GET  /v1/me · /v1/me/entitlements · /v1/companies
GET  /v1/dashboard/overview?scope=            # compound (no-store)
GET  /v1/queue · /v1/queue/processed · /v1/needs-attention
GET|POST /v1/documents · GET|PATCH /v1/documents/{id}
POST /v1/documents/{id}/transition            # submit|approve|reject|changes_requested|fast_track|pay|cancel
POST /v1/documents/{id}/opinions
GET  /v1/documents/{id}/decision-pack · /v1/documents/{id}/history
POST /v1/documents/{id}/attachments:prepare · :confirm
GET|POST /v1/delegations
GET  /v1/bank-accounts · /v1/bank-accounts/{id}/transactions · POST .../statement-import
POST /v1/internal-transfers
GET  /v1/loans · /v1/rollovers?bucket=today|3d|7d|30d
GET  /v1/debts?kind=receivable|payable · /v1/cashflow/forecast?horizon=30|90
GET  /v1/reports/{preset} · POST /v1/exports · GET /v1/exports/{job_id}
GET  /v1/newsletter/daily?date= · /v1/alerts · PATCH /v1/alerts/{id}/ack
GET|POST /v1/notifications · GET /v1/notifications/unread-count
GET|POST /v1/personnel · /v1/personnel/invite · /v1/personnel/{id}/invite-link (GET|POST|DELETE — link kích hoạt/đổi mật khẩu) · /v1/personnel/{id}/deactivate|transfer|resend
GET|POST /v1/admin/{matrix,categories,budgets,companies,settings,db-stats} · GET /v1/audit-log
GET  /v1/search?q=                            POST /v1/tasks/:name (server-to-GH-Actions only)
GET  /api/v1/openapi.json
```

**API-first giữ ở mức hợp đồng** (OpenAPI + version + money string + CAS + perms), chưa dựng webhook/HMAC cho ERP-ngân hàng-hoá đơn (blueprint §XXV là định hướng kỳ sau). Import sao kê + đối chiếu bằng **file CSV/Excel** — đủ dùng và không cần tích hợp.

---

## 11. Bảo mật (app nằm trên internet, phải nghiêm túc hơn bản on-prem)

| Yêu cầu §XXVI | Hiện thực |
| --- | --- |
| HTTPS | Render auto TLS (+ HSTS ở Cloudflare); **bắt buộc** custom domain để cookie/domain-based protection có nghĩa |
| Lớp cổng trước login | **Cloudflare Access free (≤50 user)**: chính sách theo email công ty + optional device/certificate; hoặc IP allowlist. Đây là lớp giảm 99% scanner, chi phí 0 (K-19) |
| RBAC + theo công ty + chức danh + khoản tiền | `Assignment.{role, company_id, amount_limit_minor, scope_all}` — check ở §9.1 (4) |
| 2FA quản trị | TOTP bắt buộc + recovery codes + re-verify OTP/mật khẩu cho hành động nhạy cảm (§7.2) |
| Audit | `history[]` nhúng + `audit_log` insert-only; DB user Atlas chỉ có CRUD nghiệp vụ, **không** drop collection; app không có API sửa audit |
| Không cho tải sai quyền | entitlement per cột; `report:export` check server; presigned GET 60s **cấp sau khi** check quyền từng lần; không có bucket public |
| Phiên | **ADR-19**: mặc định ghi nhớ, hạn cuộn 400 ngày (trần trình duyệt) — hoạt động định kỳ = không hết phiên; bỏ chọn → idle 15', absolute 8h. Thu hồi tức thì khi disable / đổi vai trò / đổi mật khẩu / ADM-13 |
| Mã hoá | TLS in-transit; at-rest do Atlas/R2; app-level AES-256-GCM cho `totp_secret`; mask số TK NH/MST khi không có `bank:read`/`doc:read` |
| Anti-XSS/CSRF/injection | CSP `default-src 'self'; frame-ancestors 'none'` (CORS không cần vì same-origin) · `SameSite=Lax` + check `Origin` cho mutation · zod `.strict()` · render text (không HTML) · ODM chặn injection |
| Rate limit | login/export/invite/tasks; `@fastify/rate-limit` in-memory (1 instance) |
| Secret | env trong Render dashboard + `.env.example`; `SESSION_SECRET` ≥ 32B, `FIELD_KEY` 32B hex, `TASK_TOKEN` random; rotate = deploy lại + revoke mọi session |
| Dependency | `pnpm audit --prod` chặn high trong CI; Renovate monthly; `NOTICE.md` liệt kê license (MongoDB SSPL cho Profile O — chỉ chạy server, không bán DB-as-a-service) |
| Tuân thủ | NĐ 13/2023 (bảo vệ dữ liệu cá nhân): tối thiểu hoá trường, chỉ purpose nội bộ, không tự đăng ký, không cho export hàng loạt email/SĐT; **dữ liệu demo/UAT phải là dữ liệu ẩn danh** (§19.2) |
| **Cấm** | đưa **số liệu tiền thật của công ty** lên Atlas M0/R2 free khi chưa có văn bản đồng ý của Ban lãnh đạo (§19.2 BA-0) |

---

## 12. Triển khai

### 12.1 Hồ sơ dịch vụ cần có (15 phút, miễn phí)

| Dịch vụ | Để làm gì | Ghi chú |
| --- | --- | --- |
| Render account | Web Service free | linked repo, autodeploy `main` |
| MongoDB Atlas M0 | DB | cùng region gần VN (Singapore) để giảm latency |
| Cloudflare (R2 + Access + DNS) | lưu chứng từ + cổng truy cập | bật versioning-like bằng key theo version; bucket private |
| GitHub | repo + Actions (cron + backup + CI) | secrets: `MONGODB_URI`, `R2_*`, `TASK_TOKEN` |
| SMTP công ty | email invite/OTP/bản tin | test `pnpm mail:test` |
| Custom domain | cookie Secure + Cloudflare Access | `fingate.<domain>` |

### 12.2 `render.yaml` (Blueprint — khai báo toàn bộ hạ tầng)

```yaml
services:
  - type: web
    name: fingate
    runtime: node                     # ★ không dùng Docker ở bậc free
    plan: free                        # hoặc starter $7/tháng (xem §12.6)
    region: singapore
    rootDir: .
    buildCommand: pnpm install --frozen-lockfile && pnpm -r build
    preDeployCommand: pnpm db:migrate && pnpm db:indexes   # chạy ở 1 instance, trước khi swap
    startCommand: node apps/api/dist/server.js
    healthCheckPath: /healthz
    autoDeploy: true
    envVars:
      - { key: NODE_ENV, value: production }
      - { key: TZ, value: UTC }                    # Render là UTC; "ngày VN" tính tường minh
      - { key: MONGODB_URI, sync: false }
      - { key: SESSION_SECRET, generateValue: uuid }
      - { key: FIELD_KEY, sync: false }
      - { key: STORAGE_DRIVER, value: s3 }
      - { key: R2_ACCOUNT_ID, sync: false } { key: R2_ACCESS_KEY_ID, sync: false }
      - { key: R2_SECRET_ACCESS_KEY, sync: false } { key: R2_BUCKET, value: fingate-docs }
      - { key: SMTP_URL, sync: false } { key: MAIL_FROM, value: fingate@company.com }
      - { key: TASK_TOKEN, sync: false } { key: PUBLIC_URL, value: https://fingate.company.com }
```
Cấu hình dev local: `pnpm infra:up` (compose: chỉ `mongo` single-node RS) + `.env` với `STORAGE_DRIVER=fs`. Không cần Render sandbox để phát triển.

### 12.3 Job nền (thay cho cron trong tiến trình)

```yaml
# .github/workflows/tasks.yml
on:
  schedule:                       # GitHub chạy UTC — giờ VN = UTC+7
    - cron: '30 23 * * *'         # 06:30 VN — bản tin + kiểm tra đầu ngày
    - cron: '*/15 * * * *'        # SLA scan + alerts-evaluate
    - cron: '5 17 * * *'          # 00:05 VN — recurring materialize
    - cron: '40 18 * * 0'         # CN 01:40 VN — rebuild-balances + check:tie + archive
jobs:
  task:
    runs-on: ubuntu-latest
    strategy: { matrix: { name: [newsletter, sla-scan, alerts, recurring, maintenance] } }
    steps:
      - run: curl -fsS -X POST https://fingate.company.com/api/v1/tasks/${{ matrix.name }}
               -H "x-task-token: ${{ secrets.TASK_TOKEN }}"
```
Endpoint `/tasks/:name`: check `x-task-token` (constant-time), `rate-limit` 10/giờ, **idempotent** theo `dedupe_key` trong `jobs`, trả `202` ngay và làm tiếp trong background (timeout 30s của proxy) → log kết quả.
Đồng thời `tasks.yml` (mọi 10 phút, job `keep-warm`) gọi `/healthz` → **giảm hẳn cold start** với chi phí 0. Nếu Render không cho phép hành vi này trên free → chấp nhận cold start (§12.5) hoặc trả $7/tháng.

### 12.4 Deploy & rollback
Push `main` → Render build (≈3–5 phút) → `preDeployCommand` migrate → swap. Rollback = Revert commit (Render redeploy) — migration **bắt buộc** tương thích lùi (thêm trước, bỏ sau). Manual release: `gh workflow run` hoặc nút Redeploy. Không cần registry image cho Profile C.

### 12.5 Cold start — chấp nhận hay trả tiền?

| Phương án | Chi phí | Hệ quả |
| --- | --- | --- |
| A. Keep-warm ping (mặc định) | $0 | hết ngủ trong giờ làm; vẫn có thể ngủ ngoài giờ → lần đầu buổi sáng chờ ~30s |
| B. UX chịu lạnh (§5) | $0 | skeleton + "đang thức dậy" + retry GET; đủ cho dùng nội bộ |
| C. Render `starter` $7/tháng | ~170k đ/tháng | **không ngủ**, có Docker, 256–512 MB nhanh hơn, hỗ trợ persistent disk → **khuyến nghị nếu dùng thật** |
| D. VPS Always-Free (Oracle ARM) hoặc VPS ~$5 | $0–10 | chạy Profile O: `compose.yml` (Mongo RS 1 node **có transaction**, đĩa bền, `cron` hệ thống) — **đây là phương án tốt nhất về kỹ thuật nếu muốn free thật sự** |

→ **Kiến trúc không đổi trong cả 4 phương án.** Chỉ đổi `plan`, `STORAGE_DRIVER`, `MONGODB_URI`. Đó là lý do K-4/K-7/K-8 tồn tại.

### 12.6 Profile O (on-prem / VPS) — `deploy/`
`compose.yml`: service `mongo` (`--replSet rs0`, mặc định) + `fingate` (profile `onprem`) + `caddy` (profile `tls`); `Dockerfile` multi-stage (build pnpm → runtime node:24-slim, chỉ prodDeps của `@fingate/api`, uid 10001); `Caddyfile` TLS/Let's Encrypt; `STORAGE_DRIVER=fs` → volume `fingate-uploads` (`UPLOAD_DIR=/data/uploads`); job nền bằng **cron hệ thống** gọi `/api/v1/tasks/:name` (không có cron trong tiến trình — K-7); `backup.sh` (`mongodump` gzip, giữ 14 bản). Chi tiết từng bước: `docs/runbook.md` §7.2–7.3.
Profile O bật lại được **transaction** nhưng code vẫn đi đường CAS → thống nhất, không phân nhánh.
> Dev trên host vẫn dùng `?replicaSet=rs0`; app trong container dùng `?directConnection=true`
> vì member của RS quảng bá `localhost:27017`.

---

## 13. Backup & phục hồi (không có backup = không có hệ thống)

| Việc | Cách | Lịch |
| --- | --- | --- |
| Dump DB | GH Actions `backup.yml`: `mongodump --uri=$MONGODB_URI --gzip` (~vài trăm MB) → `aws s3 cp` lên **bucket R2 riêng** `fingate-backup` (private) | nightly |
| Dump 0 | copy ra 1 nơi ngoài Cloudflare (Google Drive/OneDrive công ty hoặc NAS) | weekly |
| Chứng từ | R2: bật **Object Lock/retention** nếu nhà cung cấp cho, hoặc replicate sang bucket thứ 2; Profile O: rsync incremental mỗi 6 giờ | liên tục/ngày |
| Restore drill | `pnpm db:restore --from=<date>` vào DB tạm (Atlas M0 thứ 2 hoặc local) + `check:tie` + mở 5 hồ sơ ngẫu nhiên | **mỗi quý**, ghi kết quả vào runbook |
| Retention | 14 nightly · 8 weekly · 12 monthly ( nén ≈ 60–120 MB/lần → không tốn nhiều free storage) | |

**RPO ≤ 24h · RTO ≤ 4h** cho Profile C (đủ cho pilot/demo; phải ký xác nhận — §19.2 BA-7). Profile O với PITR/snapshot có thể đạt RPO 15'.
Sự cố & cách xử lý (runbook): Render build fail (xoá cache `--frozen-lockfile`, check RAM build) · Atlas M0 **bị pause** (unpause trong 1–2 phút, thêm keep-warm) · `ReadUnauthorized`/IP allowlist Atlas (thêm `0.0.0.0/0` **không** được phép — dùng VPC peering hoặc allowlist IP Render nếu Render công bố, hoặc chấp nhận TLS + DB user mạnh) · R2 403 (rotate key) · DB > 80% (chạy archive) · lệch tie (khoá export, báo KTT) · lộ `SESSION_SECRET` (rotate + revoke mọi session + đổi `TASK_TOKEN`).

---

## 14. Hiệu năng mục tiêu (trên 0.1 CPU — phải khiêm tốn)

| Chỉ số | Mục tiêu | Cách đạt |
| --- | --- | --- |
| `GET /v1/dashboard/overview` | p95 ≤ 1.5 s (ấm) | covering index + `Promise.all` + cache in-memory 60s |
| Danh sách 50 dòng | ≤ 500 ms | projection, cursor, không trả field dài |
| `POST /transition` | ≤ 700 ms | 1 CAS update, email/side-effect async |
| Báo cáo tháng × 5 công ty | ≤ 5 s | `$match` index trước `$group`; > 5 s → `jobs` |
| Export Excel 20k dòng | ≤ 30 s | stream, limit, hoặc job |
| Web initial load | ≤ 3 s (LAN/4G) | 1 bundle ≤ 350 KB gzip, font subset, lazy `report/`, `admin/` |
| Memory của process | ≤ 350 MB | `maxPoolSize 10`, không load cả collection, export stream, `--max-old-space-size=384` |

Quy tắc: mọi query có `company_id` + index · mọi list có `limit` + `projection` · `EXPLAIN` trong PR nếu thêm query mới · không aggregate lớn trên request path · bảng > 200 dòng dùng virtual scroll (`FgTable` DS §7.10) · API trả `no-store` (không cache HTTP, §8.3.1).

---

## 15. Kiểm thử

| Tầng | Tool | Phạm vi |
| --- | --- | --- |
| Unit | Vitest | `shared/money` (property test sum/round/FX), `status/registry`, `workflow/transition` (mọi cạnh), matrix resolver, forecast, calendar |
| API integration | Vitest + `app.inject()` + `mongodb-memory-server` | mọi route 200/403/409/422 · **`history[]` có bản ghi cho mọi mutation** · CAS conflict → 409 · idempotency theo `request_id` · upload prepare/confirm/validate · `reconcile` rebuild `audit_log` từ `history` |
| Frontend | Vitest + @testing-library/react | 8 trạng thái màn (DS §7.20), keyboard path, render `FgMoney`/`FgStatusChip` |
| E2E | Playwright (chromium + 1 mobile viewport) | 8 luồng vàng, seed cố định |
| Kiến trúc | script + ESLint | mọi route có `perms` · import direction (§4) · `fg/no-raw-number-format` · `fg/no-raw-color` · `fg/no-db-transaction` · `fg/no-raw-model-find` · route coverage theo screenId · redaction snapshot |

**8 luồng vàng:** (1) invite → email → kích hoạt → bật 2FA → `active` · (2) KT tạo phiếu thiếu chứng từ → chặn inline → bổ sung → submit · (3) KTT → PGĐ → GĐ (re-verify OTP) → `paid` → badge giảm sau ≤ 30s · (4) mở từ email trên iPhone → decision-pack đủ 7 mục → duyệt · (5) 2 người duyệt đồng thời → 409 → thông điệp đúng · (6) trả về bổ sung → resubmit → timeline giữ lịch sử · (7) đáo hạn hôm nay → hồ sơ đảo hạn → duyệt §XI · (8) báo cáo 13 + export Excel → tải → `history`/`audit_log` có `report.export`.

**Không làm:** load test đầy đủ (thay bằng `autocannon -c50 -d60` **một lần** trên Profile C để biết trần, ghi số vào runbook), mutation testing, visual regression tự động, coverage toàn bộ screens (≥ 85% `packages/shared` + `apps/api/src/domain`).
Vì CI chạy trên free tier: gộp 1 job, `pnpm -r test --changed`, cache `~/.pnpm-store` — **mục tiêu CI ≤ 6 phút**.

---

## 16. Quy ước code & DoD kỹ thuật

| Chủ đề | Chuẩn |
| --- | --- |
| Naming | screenId `DASH-01` ↔ `screens/dashboard/Dash01/` ↔ `data-screen` · DB `snake_case` · status literal đúng registry · `Fg{Noun}` (DS §13.2) · `*.service.ts` / `*.routes.ts` / `*.schema.ts` |
| Lỗi | `FG-<DOMAIN>-<###>` trong `shared/errors.ts`; message tiếng Việt thân thiện, không lộ stack |
| Ngày | `business_date` `YYYY-MM-DD` (Asia/Ho_Chi_Minh) ≠ `*_at` UTC; **mã** không được dùng `new Date().getDate()` suy ngày — dùng `vnDate()` trong `shared/money/date` |
| Tiền | chỉ qua `shared/money` |
| Env | một file `env.ts` zod, fail-fast; mọi giá trị khai trong `env.example` + `render.yaml` |
| Git | trunk-based, Conventional Commits, PR ≤ 400 dòng, 1 approve (2 approve cho `domain/workflow`, `entitlement`, `audit`, `storage`) |
| CI | `pnpm -r lint && typecheck && test && build` + `api:types` diff + `audit --prod` + kiến trúc script |
| Docs | `docs/adr/NNNN-*.md` · `docs/runbook.md` · README "chạy local ≤ 5 phút" · `CHANGELOG.md` |

**DoD kỹ thuật mỗi màn hình** (thêm DoD nghiệp vụ screens §23): đủ 8 trạng thái · route có `perms` + test 403 · mọi số qua formatter · deep-link từ email mở đúng hồ sơ · keyboard-only cho luồng duyệt · query `EXPLAIN` đạt index · **hành vi khi server ngủ/timeout được test** (mock 5s delay).

---

## 17. Lịch thi công (khớp DS §13.5 & screens §22)

| Phase | Việc kỹ thuật | Kiểm chứng |
| --- | --- | --- |
| **P0** (1–2 tuần) | bootstrap repo + workspace + lint + CI · `shared/status` `money` `errors` · `tokens.css`+`theme.ts` · 8 `Fg*` nền + `FgAppShell` · API khung (env, mongo, session, perms, problem+json, OpenAPI) · seed 400 phiếu | `pnpm dev` + deploy **lên Render free** ngay từ đầu (sớm phát hiện trần free tier); DASH-01 skeleton |
| **P1** (2–3 tuần) | AUTH-01/03/04/05/06 + TOTP · `workflow` + matrix + CAS + `history` · APPR-01 · CHI-01/02/03/04 · upload qua `StorageAdapter` + presign R2 · `FgTable/FilterBar/ApprovalTimeline/Opinion/DocList` | luồng vàng 1→3 pass E2E trên staging Render |
| **P2** (3–4 tuần) | DOC-01 + decision-pack · THU · BANK (TK, số dư, `balances_daily`, import sao kê CSV) · LOAN + RENEW 4 bucket · personnel §XXIX + Cloudflare Access · alerts | luồng 4→8; `check:tie` xanh |
| **P3** (2–3 tuần) | DEBT · CASH forecast · bản tin + `/in/*` · 14 báo cáo + Excel · search · PREF · DASH-02/05 · backup/restore drill | bản tin chạy 5 ngày liên tục không lỗi; 1 restore thành công có ghi log |
| **P4** | dark production · mobile polish · SSO/OIDC · tích hợp ERP/Ngân hàng thật · **quyết định đi Profile O hay trả phí tier** | tuỳ nhu cầu thật |

Team: **1 tech lead + 1 BE + 1 FE + 0.5 người vận hành/deploy + 1 BA kế toán**. P0–P2 ≈ 6–8 tuần → **102 màn hình là lớn**; phạm vi kỳ 1 phải được duyệt ở §19.2 BA-10.

---

## 18. ADR (mỗi cái 1 dòng)

| ID | Quyết định | Vì sao / đã loại gì |
| --- | --- | --- |
| ADR-01 | 1 service Fastify serve cả API + SPA, 1 process | `2 service + static site` (thêm CORS + cookie cross-site), `Next.js` (thừa SSR), `NestJS` (thừa DI), Docker ở cloud (free không hỗ trợ) |
| ADR-02 | MongoDB trên **Atlas M0 free** cho pilot, self-host Community cho production thật; cùng code qua `MONGODB_URI` | đổi DB = rewrite; ghi rõ hạn chế M0 ở §3.4 + cấm dữ liệu thật khi chưa duyệt (§11) |
| ADR-03 | **Không transaction — CAS 1 document** | M0 shared tier không hỗ trợ; thiết kế embedding biến nghiệp vụ thành 1 atomic write; loại `fallback if transaction available` (phân nhánh code) |
| ADR-04 | Audit nhúng `document.history[]`, `audit_log` là feed suy diễn được | không cần atomicity 2 collection (ADR-03); vẫn đáp ứng §XIX vì lịch sử là bất biến và rebuild được |
| ADR-05 | `StorageAdapter`: `s3` (R2/B2/S3) hoặc `fs` | filesystem ephemeral trên PaaS → **không** được ghi đĩa; S3 tự do trên bậc trả phí; GridFS (làm phình DB 512 MB) |
| ADR-06 | Job = `jobs` collection + **tính khi đọc/caching** + `/v1/tasks/:name` do GH Actions gọi | instance free ngủ → in-process cron không đáng tin; BullMQ cần Redis |
| ADR-07 | Realtime = poll 30s + focus refetch | SSE/WS cần kết nối sống lâu — trái mô hình instance ngủ |
| ADR-08 | Zod 4 là source of truth (FE + BE + OpenAPI + type) | `class-validator` 2 nguồn; viết tay schema thì lệch |
| ADR-09 | `status/registry` + `money` ở `packages/shared`; `shared/src/ui` re-export | API không phụ thuộc React; DS §12.5 giữ tên |
| ADR-10 | 1 collection `documents` cho mọi loại phiếu, `approval.steps` embed | tách 4 collection → 4 chỗ phải sửa + không CAS được 1 nhát |
| ADR-11 | Workflow là writer duy nhất của `status`; ma trận snapshot per phiếu | mỗi module tự update → mất lịch sử + race |
| ADR-12 | Không hash-chain audit (chỉ insert-only + app quyền hạn chế) | chưa có nhu cầu pháp lý; có trigger §20 để bật lại |
| ADR-13 | Tiền `Long` minor units + wire string + `BigInt` khi tính | float bị cấm; Decimal128 làm kiểu chính cồng kềnh |
| ADR-14 | Re-verify OTP/mật khẩu cho hành động nhạy cảm, không step-up token | đơn giản, đủ §XXIV |
| ADR-15 | Cloudflare Access + không self-signup | app tài chính phơi ra internet, chi phí 0 |
| ADR-16 | PDF = browser print; Excel = exceljs stream | render service (Playwright) không sống nổi với 0.1 CPU / 512 MB |
| ADR-17 | pnpm workspace, `pnpm -r`, không Turbo/Nx | 2 app + 1 package thì tooling thêm là nợ |
| ADR-18 | `render.yaml` + `deploy/compose.yml` = 2 hồ sơ khai báo duy nhất | không Terraform/Helm |
| ADR-19 | **Phiên mặc định "vĩnh viễn"**: ghi nhớ BẬT, hạn cuộn 400 ngày, không idle timeout | công cụ nội bộ dùng hằng ngày, người dùng chỉ là nhân sự được mời (ADR-15, không self-signup); rủi ro tiền thật do **step-up ADR-14** chặn tại `approve`/`pay`, không do TTL của cookie; 400 ngày là trần `Max-Age` của trình duyệt nên "dài nhất" = cuộn, không phải trần lớn hơn. Thu hồi vẫn tức thì qua ADM-13/ADM-01 |

---

## 19. Còn cần gì nữa?

### 19.1 Cần **nghiệp vụ** cung cấp (chặn code thật, không chặn P0)

| # | Cần gì | Ai | Chậm nhất |
| --- | --- | --- | --- |
| BA-0 | **Chấp nhận bằng văn bản**: pilot trên hạ tầng free (không transaction, 512 MB, không backup tự động) — hoặc chọn Profile O ngay. Kèm câu "dữ liệu thật chưa lên cloud free" | Ban lãnh đạo + IT | tuần 0 |
| BA-1 | Ma trận duyệt thực tế từng công ty (loại phiếu, ngưỡng, cấp bắt buộc, ai ký thay) — bản Excel để seed `approval_matrix` | TGĐ + KTT | đầu P1 |
| BA-2 | Hạn mức duyệt từng chức danh từng công ty + ngưỡng lên Chairman | TGĐ | đầu P1 |
| BA-3 | Danh mục khoản chi/thu (§VI) + chứng từ bắt buộc theo loại (Q-04) | Kế toán | đầu P1 |
| BA-4 | Ngưỡng `minBalance` per TK + ai đổi (Q-02) — đề xuất KTT, đổi phải audit | KTT | đầu P2 |
| BA-5 | Danh sách TK ngân hàng thật + định dạng sổ phụ đang dùng để import (Q-05) | Thủ quỹ | đầu P2 |
| BA-6 | Lịch nghỉ/lễ để tính SLA + forecast | HR | đầu P2 |
| BA-7 | Thời hạn lưu trữ hồ sơ/audit (đang để 5 năm) + RPO/RTO chấp nhận (đang 24h/4h) | Kế toán trưởng + BLĐ | trước go-live |
| BA-8 | Nguồn ngân sách: nhập tay/import Excel kỳ 1 hay chờ ERP (Q-06) | TGĐ + KTT | đầu P3 |
| BA-9 | Chốt 10 câu hỏi mở `03_screens.md` §24 + Phụ lục C của DS → ADR-19… | BA + Tech Lead + Design | trước P2 |
| BA-10 | **Phạm vi kỳ 1** + ngày UAT (102 màn là nhiều; chọn pilot 1–2 công ty trước) | Sponsor | tuần 0 |
| BA-11 | Ai UAT + kịch bản; quy trình ẩn danh hoá dữ liệu demo (mask tên đối tác, MST, số TK) | BA + KTT | trước P2 |
| BA-12 | Đào tạo 1 trang cho KT/KTT + video 3 phút cho GĐ duyệt trên điện thoại | BA | trước go-live |

### 19.2 Cần **quyết định hạ tầng** (trước P1)

1. Ai sở hữu tài khoản Render/Atlas/Cloudflare/GitHub? (đề xuất: **công ty**, không phải tài khoản cá nhân dev → tránh mất quyền khi nghỉ việc) + Bật 2FA cho mọi tài khoản hạ tầng.
2. Custom domain cho app + DNS do ai quản; chứng thư TLS (Render tự cấp hoặc qua Cloudflare).
3. **SMTP**: server mail + địa chỉ gửi + test tỉ lệ tới nơi (Gmail/Outlook công ty hay relay riêng). Email là kênh thông báo chính (K-13) → không có SMTP thì mất chức năng.
4. Có cho phép dữ liệu lên cloud free không (§11 "Cấm")? Nếu không → **Profile O / VPS Always-Free** (§12.5 D).
5. ngân sách thật: `0đ` (free + cold start) vs `~$7–17/tháng` (Render starter + Atlas M2) vs `~$5–10/tháng` (VPS + self-host Mongo, có transaction). Khuyến nghị của tài liệu: **demo/UAT = free, go-live = VPS Profile O**.
6. Chính sách truy cập từ bên ngoài (Cloudflare Access: ai được, thiết bị nào) + quy trình cấp/thu hồi khi nhân sự nghỉ (phối hợp §XXIX).
7. Trần chứng từ: 10 GB rất nhanh hết ở pilot (1.500 file/tháng). Quyết định: **nén/ảnh JPEG thay PDF**? cho phép 5 GB/tháng trả phí R2 (~$0.075/GB)? hay bắt buộc Profile O có đĩa lớn. **Đây là trần thực tế đầu tiên hệ thống gặp.**
8. Người vận hành: ai đọc log, ai restart, ai chạy restore quý → ghi vào `docs/runbook.md`.

### 19.3 Tài liệu/artefact còn thiếu

`docs/adr/01–18` (§18) · `docs/05_data_dictionary.md` (§8) · `docs/06_er_diagram.md` (Mermaid, 16 collection) · `docs/runbook.md` (cài mới · deploy · backup/restore · 8 sự cố §13) · `docs/07_uat_scripts.md` · `docs/08_permission_matrix.xlsx` · `NOTICE.md` (license, MongoDB SSPL cho Profile O).

### 19.4 Việc kỹ thuật tuần đầu

| # | Việc | 1 ngày? |
| --- | --- | --- |
| T-1 | Spike: **deploy "hello Fastify + static SPA" lên Render free + Atlas M0 + R2** — đo cold start, RAM, build time, presigned upload có chạy không | 1 |
| T-2 | Spike: mongoose 9 trên **M0** (không tx): test `findOneAndUpdate` CAS + `bulkWrite` ordered + `mongodb-memory-server` replSet trong CI | 0.5 |
| T-3 | Bootstrap repo + eslint 4 custom rule + CI 1 job + `render.yaml` | 1 |
| T-4 | `packages/shared`: status registry + money + errors + 3 contracts + tokens.css/theme.ts từ DS | 2 |
| T-5 | `FgButton/Text/Field/Input/Table/Money/StatusChip/AppShell` (+ Storybook MAY, hoặc `/dev/components`) | 4 |
| T-6 | `db/` models + indexes + seed 400 phiếu + `check:tie` + `rebuild-audit` | 1.5 |
| T-7 | API khung: session + perms + scope + problem+json + OpenAPI + `api:types` | 2 |
| T-8 | `domain/workflow` (CAS + history + mọi cạnh state machine có test) | 3 |
| T-9 | `StorageAdapter` (s3 + fs) + presign flow + `attachments` version/key scheme | 1.5 |
| T-10 | `tasks.yml` + `backup.yml` + restore drill đầu tiên trên staging | 1 |

### 19.5 Danh sách **đỏ** — những thứ không được "đơn giản hoá" tiếp

1. Tiền là số nguyên, string trên wire, tính phía server (§8.5).
2. Duyệt/`status` chỉ đổi được bằng 1 hàm, CAS, kèm `history[]` trong cùng document (§9.1, §7.3).
3. Mọi query có `company_id` + có test chống rò giữa công ty (§7.5).
4. Server check quyền cho **từng cột, từng hành động, từng file tải về** — UI ẩn chỉ là mỹ thuật (§11).
5. Chứng từ **chỉ thêm, không xoá**, có version, có `sha256` (§6).
6. `status/registry` + formatter là nguồn duy nhất cho API/UI/Excel/email (DS §3, §4).
7. Ma trận duyệt snapshot vào phiếu → lịch sử không đổi khi đổi cấu hình (§9.1).
8. Re-verify OTP/mật khẩu khi duyệt hoặc xuất dữ liệu tài chính (§7.2).
9. `check:tie` hằng đêm, lệch thì **khoá export và báo người**, không tự sửa (§8.5).
10. Backup nightly **có test restore mỗi quý**; chưa test restore = chưa có backup (§13).

---

## 20. Khi nào kiến trúc này "hết cỡ" (trigger nâng cấp)

| Dấu hiệu **đo được** | Việc phải làm | Chi phí |
| --- | --- | --- |
| Cold start > 3 lần/tuần bị người dùng phàn nàn | `plan: starter` hoặc VPS Profile O | $7/tháng |
| Atlas M0 > 80% 512 MB | chạy archive; nếu vẫn thiếu → M2/M10 hoặc self-host | $0–20 |
| Trần R2 10 GB vượt | trả phí theo GB, NAS/đĩa, hoặc chuyển Profile O | $1–15/tháng |
| Cần dữ liệu thật + audit chống sửa | Profile O + bật hash-chain (ADR-12 → 12b) | 2 ngày code |
| p95 `transition` > 1.5 s, hoặc Mongo CPU > 70% | thêm index / cache read model thật; 2 instance → **bắt buộc** Redis cho session + cache + cron ra worker riêng | trung bình |
| > 100 người dùng đồng thời / báo cáo > 5 s | dedicated cluster + read model + (tuỳ chọn) Atlas Search | trung bình |
| Cần SSO công ty (Entra ID/ADFS) | thêm OIDC vào interface `verify()` đã chừa | 3–5 ngày |
| Cần duyệt ngoài internet không qua VPN/Access | review bảo mật lại §11, bật WebAuthn, có thể cần pentest | lớn |
| Mở cho công ty thứ 3 ngoài tập đoàn | đó là **SaaS multi-tenant** → ADR mới, tách tenant, hợp đồng, ISO 27001 | rất lớn |

---

## 21. Đối chiếu với tài liệu trước

| Chỗ | Trạng thái |
| --- | --- |
| DS §12.3 "Ant Design **v5** ThemeConfig" | **cần sửa → antd 6.6.4**: giữ bảng token, thêm `cssVar`, dùng `darkAlgorithm`, kiểm tra key `components.Table.*` (v6 đổi tên vài khoá) |
| DS §12.5 `packages/ui/src/{status,format}` | **sửa thành `packages/shared/src/{status,money}`**, `shared/src/ui` re-export (ADR-09) |
| DS §12.2 Tailwind | **MAY** — token là CSS var nên không bắt buộc; nếu đội quen Tailwind thì cài thêm, không ảnh hưởng kiến trúc |
| DS §13.5 P4 "print/Excel stylesheet" | Đạt: `/in/*` + print CSS (§9.3) |
| DS Phụ lục C #5 (mobile dùng chung token) | Đạt: `tokens.css` là nguồn; cần app native thì thêm script xuất `tokens.json` |
| Screens §24 Q-01→Q-10 | **chưa trả lời** → BA-9, chặn P2 |
| Screens §19 mobile push (Q-10) | **đổi**: email + responsive web kỳ 1 (K-13). Cần BLĐ xác nhận: badge "chờ tôi duyệt" trên điện thoại cập nhật chậm tới 30–60s và **app có thể cần chờ ~30s ở lần mở đầu tiên** (§12.5) |
| Blueprint §XXIV "OTP/PIN/Face ID khi duyệt" | Đạt: OTP + re-verify mật khẩu (§7.2). Face ID → chỉ có nếu làm app native (out of scope) |
| Blueprint §XXV API-first | Đạt ở mức hợp đồng (OpenAPI, version, money string, CAS); tích hợp ERP/NH để P4 |
| Blueprint §XXVI bảo mật | Đạt, thêm lớp Cloudflare Access (§11); mục cần pháp chế: BA-7 |
| Blueprint §XXIX nhân sự | Đạt: invite email → auto-gán công ty → `disabled` không xoá → chặn reassign → thu hồi session tức thì (§7.1) |
| Blueprint XXX dữ liệu phiếu | Đạt: §8.2; `evidence.required` cấu hình được (BA-3); `code` bất biến sau submit |
| Bản 2.0.0 (trước đây) | Bỏ: Redis, BullMQ, MinIO/S3-tự-dựng, NestJS, OTel/Sentry/Grafana, Playwright render, SSE, hash-chain audit, K8s/Helm, `readmodel_*`. Thêm: CAS, `history[]`-as-audit, presigned R2, GH Actions cron/backup, Cloudflare Access, `render.yaml` |

---

## 22. Phê duyệt

| Vai trò | Cần gật đầu | Ký |
| --- | --- | --- |
| Tech Lead / CTO | §2.1 (20 quyết định), §18 ADR, §19.5 danh sách đỏ | |
| TGĐ / Kế toán trưởng | §19.1 (dữ liệu đầu vào), BA-0 (hạ tầng free), §17 phạm vi kỳ 1 | |
| IT / người vận hành | §12, §13, §19.2 | |
| Design | §21 (antd 6 + token), DS §12.3 cần cập nhật | |

**Chốt khi:** §3 phiên bản được duyệt · BA-0 + BA-1 + BA-3 có văn bản · T-1/T-2 spike kết luận không blocker (đặc biệt: presigned upload và CAS trên M0 chạy đúng) · §12.5 đã chọn A/B/C/D.

---

## Phụ lục A — Scripts (`package.json` gốc)

```jsonc
{
  "engines": { "node": ">=24.10 <25", "pnpm": ">=12" },
  "packageManager": "pnpm@12.4.2",
  "scripts": {
    "dev": "concurrently -n api,web -c blue,green \"pnpm -F @fingate/api dev\" \"pnpm -F @fingate/web dev\"",
    "infra:up": "docker compose -f deploy/compose.yml up -d mongo",
    "build": "pnpm -r build", "start": "node apps/api/dist/server.js",
    "test": "pnpm -r test", "lint": "pnpm -r lint", "typecheck": "pnpm -r typecheck",
    "e2e": "playwright test",
    "db:migrate": "node db/migrate.js", "db:indexes": "node db/apply-indexes.js",
    "db:seed": "node db/seed.js", "db:rebuild-balances": "node db/rebuild-balances.js",
    "db:rebuild-audit": "node db/rebuild-audit.js", "db:archive": "node db/archive.js",
    "check:tie": "node db/check-tie.js", "mail:test": "node scripts/mail-test.js",
    "api:types": "openapi-typescript http://localhost:8080/api/v1/openapi.json -o packages/shared/src/api-types/index.ts"
  }
}
```

## Phụ lục B — Ví dụ dữ liệu chuẩn (không "Lorem" — DS §13.4)

`PC-2026-00123` · 2.500.000.000 ₫ ("2,50 tỷ") · Công ty TNHH Xây dựng Minh Phúc · MST 0301234567 · HĐ/2026/MK-07 · VCB-001 (•••• 4521) · đáo hạn hôm nay 20 tỷ / 7 ngày 62 tỷ · chuyển nội bộ Công ty A → B 5 tỷ.
