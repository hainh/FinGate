/**
 * Khoá export khi đối chiếu tiền lệch (§8.5: "lệch thì tạo alert danger + khoá export
 * + thông báo KTT, KHÔNG tự sửa"). Cờ nằm trong `settings` → mọi instance cùng thấy.
 */

import { Models } from '../db/models.ts';

export async function setTieLock(mismatches: unknown[] | null): Promise<void> {
  await Models.Setting.updateOne(
    { key: 'tie.lock' },
    { $set: { key: 'tie.lock', value: { locked: Boolean(mismatches), mismatches: mismatches ?? [], at: new Date().toISOString() }, updated_at: new Date() } },
    { upsert: true },
  ).exec();
}

export async function tieLocked(): Promise<{ locked: boolean; at?: string }> {
  const doc = await Models.Setting.findOne({ key: 'tie.lock' }).lean<{ value?: { locked?: boolean; at?: string } } | null>();
  return { locked: Boolean(doc?.value?.locked), at: doc?.value?.at };
}
