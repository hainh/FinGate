/**
 * Fixture e2e dùng chung: đăng nhập theo vai trò bằng API (cookie `fgs`), mỗi vai trò một context riêng.
 *
 * Tài khoản test (mật khẩu chung 123qweasdzxc):
 *  - staff  kt@fingate.local   — Kế toán viên (CTA, CTB, GROUP, MAYOGU)
 *  - chief  ktt@fingate.local  — Kế toán trưởng (CTA, CTB, GROUP, MAYOGU)
 *  - director gda@fingate.local — Giám đốc CTA
 *  - chairman ct@fingate.local  — Chủ tịch (GROUP, thấy mọi công ty)
 */
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const PASSWORD = '123qweasdzxc';
export const USERS = {
  staff: 'kt@fingate.local',
  chief: 'ktt@fingate.local',
  director: 'gda@fingate.local',
  chairman: 'ct@fingate.local',
} as const;
export type Role = keyof typeof USERS;

/** Hậu tố duy nhất cho dữ liệu test (tránh trùng giữa các lượt / tiến trình song song). */
export function uniq(prefix: string): string {
  return `${prefix} ${process.env.PW_AREA ?? 'e2e'} ${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

export async function loginContext(browser: Browser, role: Role): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  const res = await ctx.request.post('/api/v1/auth/login', { data: { email: USERS[role], password: PASSWORD } });
  expect(res.ok(), `login ${role}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ctx;
}

type Fixtures = {
  /** Mở trang đã đăng nhập theo vai trò: `const page = await as('chief')`. */
  as: (role: Role) => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  as: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (role) => {
      const ctx = await loginContext(browser, role);
      contexts.push(ctx);
      const page = await ctx.newPage();
      page.on('pageerror', (err) => console.log(`[pageerror ${role}] ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.log(`[console.error ${role}] ${msg.text()}`);
      });
      return page;
    });
    for (const c of contexts) await c.close();
  },
});

export { expect };
