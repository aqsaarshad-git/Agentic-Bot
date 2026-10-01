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

  let config: { get: jest.Mock };

  beforeEach(() => {
    prisma = {
      account: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      beneficiary: { findUnique: jest.fn() },
      transfer: { updateMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), aggregate: jest.fn() },
      $transaction: jest.fn(),
    };
    // Defaults to no fee so every pre-existing test keeps validating amount alone, exactly as
    // before — the fee-specific tests below opt into a nonzero value explicitly.
    config = { get: jest.fn().mockReturnValue(0) };
    service = new TransfersService(prisma, { generateTransactionRef: jest.fn() } as any, config as any);
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

  describe('proposeTransfer — beneficiary transfer fee', () => {
    beforeEach(() => {
      // $transaction here is the array form ([updateMany, create]), not a callback — the mock
      // just needs to resolve to a 2-tuple so proposeTransfer's `const [, transfer] = ...`
      // destructuring succeeds; the real assertions read what transfer.create was CALLED with.
      prisma.$transaction.mockResolvedValue([undefined, { transferReference: 'TRF-1' }]);
    });

    it('stores the configured beneficiary-transfer fee and validates amount+fee against available balance', async () => {
      config.get.mockImplementation((key: string) => (key === 'banking.fees.beneficiaryTransfer.amount' ? 5 : 0));
      prisma.account.findUnique.mockResolvedValue(account({ availableBalance: 20 }));
      prisma.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', customerId: 'cust-1', status: 'ACTIVE' });

      await service.proposeTransfer({ customerId: 'cust-1', conversationId: 'conv-1', fromAccountId: 'account-1', beneficiaryId: 'ben-1', amount: 10 });

      expect(prisma.transfer.create.mock.calls[0][0].data.fee).toBe(5);
    });

    it('rejects a beneficiary transfer whose amount plus fee exceeds available balance, even though the amount alone would fit', async () => {
      config.get.mockImplementation((key: string) => (key === 'banking.fees.beneficiaryTransfer.amount' ? 5 : 0));
      prisma.account.findUnique.mockResolvedValue(account({ availableBalance: 12 }));
      prisma.beneficiary.findUnique.mockResolvedValue({ id: 'ben-1', customerId: 'cust-1', status: 'ACTIVE' });

      await expect(
        service.proposeTransfer({ customerId: 'cust-1', conversationId: 'conv-1', fromAccountId: 'account-1', beneficiaryId: 'ben-1', amount: 10 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('charges no fee for an INTERNAL (own-account) transfer even when a beneficiary fee is configured', async () => {
      config.get.mockImplementation((key: string) => (key === 'banking.fees.beneficiaryTransfer.amount' ? 5 : 0));
      prisma.account.findUnique
        .mockResolvedValueOnce(account({ availableBalance: 12 })) // source
        .mockResolvedValueOnce(account({ id: 'account-2' })); // destination

      await service.proposeTransfer({ customerId: 'cust-1', conversationId: 'conv-1', fromAccountId: 'account-1', toAccountId: 'account-2', amount: 10 });

      expect(prisma.transfer.create.mock.calls[0][0].data.fee).toBe(0);
    });
  });

  describe('findByReferenceForCustomer — ownership', () => {
    it('rejects a transfer belonging to a different customer', async () => {
      prisma.transfer.findUnique.mockResolvedValue({ transferReference: 'TRF-1', customerId: 'someone-else' });
      await expect(service.findByReferenceForCustomer('TRF-1', 'cust-1')).rejects.toThrow(NotFoundException);
    });

    it('rejects a reference that does not exist at all', async () => {
      prisma.transfer.findUnique.mockResolvedValue(null);
      await expect(service.findByReferenceForCustomer('TRF-doesnotexist', 'cust-1')).rejects.toThrow(NotFoundException);
    });

    it('returns the transfer when it belongs to the requesting customer', async () => {
      prisma.transfer.findUnique.mockResolvedValue({ transferReference: 'TRF-1', customerId: 'cust-1', status: 'COMPLETED' });
      const result = await service.findByReferenceForCustomer('TRF-1', 'cust-1');
      expect(result.status).toBe('COMPLETED');
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

  describe('confirmAndExecute — double-confirm idempotency', () => {
    it('never moves money twice: a second confirm loses the atomic claim and fails safely', async () => {
      const pending = {
        id: 'transfer-1',
        transferReference: 'TRF-1',
        amount: 100,
        fee: 0,
        fromAccountId: 'account-1',
        confirmationExpiresAt: new Date(Date.now() + 60_000),
      };
      prisma.transfer.findFirst.mockResolvedValue(pending);
      // The atomic claim (updateMany with a status guard) affects 0 rows — some earlier call
      // (e.g. a duplicate/retried confirm) already won the race and flipped the status.
      prisma.transfer.updateMany.mockResolvedValue({ count: 0 });
      prisma.transfer.findUnique.mockResolvedValue({ ...pending, status: 'CONFIRMED' });

      await expect(service.confirmAndExecute('cust-1', 'conv-1')).rejects.toThrow(/already confirmed/);

      // The money-movement block must never run once the atomic claim itself failed — this is
      // exactly what makes a retried/duplicate confirm_transfer call safe.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
