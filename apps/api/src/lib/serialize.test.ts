import { describe, expect, it } from 'vitest';
import { jsonSafe } from './serialize.ts';

describe('jsonSafe — giữ tham chiếu lặp (không phải vòng)', () => {
  it('cùng một object xuất hiện hai lần: lần nào cũng đủ dữ liệu (không thành null)', () => {
    const tag = { _id: 't1', name: 'Quan trọng', color: '#ff0000' };
    const out = jsonSafe({ rows: [{ tags: [tag] }, { tags: [tag] }] }) as { rows: { tags: unknown[] }[] };
    expect(out.rows[0]!.tags).toEqual([tag]);
    expect(out.rows[1]!.tags).toEqual([tag]);
  });

  it('cùng một mảng vừa ở khoá này vừa ở chain (khoản vay): cả hai đều là mảng', () => {
    const funded = [{ _id: 'pc1', code: 'PC-1' }];
    const out = jsonSafe({ funded_by_links: funded, chain: { funded_by: funded, disbursements: [] } }) as {
      funded_by_links: unknown[];
      chain: { funded_by: unknown[] | null };
    };
    expect(out.funded_by_links).toEqual(funded);
    expect(out.chain.funded_by).toEqual(funded);
  });

  it('cùng một output vừa ở steps[] vừa ở generated[] (automation): không có null', () => {
    const output = { kind: 'loan', code: 'NHD-1' };
    const out = jsonSafe({ steps: [{ name: 'create_loan', output }], generated: [output] }) as {
      steps: { output: unknown }[];
      generated: unknown[];
    };
    expect(out.steps[0]!.output).toEqual(output);
    expect(out.generated).toEqual([output]);
  });

  it('vẫn cắt vòng lặp thật (object chứa chính nó) bằng null', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node.self = node;
    const out = jsonSafe(node) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBeNull();
  });

  it('BigInt → string, Date → ISO, __v bị bỏ qua', () => {
    const d = new Date('2026-10-22T00:00:00.000Z');
    const out = jsonSafe({ amount: 12n, at: d, __v: 0, x: 1 });
    expect(out).toEqual({ amount: '12', at: '2026-10-22T00:00:00.000Z', x: 1 });
  });
});
