#!/usr/bin/env node
/**
 * `pnpm mail:test <email>` — kiểm tra SMTP.
 * Email là kênh thông báo CHÍNH (K-13) và là thứ hay thiếu nhất khi deploy free (§19.2-3).
 * MAIL_MODE=log thì chỉ in ra console; MAIL_MODE=off trả lỗi có chủ đích.
 */

import { loadEnv } from '../apps/api/dist/env.js';
import { sendMail, mailTemplates } from '../apps/api/dist/mail/sender.js';

const to = process.argv[2];
if (!to) {
  console.error('dùng: pnpm mail:test <email>');
  process.exit(1);
}

const env = loadEnv();
console.log(`· MAIL_MODE=${env.MAIL_MODE} · FROM=${env.MAIL_FROM} · SMTP_URL=${env.SMTP_URL ? 'đã khai báo' : 'TRỐNG'}`);

const sent = await sendMail({
  to,
  subject: 'FinGate — kiểm tra email',
  html: mailTemplates.digest({
    name: 'Bạn',
    body: '<p>Email này xác nhận hệ thống gửi thông báo đi được.</p>',
    href: '/ban-tin/ngay',
  }),
  urgent: true,
});

console.log(sent ? '✓ gửi thành công (hoặc đã log ở console)' : '✗ không gửi được — kiểm tra SMTP_URL (§19.2-3)');
process.exitCode = sent ? 0 : 1;
