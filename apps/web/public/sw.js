/* FinGate — Service Worker: chỉ để app CÀI ĐƯỢC lên màn hình chính và mở nhanh.
 *
 * NGUYÊN TẮC AN TOÀN (không đổi nếu chưa đọc hết):
 *  1. KHÔNG BAO GIỜ cache `/api/` — app đặt `cache: 'no-store'` cho mọi GET (app/api.ts) để phiếu
 *     duyệt luôn đọc số liệu tươi. Cache dữ liệu tài chính = user duyệt phiếu/thanh toán trên số liệu
 *     cũ. Mọi request `/api/` đi thẳng ra mạng.
 *  2. Chỉ xử lý GET same-origin — POST/PATCH/PUT/DELETE (duyệt, thanh toán, upload) không bị can thiệp.
 *  3. Điều hướng (mở app, refresh, deep-link) theo kiểu network-first: có mạng thì luôn lấy HTML mới
 *     nhất, chỉ khi mất mạng mới trả bản shell đã lưu → không bao giờ ghim index.html cũ sau deploy.
 *  4. Tài nguyên tĩnh có hash trong tên (`/assets/…`) mới dùng cache-first, vì nội dung không đổi.
 */

const VERSION = 'v1';
const SHELL_CACHE = `fg-shell-${VERSION}`;
const ASSET_CACHE = `fg-asset-${VERSION}`;

/** Vỏ tối thiểu để mở app khi mất mạng. Đường dẫn tuyệt đối theo scope `/`. */
const SHELL_URLS = [
  '/',
  '/index.html',
  '/site.webmanifest',
  '/favicon.ico',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/theme-init.js',
];

/** Trang báo mất mạng — self-contained, không phụ thuộc JS/CSS ngoài. */
const OFFLINE_HTML = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>FinGate — Không có kết nối</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background:#f6f7fb; color:#171a1f; text-align:center; }
  @media (prefers-color-scheme: dark) { body { background:#14161c; color:#e8eaf0; } }
  .card { max-width: 360px; }
  .mark { width:56px; height:56px; border-radius:16px; background:#4759e0; color:#fff;
          display:grid; place-items:center; font-weight:700; font-size:26px; margin:0 auto 16px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 20px; opacity:.75; }
  button { font:inherit; padding:12px 20px; border-radius:12px; border:0; cursor:pointer;
           background:#4759e0; color:#fff; min-height:44px; }
</style></head>
<body><div class="card">
  <div class="mark" aria-hidden="true">F</div>
  <h1>Không có kết nối</h1>
  <p>FinGate cần mạng để tải số liệu mới nhất. Kiểm tra Wi-Fi/4G rồi thử lại.</p>
  <button type="button" onclick="location.reload()">Thử lại</button>
</div></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll fail toàn bộ nếu 1 URL 404 → thêm từng cái, thiếu cái nào cũng còn cái khác.
      await Promise.all(SHELL_URLS.map((url) => cache.add(url).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Dọn cache của phiên bản cũ.
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/** Request có nên bỏ qua cache hoàn toàn? (API, SSE, phương thức ghi, khác origin) */
function mustBypass(request, url) {
  if (request.method !== 'GET') return true;
  if (url.origin !== self.location.origin) return true;
  // Tuyệt đối không cache API — xem nguyên tắc (1) ở đầu file.
  if (url.pathname.startsWith('/api/')) return true;
  // Range request (video/file) không cache.
  if (request.headers.has('range')) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (mustBypass(request, url)) return; // để trình duyệt tự xử lý như không có SW

  // 1) Điều hướng (mở app, refresh, deep-link): network-first → fallback shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          void cache.put('/index.html', fresh.clone()).catch(() => undefined);
          return fresh;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const cached = (await cache.match('/index.html')) || (await cache.match('/'));
          if (cached) return cached;
          return new Response(OFFLINE_HTML, {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  // 2) Tài nguyên tĩnh đã hash (`/assets/x-abc123.js`): cache-first, bất biến theo tên.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh.ok) void cache.put(request, fresh.clone()).catch(() => undefined);
        return fresh;
      })(),
    );
    return;
  }

  // 3) Icon/manifest/theme-init: stale-while-revalidate (mở nhanh, nền tự cập nhật).
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (res.ok) void cache.put(request, res.clone()).catch(() => undefined);
          return res;
        })
        .catch(() => undefined);
      return cached || (await network) || new Response('', { status: 504 });
    })(),
  );
});

/* ---------------- Web Push (NOTI-03 — cần VAPID + bảng push_subscriptions ở server) ---------------- */

self.addEventListener('push', (event) => {
  let payload = { title: 'FinGate', body: '', url: '/' };
  try {
    if (event.data) payload = { ...payload, ...JSON.parse(event.data.text()) };
  } catch {
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'FinGate', {
      body: payload.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: payload.url || '/' },
      tag: payload.tag,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ('navigate' in client) await client.navigate(target).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
