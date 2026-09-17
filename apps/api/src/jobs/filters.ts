/** Lọc hồ sơ quá SLA cho task `sla-scan` — đi qua index {status, approval.steps.sla_deadline}. */

export function queueFilterForSla(now: Date): Record<string, unknown> {
  return {
    status: { $in: ['pending.ktt', 'pending.pgd', 'pending.gd', 'pending.chairman'] },
    'approval.steps.sla_deadline': { $ne: null, $lt: now },
    archived_at: null,
  };
}
