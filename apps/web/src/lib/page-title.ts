/**
 * page-title.ts — tiêu đề tab trình duyệt theo màn.
 * routes.tsx đặt tiêu đề mặc định theo URL (useLayoutEffect, chạy trước effect của màn);
 * màn nào có tên cụ thể hơn (vd. tên báo cáo) gọi usePageTitle để ghi đè.
 */

import { useEffect } from 'react';

export const APP_NAME = 'FinGate';

export function formatPageTitle(title?: string | null): string {
  return title ? `${title} · ${APP_NAME}` : APP_NAME;
}

/** Ghi đè tiêu đề tab khi `title` có giá trị (undefined → giữ tiêu đề mặc định của route). */
export function usePageTitle(title?: string | null): void {
  useEffect(() => {
    if (title) document.title = formatPageTitle(title);
  }, [title]);
}
