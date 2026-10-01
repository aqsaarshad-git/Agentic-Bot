import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BeneficiariesService } from './beneficiaries.service';

function beneficiary(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 'ben-1', customerId: 'cust-1', beneficiaryName: 'Ahmed', nickname: null, status: 'ACTIVE', ...overrides };
}

describe('BeneficiariesService', () => {
  let prisma: any;
  let service: BeneficiariesService;

  beforeEach(() => {
    prisma = {
      beneficiary: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    };
    service = new BeneficiariesService(prisma);
  });

  describe('add — re-adding a previously removed beneficiary', () => {
    it('rejects adding a duplicate that is still ACTIVE', async () => {
      prisma.beneficiary.findUnique.mockResolvedValue(beneficiary({ status: 'ACTIVE' }));
      await expect(service.add({ customerId: 'cust-1', beneficiaryName: 'Ahmed', accountNumber: 'ACC-1' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reactivates a REMOVED beneficiary instead of creating a duplicate row', async () => {
      prisma.beneficiary.findUnique.mockResolvedValue(beneficiary({ status: 'REMOVED' }));
      prisma.beneficiary.update.mockResolvedValue(beneficiary({ status: 'ACTIVE' }));

      await service.add({ customerId: 'cust-1', beneficiaryName: 'Ahmed', accountNumber: 'ACC-1' });

      expect(prisma.beneficiary.update.mock.calls[0][0].data.status).toBe('ACTIVE');
      expect(prisma.beneficiary.create).not.toHaveBeenCalled();
    });

    it('creates a new row when nothing existed before', async () => {
      prisma.beneficiary.findUnique.mockResolvedValue(null);
      prisma.beneficiary.create.mockResolvedValue(beneficiary());
      await service.add({ customerId: 'cust-1', beneficiaryName: 'Ahmed', accountNumber: 'ACC-1' });
      expect(prisma.beneficiary.create).toHaveBeenCalled();
    });
  });

  // CONFIRMED LIVE BUG FIX (2026-09-22): Qwen invented a plausible-looking beneficiaryId instead
  // of copying the real one — falling back to name matching against the customer's real saved
  // list closes that without ever trusting an unverified ID.
  describe('resolveForCustomer — ID hallucination fallback', () => {
    it('uses the given ID directly when it resolves to a real, owned, active beneficiary', async () => {
      prisma.beneficiary.findUnique.mockResolvedValue(beneficiary({ id: 'ben-1', customerId: 'cust-1' }));
      const result = await service.resolveForCustomer('cust-1', 'ben-1');
      expect(result.id).toBe('ben-1');
    });

    it('falls back to name matching when the given ID does not resolve (invented ID)', async () => {
      prisma.beneficiary.findUnique.mockResolvedValue(null); // the invented ID resolves to nothing
      prisma.beneficiary.findMany.mockResolvedValue([beneficiary({ id: 'ben-1', beneficiaryName: 'Ahmed' })]);

      const result = await service.resolveForCustomer('cust-1', 'ben_invented123', 'Ahmed');

      expect(result.id).toBe('ben-1');
    });

    it('never resolves an ID that belongs to a different customer, even by falling back to a name match on someone else\'s list', async () => {
      prisma.beneficiary.findUnique.mockResolvedValue(beneficiary({ customerId: 'someone-else' }));
      prisma.beneficiary.findMany.mockResolvedValue([]); // this customer's OWN list has no "Ahmed"
      await expect(service.resolveForCustomer('cust-1', 'ben-1', 'Ahmed')).rejects.toThrow(NotFoundException);
    });

    it('fails safely (asks which one) when the name matches more than one saved beneficiary', async () => {
      prisma.beneficiary.findMany.mockResolvedValue([
        beneficiary({ id: 'ben-1', beneficiaryName: 'Ahmed Ali' }),
        beneficiary({ id: 'ben-2', beneficiaryName: 'Ahmed Hassan' }),
      ]);
      await expect(service.resolveForCustomer('cust-1', undefined, 'Ahmed')).rejects.toThrow(BadRequestException);
    });

    it('fails safely (not found) when neither an ID nor a name match anything', async () => {
      prisma.beneficiary.findMany.mockResolvedValue([]);
      await expect(service.resolveForCustomer('cust-1', undefined, 'Nobody')).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove — ownership', () => {
    it('rejects removing a beneficiary belonging to a different customer', async () => {
      prisma.beneficiary.findUnique.mockResolvedValue(beneficiary({ customerId: 'someone-else' }));
      await expect(service.remove('ben-1', 'cust-1')).rejects.toThrow(NotFoundException);
    });
  });
});
