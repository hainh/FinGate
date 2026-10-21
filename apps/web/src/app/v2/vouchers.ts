/**
 * Dữ liệu phụ cho form phiếu thu/chi (v2/v2.md §6.1, US-VOU-01): danh mục và dòng ngân sách.
 *
 * Chỉ đọc API có sẵn (`GET /admin/categories` công khai; `GET /admin/budgets` cần `budget:read`).
 * Không đổi contract. Người không có `budget:read` nhận danh sách rỗng (form vẫn dùng được).
 */

import { useQuery } from '@tanstack/react-query';
import { apiCall } from '../api.ts';
import { useAuth } from '../store.tsx';

/** Một danh mục thu/chi (ADM-08). `doc_kind` khớp loại phiếu (spend | income | rollover | internal). */
export interface VoucherCategoryOption {
  _id: string;
  name: string;
  code: string | null;
  doc_kind: string;
  active: boolean;
  requires_budget: boolean;
  required_evidence: string[];
}

export function useVoucherCategories() {
  return useQuery({
    queryKey: ['voucher-categories'],
    staleTime: 300_000,
    queryFn: () => apiCall<{ items: VoucherCategoryOption[] }>('/admin/categories'),
  });
}

/** Dòng ngân sách của một công ty, gắn vào `budget.budget_id` + `budget.line_id` của phiếu. */
export interface BudgetLineOption {
  budget_id: string;
  line_id: string;
  label: string;
  period_label: string;
  department_name: string | null;
  category_name: string | null;
}

interface AdminBudgetWire {
  _id: string;
  company_id: string;
  period_label: string;
  lines: { line_id: string; label: string; department_name: string | null; category_name: string | null }[];
}

/** Dòng ngân sách đang dùng được của công ty (chỉ khi có `budget:read`). */
export function useBudgetLineOptions(companyId: string | null) {
  const { can } = useAuth();
  const allowed = can('budget:read');
  return useQuery({
    queryKey: ['budget-line-options', companyId],
    enabled: allowed && !!companyId,
    staleTime: 60_000,
    queryFn: async (): Promise<BudgetLineOption[]> => {
      const res = await apiCall<{ items: AdminBudgetWire[] }>('/admin/budgets', { scope: companyId ?? undefined });
      const out: BudgetLineOption[] = [];
      for (const b of res.items ?? []) {
        if (b.company_id !== companyId) continue;
        for (const l of b.lines ?? []) {
          out.push({
            budget_id: b._id,
            line_id: l.line_id,
            label: l.label,
            period_label: b.period_label,
            department_name: l.department_name,
            category_name: l.category_name,
          });
        }
      }
      return out;
    },
  });
}

/** Nhãn một dòng ngân sách trong ô chọn: "Kỳ · Dòng (bộ phận)". */
export function budgetLineLabel(o: BudgetLineOption): string {
  const dept = o.department_name ? ` · ${o.department_name}` : '';
  return `${o.period_label} · ${o.label}${dept}`;
}
