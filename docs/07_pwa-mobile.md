# FinGate — Bản PWA (app trên điện thoại)

> Trả lời câu hỏi "làm sao biến web app thành app trên mobile mà không sửa gì nhiều".
> Kết luận: **không phải viết app native**. FinGate đã có giao diện responsive + manifest + icon, nên
> chỉ cần thêm một service worker nhỏ là **cài được lên màn hình chính** (Android + iPhone) và chạy
> toàn màn hình như app thật. Toàn bộ thay đổi ở đây **không đụng vào logic nghiệp vụ / tiền / duyệt**.
>
> **Thông báo "chờ tôi duyệt" dùng Web Push ⇒ đến cả khi app đã đóng** (§3–§4).

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
| `apps/web/public/sw.js` | Service worker: precache vỏ app, **không cache `/api/`**; handler `push` + `notificationclick` |
| `apps/web/src/lib/pwa.ts` | Đăng ký SW, đăng ký/huỷ Web Push thiết bị |
| `apps/web/src/app/push-notifications.ts` | Chọn đường thông báo (Web Push ↔ chuông dự phòng) |
| `apps/web/index.html` | Thẻ `apple-mobile-web-app-*` |
| `apps/web/src/screens/admin.tsx` | Nút **"Bật thông báo"** trong *Cá nhân & cài đặt → Hiển thị* |
| `apps/api/src/domain/push/index.ts` | Gửi Web Push qua push service + vòng đẩy 30s |
| `apps/api/src/domain/queries/push-pending.ts` | Nhặt thông báo duyệt chưa bắn (idempotent) |
| `apps/api/src/routes/dashboard.ts` | `push/status`, `push/subscribe`, `push/unsubscribe`, `push-pending` |
| `apps/api/src/db/models.ts` + `indexes.ts` | `push_subscriptions` (endpoint unique) + `push_seen_at` |

## 3. Thông báo "có phiếu mới chờ tôi duyệt"

Server **đã** tạo sẵn một bản ghi `Notification` cho đúng người duyệt mỗi khi phiếu tới lượt họ
(`notifyNextApprover`). Phần còn lại là đẩy nó tới thiết bị.

### 3.1 Web Push — báo cả khi app đã đóng (mặc định)

1. Người dùng bấm **Bật thông báo** → cấp quyền → client `pushManager.subscribe(publicKey)`.
2. Client `POST /api/v1/notifications/push/subscribe` → lưu `push_subscriptions`
   (`endpoint` unique: đăng ký lại cùng máy chỉ làm mới khoá; đăng nhập tài khoản khác trên cùng máy
   thì endpoint chuyển sang người mới).
3. Server chạy vòng đẩy mỗi `PUSH_INTERVAL_SECONDS` (mặc định 30s): nhặt `Notification` duyệt chưa bắn,
   **nguyên tử giành** bằng `findOneAndUpdate({ push_seen_at: null })` rồi gửi qua push service.
4. Service worker nhận `push` → `showNotification`; bấm vào → `notificationclick` mở đúng hồ sơ.

Vì sao đúng-một-lần: hai vòng/ hai instance chạy song song không thể cùng giành một bản ghi (có test).
Push service trả **404/410** ⇒ subscription đã chết (gỡ app, tắt thông báo) → tự xoá bản ghi; lỗi lặp
5 lần thì cũng xoá.

### 3.2 Chuông dự phòng — chỉ khi app đang mở

Khi server **chưa** cấu hình VAPID (hoặc trình duyệt không cho subscribe), app quay về poll
`GET /notifications/push-pending?since=<mốc>` mỗi 30s.

> ⚠️ Hai đường **dùng chung cờ `push_seen_at`**, nên client chỉ chạy MỘT đường tại một thời điểm
> (`App.tsx` chọn `'push'` / `'local'`). Bật cả hai sẽ giành mất thông báo của nhau.

## 4. Cấu hình Web Push (một lần, phía server)

```bash
npx web-push generate-vapid-keys     # sinh Public Key + Private Key
```

Điền vào `.env` (hoặc `deploy/fingate.env`) rồi **khởi động lại API**:

```
VAPID_PUBLIC_KEY=BN...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:ops@congty.vn
```

- Log lúc boot in `Web Push: đang chạy` hoặc `Web Push: TẮT (chưa có ...)`.
- **Đổi khoá VAPID ⇒ mọi thiết bị phải bật lại**: client tự phát hiện khoá cũ (`applicationServerKey`
  khác) và tự subscribe lại ở lần mở app kế tiếp — người dùng chỉ cần mở app một lần.
- Gửi thủ công một lượt (để test / để cron đánh thức server):
  `curl -X POST -H "x-task-token: $TASK_TOKEN" $PUBLIC_URL/api/v1/tasks/push`
- Tắt tạm: `PUSH_ENABLED=false` (app tự quay về chuông dự phòng ở lần tải kế tiếp).

### iOS — điều kiện bắt buộc

| Yêu cầu | Ghi chú |
| --- | --- |
| iOS **16.4+** | dưới mức này Safari không có Web Push |
| Đã **"Thêm vào MH chính"** | push chỉ hoạt động trong app đã cài, KHÔNG trong tab Safari |
| Bật trong **app đã cài** đó | nút "Bật thông báo" nằm ở *Cá nhân & cài đặt*, mở từ icon ngoài màn hình chính |

### Giới hạn còn lại

| Tình huống | Nhận thông báo? |
| --- | --- |
| App đã đóng (vuốt tắt), máy khoá | ✅ Web Push (có VAPID + đã đăng ký) |
| App đang mở | ✅ Web Push ngay, không cần poll |
| Chưa cấu hình VAPID | ⚠️ chỉ khi app còn mở |
| Người dùng tắt quyền thông báo ở hệ điều hành | ❌ không (là quyết định của người dùng) |

Độ trễ: thông báo đến sau khi vòng đẩy phía server chạy (≤ ~30 giây sau khi phiếu vào hàng chờ), cộng
độ trễ của push service (thường 1–5 giây). Máy phải bật nguồn và có mạng.

## 5. Kiểm thử

```bash
pnpm -F @fingate/web build     # sw.js + manifest + icon có trong apps/web/dist
pnpm -F @fingate/api test      # gồm push/index.test.ts (gửi Web Push) + push-pending.test.ts
pnpm -F @fingate/web test
```

Thử end-to-end:
1. Cấu hình VAPID + khởi động lại API, đăng nhập trên điện thoại (đã cài app nếu là iOS).
2. *Cá nhân & cài đặt* → **Bật thông báo** → cấp quyền → dòng trạng thái phải ghi
   "thông báo đến cả khi app đã đóng".
3. **Đóng hẳn app** (vuốt tắt).
4. Tài khoản khác lập phiếu chi có người này là cấp duyệt kế tiếp.
5. Trong ≤ ~35 giây, thông báo hiện trên màn hình khoá. Bấm vào → mở thẳng hồ sơ.

## 6. Nếu sau này cần lên Google Play / App Store

Vẫn không phải viết lại UI. Hai vỏ native dùng đúng bundle web hiện tại:

- **Android — TWA (Bubblewrap)**: ~1 giờ, miễn phí, Chrome đóng gói PWA thành AAB. Cần chạy script phía
  máy dev, không đụng repo này.
- **iOS — Capacitor**: cần macOS + Xcode + tài khoản Apple Developer ($99/năm), vỏ `WKWebView` trỏ về
  địa chỉ HTTPS của FinGate. Gợi ý: chỉ làm nếu thực sự cần có mặt trên App Store — PWA đã đủ cho
  "mở như app" trên cả hai nền tảng.
