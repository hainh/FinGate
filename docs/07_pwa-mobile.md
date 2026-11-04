# FinGate — Bản PWA (app trên điện thoại)

> Trả lời câu hỏi "làm sao biến web app thành app trên mobile mà không sửa gì nhiều".
> Kết luận: **không phải viết app native**. FinGate đã có giao diện responsive + manifest + icon, nên
> chỉ cần thêm một service worker nhỏ là **cài được lên màn hình chính** (Android + iPhone) và chạy
> toàn màn hình như app thật. Toàn bộ thay đổi ở đây **không đụng vào logic nghiệp vụ / tiền / duyệt**.

## 1. Người dùng cài app thế nào

### Android (Chrome)
1. Mở địa chỉ FinGate (phải là **HTTPS**).
2. Chrome hiện banner **"Cài đặt ứng dụng"** / hoặc menu ⋮ → **"Thêm vào màn hình chính"**.
3. Mở icon FinGate → chạy toàn màn hình (không còn thanh địa chỉ).

Mở icon → giữ danh sách chọn nhanh: **Chờ tôi duyệt**, **Tiền hôm nay** (manifest `shortcuts`).

### iPhone / iPad (Safari)
1. Mở địa chỉ FinGate **bằng Safari** (Chrome iOS không cài được PWA).
2. Nút **Chia sẻ** (ô vuông có mũi tên) → **"Thêm vào MH chính"**.
3. Mở từ màn hình chính → chạy toàn màn hình.

> iOS 26 trở đi: mọi trang đều mở như web app khi thêm vào MH chính. Các bản iOS cũ đọc thẻ
> `apple-mobile-web-app-*` trong `apps/web/index.html` — đã khai báo sẵn.

### Điều kiện bắt buộc
- **HTTPS**. `localhost` là ngoại lệ duy nhất (chỉ trên chính máy đó).
- Không cài được qua địa chỉ IP nội bộ `http://192.168.x.x:5139` từ điện thoại — trình duyệt coi đó là
  "không bảo mật" nên không đăng ký service worker. Muốn thử trên máy thật thì dùng tunnel HTTPS
  (repo đã có sẵn `allowedHosts` cho Cloudflare Tunnel trong `apps/web/vite.config.ts`).

## 2. Đã thêm những gì

| File | Việc |
| --- | --- |
| `apps/web/public/site.webmanifest` | `id`, `start_url`, `scope`, `lang: vi`, icon **maskable**, `shortcuts` |
| `apps/web/public/icon-maskable-512.png` | Icon nền full-bleed để Android cắt tròn không lem viền |
| `apps/web/public/sw.js` | Service worker: precache vỏ app, **không cache `/api/`**; có sẵn handler Web Push |
| `apps/web/src/lib/pwa.ts` | Đăng ký SW + quyền Notification |
| `apps/web/src/app/push-notifications.ts` | Hook poll + bắn thông báo hệ thống |
| `apps/web/index.html` | Thẻ `apple-mobile-web-app-*` |
| `apps/web/src/screens/admin.tsx` | Nút **"Bật thông báo"** trong *Cá nhân & cài đặt → Hiển thị* |
| `apps/api/src/domain/queries/push-pending.ts` | Nhặt "phiếu mới chờ tôi duyệt" (idempotent) |
| `apps/api/src/routes/dashboard.ts` | `GET /notifications/push-pending`, `POST /notifications/push-seen` |
| `apps/api/src/db/models.ts` + `indexes.ts` | Trường `push_seen_at` + index |

## 3. Thông báo "có phiếu mới chờ tôi duyệt"

Server **đã** tạo sẵn một bản ghi `Notification` cho đúng người duyệt mỗi khi phiếu tới lượt họ
(`notifyNextApprover`). Phần thiếu chỉ là "ai đó rung chuông trên thiết bị".

- App poll `GET /api/v1/notifications/push-pending?since=<mốc>` mỗi 30 giây khi đang đăng nhập.
- Server nguyên tử giành từng bản ghi bằng `findOneAndUpdate({ push_seen_at: null })` ⇒ **không bắn
  trùng** dù nhiều tab / retry / hai vòng poll chạy song song (có 9 test cho đúng chỗ này).
- Chỉ báo loại `kind: 'approval'` (phiếu tới lượt duyệt / duyệt xong cần thanh toán). Không báo tin hệ thống.
- Bật lần đầu **không** dội loạt thông báo cũ: mốc `fg.push.ack` trong localStorage được đặt khi bật
  quyền và xoá khi đăng xuất.

### Giới hạn cần biết (không phải bug)

| Tình huống | Nhận thông báo? |
| --- | --- |
| App đang mở (tab hiện) | ✅ trong ≤ 30 giây |
| App ở nền nhưng chưa bị hệ điều hành đóng (~5 phút) | ⚠️ phần lớn có, tuỳ máy |
| App đã bị vuốt đóng / iOS khoá máy | ❌ không |

Muốn báo **cả khi app đã đóng** thì phải làm **Web Push thật**: cặp khoá VAPID + bảng
`push_subscriptions` + job đẩy từ server. Đó là hạ tầng mới (NOTI-03 ở mức P4 trong
`docs/03_screens.md`). Phía client **đã sẵn sàng**: `sw.js` đã có handler `push` / `notificationclick`

- `showNotification()`. Khi làm, server chỉ cần đẩy payload:

```json
{ "title": "PC-2026-00001 đang chờ bạn duyệt", "body": "PC-2026-00001 · 500 tr · gửi bởi KTV", "url": "/ho-so/chi/<id>" }
```

## 4. Kiểm thử

```bash
pnpm -F @fingate/web build     # sw.js + manifest + icon có trong apps/web/dist
pnpm -F @fingate/api test      # 773 test, có push-pending.test.ts
pnpm -F @fingate/web test
```

Thử trên máy: đăng nhập → *Cá nhân & cài đặt* → **Bật thông báo** → cấp quyền → dùng một tài khoản khác
lập phiếu chi có người này trong chuỗi duyệt → sau ~30 giây hiện thông báo, bấm vào mở đúng hồ sơ.

## 5. Nếu sau này cần lên Google Play / App Store

Vẫn không phải viết lại UI. Hai vỏ native dùng đúng bundle web hiện tại:

- **Android — TWA (Bubblewrap)**: ~1 giờ, miễn phí, Chrome đóng gói PWA thành AAB. Cần chạy script phía
  máy dev, không đụng repo này.
- **iOS — Capacitor**: cần macOS + Xcode + tài khoản Apple Developer ($99/năm), vỏ `WKWebView` trỏ về
  địa chỉ HTTPS của FinGate. Gợi ý: chỉ làm nếu thực sự cần có mặt trên App Store — PWA đã đủ cho
  "mở như app" trên cả hai nền tảng.
