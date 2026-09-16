/**
 * Cache in-memory TTL 60s — thay cho Redis (K-6).
 * Chỉ dùng cho badge số lượng + dashboard tổng hợp (arch §8.3). Không cache dữ liệu mutation.
 */

import { getEnv } from '../env.ts';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const hit = store.get(key) as Entry<T> | undefined;
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

export function cacheSet<T>(key: string, value: T, ttlMs?: number): void {
  const ttl = ttlMs ?? getEnv().CACHE_TTL_MS;
  store.set(key, { value, expiresAt: Date.now() + ttl });
  if (store.size > 5000) {
    // trần bộ nhớ 512 MB — dọn key hết hạn trước, rồi tới key cũ nhất
    const now = Date.now();
    for (const [k, v] of store) if (v.expiresAt < now) store.delete(k);
    while (store.size > 4000) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  }
}

export async function cacheThrough<T>(key: string, load: () => Promise<T>, ttlMs?: number): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const fresh = await load();
  cacheSet(key, fresh, ttlMs);
  return fresh;
}

/** Vô hiệu mọi key theo prefix (sau mutation làm số liệu đổi ngay). */
export function cacheInvalidate(prefix: string): void {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

export function cacheClear(): void {
  store.clear();
}

export function cacheStats(): { size: number } {
  return { size: store.size };
}
