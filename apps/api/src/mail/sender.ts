/**
 * Mail (architecture §9.4, K-13) — nodemailer qua SMTP công ty.
 *
 * Email là kênh thông báo CHÍNH (không có web push kỳ 1). `MAIL_MODE`:
 *   smtp = gửi thật · log = in ra console (dev) · off = im lặng (test)
 * Quiet hours 22:00–06:00 VN chỉ áp cho non-danger (arch §9.4).
 */

import { createTransport, type Transporter } from 'nodemailer';
import { getEnv } from '../env.ts';

let transporter: Transporter | null = null;

function mailer(): Transporter | null {
  const env = getEnv();
  if (env.MAIL_MODE === 'off') return null;
  if (env.MAIL_MODE === 'log') return null;
  if (!env.SMTP_URL) {
    console.warn('[mail] SMTP_URL trống — thông báo chỉ lên web. Xem arch §19.2-3');
    return null;
  }
  transporter ??= createTransport(env.SMTP_URL);
  return transporter;
}

export interface MailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** danger = bỏ qua quiet hours (đáo hạn hôm nay, khoản chờ duyệt quá SLA). */
  urgent?: boolean;
  cc?: string[];
}

/** Giờ VN hiện tại 22:00–06:00 → im lặng với mail không khẩn. */
function inQuietHours(now = new Date()): boolean {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', hour12: false }).format(now));
  return h >= 22 || h < 6;
}

export async function sendMail(input: MailInput): Promise<boolean> {
  const env = getEnv();
  if (env.MAIL_MODE === 'off') return false;
  if (!input.urgent && inQuietHours()) {
    console.log(`[mail] bỏ qua (quiet hours) → ${input.to}: ${input.subject}`);
    return false;
  }
  if (env.MAIL_MODE === 'log') {
    console.log(`[mail] → ${input.to} | ${input.subject}\n${stripHtml(input.html).slice(0, 400)}`);
    return true;
  }
  const t = mailer();
  if (!t) return false;
  try {
    await t.sendMail({
      from: env.MAIL_FROM,
      to: input.to,
      cc: input.cc?.length ? input.cc.join(', ') : undefined,
      subject: input.subject,
      html: input.html,
      text: input.text ?? stripHtml(input.html),
    });
    return true;
  } catch (err) {
    // mail lỗi không được làm hỏng nghiệp vụ — notification trên web vẫn còn
    console.warn('[mail] gửi thất bại:', (err as Error).message);
    return false;
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Template tối giản, inline style (mail client không ăn CSS class). */
export function layout(input: { title: string; body: string; ctaLabel?: string; ctaHref?: string; footNote?: string }): string {
  const url = getEnv().PUBLIC_URL.replace(/\/$/, '');
  const cta =
    input.ctaHref && input.ctaLabel
      ? `<p style="margin:24px 0"><a href="${url}${input.ctaHref}" style="background:#3445C4;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-family:Inter,Arial,sans-serif;font-size:14px">${input.ctaLabel}</a></p>`
      : '';
  return `<!doctype html><html><body style="margin:0;background:#F7F8FA;font-family:Inter,'Segoe UI',Arial,sans-serif;color:#171A1F">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E1E5EB;border-radius:12px">
<tr><td style="padding:20px 24px;border-bottom:1px solid #EAECF0;font-size:12px;color:#5D6673;letter-spacing:.06em;text-transform:uppercase">FinGate · Hệ thống điều hành dòng tiền</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 12px;font-size:20px;line-height:28px">${input.title}</h1>
<div style="font-size:14px;line-height:22px;color:#3D4451">${input.body}</div>
${cta}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #EAECF0;font-size:12px;color:#5D6673">
${input.footNote ?? 'Email tự động — vui lòng không trả lời. Mở hệ thống để xem chi tiết và phê duyệt.'}
</td></tr></table></td></tr></table></body></html>`;
}

export const mailTemplates = {
  approvalRequest(input: { name: string; roleLabel: string; code: string; amount: string; company: string; href: string; actorName: string; statusLabel: string; urgent?: boolean }) {
    return layout({
      title: `${input.code} đang chờ ${input.roleLabel.toLowerCase()} duyệt`,
      body: `<p>Xin chào ${input.name},</p>
<p><strong>${input.amount}</strong> — ${input.code} · ${input.company}<br>
Người lập: ${input.actorName} · Trạng thái: ${input.statusLabel}</p>
<p>Mở hồ sơ để xem 7 câu hỏi kiểm soát và quyết định.</p>`,
      ctaLabel: 'Xem hồ sơ để duyệt',
      ctaHref: input.href,
    });
  },
  invite(input: { name: string; company: string; roleLabel: string; href: string; inviter: string; days: number }) {
    return layout({
      title: 'Mời bạn tham gia FinGate',
      body: `<p>${input.inviter} mời bạn tham gia <strong>${input.company}</strong> với chức danh <strong>${input.roleLabel}</strong>.</p>
<p>Liên kết có hiệu lực ${input.days} ngày. Khi tạo tài khoản, hệ thống tự động gắn bạn vào đúng công ty và chức danh đã chỉ định.</p>`,
      ctaLabel: 'Kích hoạt tài khoản',
      ctaHref: input.href,
    });
  },
  slaBreach(input: { name: string; count: number; amount: string; href: string; oldest: string }) {
    return layout({
      title: `${input.count} khoản đang chờ bạn duyệt quá SLA`,
      body: `<p>Tổng <strong>${input.amount}</strong>. Hồ sơ chờ lâu nhất: ${input.oldest}.</p>`,
      ctaLabel: 'Mở hàng chờ',
      ctaHref: input.href,
    });
  },
  maturity(input: { name: string; days: number; count: number; amount: string; href: string }) {
    return layout({
      title: `Đáo hạn ${input.days === 0 ? 'hôm nay' : `trong ${input.days} ngày`} · ${input.amount}`,
      body: `<p>${input.count} khoản vay đến hạn cần chuẩn bị nguồn tiền.</p>`,
      ctaLabel: 'Xem bảng đảo hạn',
      ctaHref: input.href,
      footNote: 'Cảnh báo mức nghiêm trọng — cần hành động hôm nay.',
    });
  },
  resetPassword(input: { href: string; minutes: number }) {
    return layout({
      title: 'Đặt lại mật khẩu',
      body: `<p>Bạn vừa yêu cầu đặt lại mật khẩu. Liên kết hết hạn sau ${input.minutes} phút.</p><p>Nếu không phải bạn, bỏ qua email này — mật khẩu hiện tại vẫn giữ nguyên.</p>`,
      ctaLabel: 'Đặt lại mật khẩu',
      ctaHref: input.href,
    });
  },
  /** Quản trị nhân sự cấp link đổi mật khẩu cho tài khoản đã kích hoạt. */
  adminResetPassword(input: { name: string; company: string; roleLabel: string; href: string; inviter: string; days: number }) {
    return layout({
      title: 'Đặt lại mật khẩu FinGate',
      body: `<p>Xin chào ${input.name},</p>
<p>${input.inviter} đã cấp cho bạn liên kết đặt lại mật khẩu để truy cập <strong>${input.company}</strong> với chức danh <strong>${input.roleLabel}</strong>.</p>
<p>Liên kết có hiệu lực ${input.days} ngày và chỉ dùng được một lần. Sau khi đặt mật khẩu mới, mọi phiên đăng nhập cũ sẽ bị thu hồi.</p>
<p>Nếu không phải bạn, hãy bỏ qua email này và liên hệ quản trị.</p>`,
      ctaLabel: 'Đặt lại mật khẩu',
      ctaHref: input.href,
    });
  },
  digest(input: { name: string; body: string; href: string }) {
    return layout({ title: `Bản tin tài chính ngày ${new Date().toLocaleDateString('vi-VN')}`, body: input.body, ctaLabel: 'Đọc bản tin', ctaHref: input.href });
  },
};
