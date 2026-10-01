import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';

function transaction(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'txn-1',
    transactionRef: 'TXN-1',
    accountId: 'account-1',
    cardId: null,
    amount: 260,
    currency: 'SAR',
    status: 'COMPLETED',
    ...overrides,
  };
}

describe('TransactionsService', () => {
  let prisma: any;
  let service: TransactionsService;

  beforeEach(() => {
    prisma = {
      transaction: { findUnique: jest.fn(), findMany: jest.fn() },
      account: { update: jest.fn() },
      $transaction: jest.fn(),
    };
    service = new TransactionsService(prisma);
  });

  describe('findByRefForCustomer — ownership', () => {
    it('throws NotFoundException when the transaction belongs to a different customer', async () => {
      prisma.transaction.findUnique.mockResolvedValue({ ...transaction(), account: { customerId: 'someone-else' } });
      await expect(service.findByRefForCustomer('TXN-1', 'cust-1')).rejects.toThrow(NotFoundException);
    });

    it('returns the transaction when it belongs to the requesting customer', async () => {
      prisma.transaction.findUnique.mockResolvedValue({ ...transaction(), account: { customerId: 'cust-1' } });
      const result = await service.findByRefForCustomer('TXN-1', 'cust-1');
      expect(result.transactionRef).toBe('TXN-1');
    });
  });

  describe('findForAccount — real DB filters (amount / merchant / date / status / type)', () => {
    it('defaults to 5 rows, newest first, scoped to the given account only', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      await service.findForAccount('account-1');
      const arg = prisma.transaction.findMany.mock.calls[0][0];
      expect(arg.take).toBe(5);
      expect(arg.orderBy).toEqual({ postedAt: 'desc' });
      expect(arg.where.accountId).toBe('account-1');
    });

    it('pushes amount, merchant, status, type and a date range down into the DB query', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      await service.findForAccount('account-1', {
        amount: 120,
        merchant: 'Carrefour',
        status: 'FAILED',
        type: 'DEBIT',
        fromDate: '2026-09-01',
        toDate: '2026-09-15',
        limit: 20,
      });
      const { where, take } = prisma.transaction.findMany.mock.calls[0][0];
      expect(take).toBe(20);
      expect(where).toMatchObject({ accountId: 'account-1', amount: 120, status: 'FAILED', type: 'DEBIT', merchantName: { contains: 'Carrefour' } });
      expect(where.postedAt.gte).toEqual(new Date('2026-09-01'));
      // A bare date upper bound includes that whole day.
      expect(where.postedAt.lte.getTime()).toBeGreaterThan(new Date('2026-09-15').getTime());
    });

    it('ignores an unparseable date instead of filtering on garbage', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      await service.findForAccount('account-1', { fromDate: 'not-a-date' });
      expect(prisma.transaction.findMany.mock.calls[0][0].where.postedAt).toBeUndefined();
    });

    it('applies no extra filters when none are given (legacy forced-tool call shape unchanged)', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);
      await service.findForAccount('account-1', { limit: 5 });
      const { where } = prisma.transaction.findMany.mock.calls[0][0];
      expect(where.amount).toBeUndefined();
      expect(where.merchantName).toBeUndefined();
      expect(where.postedAt).toBeUndefined();
    });
  });

  describe('findByRefForCustomer — no match', () => {
    it('throws NotFoundException for a reference that does not exist at all (never guesses)', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      await expect(service.findByRefForCustomer('TXN-NOPE', 'cust-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('refundTransaction', () => {
    it('rejects refunding a PENDING transaction', async () => {
      prisma.transaction.findUnique.mockResolvedValue(transaction({ status: 'PENDING' }));
      await expect(service.refundTransaction('txn-1')).rejects.toThrow(BadRequestException);
    });

    it('rejects a zero/negative explicit amount', async () => {
      prisma.transaction.findUnique.mockResolvedValue(transaction());
      await expect(service.refundTransaction('txn-1', { amount: 0 })).rejects.toThrow(BadRequestException);
    });

    it('defaults the refund amount to the full original amount and links it back via relatedTransactionId', async () => {
      prisma.transaction.findUnique.mockResolvedValue(transaction());
      const tx = { account: { update: jest.fn() }, transaction: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }), create: jest.fn().mockResolvedValue({ transactionRef: 'TXN-REFUND-1' }) } };
      prisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

      await service.refundTransaction('txn-1');

      expect(tx.account.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'account-1' },
        data: { balance: { increment: 260 }, availableBalance: { increment: 260 } },
      });
      const createArg = tx.transaction.create.mock.calls[0][0].data;
      expect(createArg.channel).toBe('REFUND');
      expect(createArg.type).toBe('CREDIT');
      expect(createArg.relatedTransactionId).toBe('txn-1');
      expect(createArg.amount).toBe(260);
    });

    it('honors an explicit partial refund amount instead of the full original amount', async () => {
      prisma.transaction.findUnique.mockResolvedValue(transaction());
      const tx = { account: { update: jest.fn() }, transaction: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }), create: jest.fn().mockResolvedValue({}) } };
      prisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

      await service.refundTransaction('txn-1', { amount: 100, reason: 'partial goodwill refund' });

      expect(tx.account.update.mock.calls[0][0].data.balance.increment).toBe(100);
      expect(tx.transaction.create.mock.calls[0][0].data.amount).toBe(100);
      expect(tx.transaction.create.mock.calls[0][0].data.description).toBe('partial goodwill refund');
    });

    function txWithPriorRefunds(sum: number | null) {
      const tx = {
        account: { update: jest.fn() },
        transaction: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: sum } }), create: jest.fn().mockResolvedValue({}) },
      };
      prisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
      return tx;
    }

    it('rejects a second full refund of an already fully refunded transaction (no double credit)', async () => {
      prisma.transaction.findUnique.mockResolvedValue(transaction());
      const tx = txWithPriorRefunds(260);
      await expect(service.refundTransaction('txn-1')).rejects.toThrow(/already been refunded/);
      expect(tx.transaction.create).not.toHaveBeenCalled();
      expect(tx.transaction.aggregate.mock.calls[0][0].where).toMatchObject({ relatedTransactionId: 'txn-1', channel: 'REFUND' });
    });

    it('rejects a partial refund that would push the total past the original amount', async () => {
      prisma.transaction.findUnique.mockResolvedValue(transaction());
      const tx = txWithPriorRefunds(200);
      await expect(service.refundTransaction('txn-1', { amount: 100 })).rejects.toThrow(BadRequestException);
      expect(tx.transaction.create).not.toHaveBeenCalled();
    });

    it('allows a second partial refund that fits within the remaining refundable amount', async () => {
      prisma.transaction.findUnique.mockResolvedValue(transaction());
      const tx = txWithPriorRefunds(100);
      await service.refundTransaction('txn-1', { amount: 160 });
      expect(tx.transaction.create).toHaveBeenCalledTimes(1);
    });

    it('rejects a single refund larger than the original amount', async () => {
      prisma.transaction.findUnique.mockResolvedValue(transaction());
      txWithPriorRefunds(null);
      await expect(service.refundTransaction('txn-1', { amount: 999 })).rejects.toThrow(/exceeds/);
    });
  });
});
