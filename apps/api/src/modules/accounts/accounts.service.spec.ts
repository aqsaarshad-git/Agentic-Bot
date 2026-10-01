import { NotFoundException } from '@nestjs/common';
import { AccountsService } from './accounts.service';

function account(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'account-1', customerId: 'cust-1', status: 'ACTIVE', openedAt: new Date('2024-01-01'), ...overrides };
}

describe('AccountsService', () => {
  let prisma: any;
  let service: AccountsService;

  beforeEach(() => {
    prisma = {
      account: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    service = new AccountsService(prisma);
  });

  describe('getPrimaryAccount', () => {
    it('throws NotFoundException when the customer has no account at all', async () => {
      prisma.account.findMany.mockResolvedValue([]);
      await expect(service.getPrimaryAccount('cust-1')).rejects.toThrow(NotFoundException);
    });

    it('prefers an ACTIVE account over a non-active one', async () => {
      prisma.account.findMany.mockResolvedValue([account({ id: 'closed', status: 'CLOSED' }), account({ id: 'active', status: 'ACTIVE' })]);
      const result = await service.getPrimaryAccount('cust-1');
      expect(result.id).toBe('active');
    });

    it('falls back to the first account when none are ACTIVE', async () => {
      prisma.account.findMany.mockResolvedValue([account({ id: 'dormant', status: 'DORMANT' })]);
      const result = await service.getPrimaryAccount('cust-1');
      expect(result.id).toBe('dormant');
    });
  });

  describe('resolveForCustomer — ownership', () => {
    it('rejects an explicit accountId belonging to a different customer', async () => {
      prisma.account.findUnique.mockResolvedValue(account({ customerId: 'someone-else' }));
      await expect(service.resolveForCustomer('cust-1', 'account-1')).rejects.toThrow(NotFoundException);
    });

    it('returns the account when it is owned by the requesting customer', async () => {
      prisma.account.findUnique.mockResolvedValue(account({ customerId: 'cust-1' }));
      const result = await service.resolveForCustomer('cust-1', 'account-1');
      expect(result.id).toBe('account-1');
    });

    it('falls back to the primary account when no accountId is given', async () => {
      prisma.account.findMany.mockResolvedValue([account()]);
      const result = await service.resolveForCustomer('cust-1');
      expect(result.id).toBe('account-1');
    });
  });

  describe('adjustBalance', () => {
    it('applies a signed delta to both balance and availableBalance', async () => {
      prisma.account.update.mockResolvedValue(account());
      await service.adjustBalance('account-1', -50);
      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: 'account-1' },
        data: { balance: { increment: -50 }, availableBalance: { increment: -50 } },
      });
    });
  });
});
