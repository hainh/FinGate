import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { debtRoutes } from '../../routes/debt.ts';
import { bankDebtRoutes } from '../../routes/bank-debt.ts';

/** Kiểm tra đăng ký route (không chạy handler): đủ endpoint v2, không trùng, schema dựng được. */
describe('routes công nợ & nợ ngân hàng v2', () => {
  it('đăng ký đủ endpoint và khởi động được Fastify', async () => {
    const app = Fastify();
    debtRoutes(app);
    bankDebtRoutes(app);
    await app.ready();

    const expected: [string, string][] = [
      ['GET', '/debts'],
      ['GET', '/debts/aging'],
      ['POST', '/debts'],
      ['GET', '/debts/:id'],
      ['PATCH', '/debts/:id'],
      ['DELETE', '/debts/:id'],
      ['POST', '/debts/:id/links'],
      ['DELETE', '/debts/:id/links/:linkId'],
      ['GET', '/debts/:id/link-candidates'],
      ['GET', '/bank-debts'],
      ['POST', '/bank-debts'],
      ['POST', '/bank-debts/import'],
      ['GET', '/bank-debts/:id'],
      ['PATCH', '/bank-debts/:id'],
      ['DELETE', '/bank-debts/:id'],
      ['GET', '/bank-debts/:id/schedule'],
      ['POST', '/bank-debts/:id/cancel'],
      ['POST', '/bank-debts/:id/archive'],
      ['POST', '/bank-debts/:id/disbursements'],
      ['DELETE', '/bank-debts/:id/disbursements/:linkId'],
      ['GET', '/bank-debts/:id/disbursement-candidates'],
      ['POST', '/bank-debts/:id/repayments'],
      ['DELETE', '/bank-debts/:id/repayments/:linkId'],
      ['GET', '/bank-debts/:id/repayment-candidates'],
      ['DELETE', '/bank-debts/:id/funded-by/:linkId'],
    ];
    for (const [method, url] of expected) {
      expect(app.hasRoute({ method: method as 'GET', url }), `${method} ${url}`).toBe(true);
    }
    await app.close();
  });
});
