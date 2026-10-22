/**
 * Chi chờ duyệt (CHI-04, docs/03_screens.md): danh sách ghim MỌI bước pending.* — không chỉ một bước.
 */
import { describe, expect, it } from 'vitest';
import { STATUS_KEYS } from '@fingate/shared';
import { PENDING_APPROVAL_STATUSES } from './documents.tsx';

describe('PENDING_APPROVAL_STATUSES — chờ duyệt gồm đủ các cấp', () => {
  it('bằng đúng tập pending.* của registry trạng thái', () => {
    const registry = STATUS_KEYS.filter((k) => k.startsWith('pending.')).sort();
    expect(registry.length).toBeGreaterThan(1);
    expect([...PENDING_APPROVAL_STATUSES].sort()).toEqual(registry);
  });
});
