import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TransfersService } from './transfers.service';

function account(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'account-1',
    customerId: 'cust-1',
    status: 'ACTIVE',
    balance: 1000,
    availableBalance: 1000,
    dailyTransferLimit: 5000,
    currency: 'SAR',
    ...overrides,
  };
}

describe('TransfersService', () => {
  let prisma: any;
  let service: TransfersService;

  beforeEach(() => {
    prisma = {
      account: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      beneficiary: { findUnique: jest.fn() },
      transfer: { updateMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), aggregate: jest.fn() },
      $transaction: jest.fn(),
    };
    service = new TransfersService(prisma, { generateTransactionRef: jest.fn() } as any);
  });

  describe('proposeTransfer — cross-customer isolation', () => {
    it('rejects when the source account belongs to a different customer', async () => {
      prisma.account.findUnique.mockResolvedValue(account({ customerId: 'someone-else' }));
      await expect(
        service.proposeTransfer({ customerId: 'cust-1', conversationId: 'conv-1', fromAccountId: 'account-1', beneficiaryId: 'ben-1', amount: 10 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects when the beneficiary belongs to a different customer, even with a valid source account', async () => {
      prisma.account.findUnique.mockResolvedValue(account());
      prisma.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', customerId: 'someone-else', status: 'ACTIVE' });
      await expect(
        service.proposeTransfer({ customerId: 'cust-1', conversationId: 'conv-1', fromAccountId: 'account-1', beneficiaryId: 'ben-1', amount: 10 }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a beneficiary that is not ACTIVE', async () => {
      prisma.account.findUnique.mockResolvedValue(account());
      prisma.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', customerId: 'cust-1', status: 'BLOCKED' });
      await expect(
        service.proposeTransfer({ customerId: 'cust-1', conversationId: 'conv-1', fromAccountId: 'account-1', beneficiaryId: 'ben-1', amount: 10 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('proposeTransfer — business rules', () => {
    it('rejects an amount exceeding available balance', async () => {
      prisma.account.findUnique.mockResolvedValue(account({ availableBalance: 5 }));
      prisma.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', customerId: 'cust-1', status: 'ACTIVE' });
      await expect(
        service.proposeTransfer({ customerId: 'cust-1', conversationId: 'conv-1', fromAccountId: 'account-1', beneficiaryId: 'ben-1', amount: 10 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a non-ACTIVE source account', async () => {
      prisma.account.findUnique.mockResolvedValue(account({ status: 'SUSPENDED' }));
      prisma.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', customerId: 'cust-1', status: 'ACTIVE' });
      await expect(
        service.proposeTransfer({ customerId: 'cust-1', conversationId: 'conv-1', fromAccountId: 'account-1', beneficiaryId: 'ben-1', amount: 10 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects providing neither or both of destination account / beneficiary', async () => {
      prisma.account.findUnique.mockResolvedValue(account());
      await expect(
        service.proposeTransfer({ customerId: 'cust-1', conversationId: 'conv-1', fromAccountId: 'account-1', amount: 10 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('cancel then confirm', () => {
    it('confirmAndExecute finds nothing pending once the transfer was cancelled', async () => {
      const pending = { id: 'transfer-1', transferReference: 'TRF-1' };
      prisma.transfer.findFirst.mockResolvedValueOnce(pending); // cancelPending's own lookup
      prisma.transfer.update.mockResolvedValue({ ...pending, status: 'CANCELLED' });
      await service.cancelPending('cust-1', 'conv-1');

      // After cancellation, confirmAndExecute's own lookup for a PENDING_CONFIRMATION row finds none.
      prisma.transfer.findFirst.mockResolvedValueOnce(null);
      await expect(service.confirmAndExecute('cust-1', 'conv-1')).rejects.toThrow(NotFoundException);
    });
  });
});
