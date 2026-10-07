/**
 * FinGate — hợp đồng danh bạ Đối tác/Khách hàng.
 *
 * Một đối tác (khoá = tên công ty) có NHIỀU tài khoản ngân hàng (khoá = số tài khoản).
 * Danh bạ dùng chung toàn tập đoàn.
 */

import { z } from 'zod';

/** Dấu phân tách CHUẨN giữa 3 trường: Tên công ty - Ngân hàng - Số tài khoản. */
export const COUNTERPARTY_SEPARATOR = ' - ';

export const counterpartyBankField = z.object({
  bank_name: z.string().min(1).max(200).describe('Tên ngân hàng'),
  account_number: z.string().min(1).max(80).describe('Số tài khoản'),
  branch: z.string().max(200).nullable().optional(),
  account_name: z.string().max(200).nullable().optional(),
});
export type CounterpartyBankField = z.infer<typeof counterpartyBankField>;

export const counterpartyUpsertBody = z.object({
  name: z.string().min(2).max(200).describe('Tên công ty / đối tác'),
  banks: z.array(counterpartyBankField).max(100).default([]),
  note: z.string().max(2000).nullable().optional(),
});
export type CounterpartyUpsertBody = z.infer<typeof counterpartyUpsertBody>;

export const counterpartyListQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});
export type CounterpartyListQuery = z.infer<typeof counterpartyListQuery>;
