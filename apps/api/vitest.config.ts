import { configDefaults, defineConfig } from 'vitest/config';

// `dist/` là đầu ra build (có thể còn file test cũ đã bị xoá khỏi src) — không chạy làm bộ kiểm thử.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
