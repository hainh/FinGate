/**
 * Chống trùng tên tag ở tầng DB (unique index (company_id, name_key), v2 §6.2).
 *
 * Sáu POST /tags đồng thời cùng một tên: đúng MỘT yêu cầu tạo mới (201, created = true); năm yêu cầu còn lại
 * trả tag đã có (200, created = false). Không yêu cầu nào lỗi 5xx và danh bạ chỉ có một tag tên đó.
 * Tên đều đi qua uniq() để không đụng dữ liệu của agent khác.
 */
import { test, expect, uniq } from './fixtures';
import { COMPANY, api, companyIdOf, tagsNamed } from './helpers-tags';

test.describe('tags · unique index chống trùng tên khi tạo đồng thời', () => {
  test('sáu POST /tags cùng tên đồng thời: đúng một tag mới, còn lại trả tag đã có; không 5xx; không tạo trùng', async ({
    as,
  }) => {
    const chief = await as('chief');
    const cta = await companyIdOf(chief, COMPANY.CTA);
    const name = uniq('Tag đồng thời');

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api<{ data?: unknown; created?: boolean }>(chief, 'POST', '/tags', {
          scope: cta,
          data: { company_id: cta, name },
        }),
      ),
    );

    for (const r of results) {
      expect(r.status, `POST /tags: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    }
    const createdFlags = results.map((r) => r.body?.created === true);
    expect(createdFlags.filter(Boolean), 'đúng một yêu cầu tạo mới').toHaveLength(1);

    const same = await tagsNamed(chief, cta, name);
    expect(same, 'danh bạ chỉ có một tag tên này (kể cả đã ẩn)').toHaveLength(1);
  });
});
