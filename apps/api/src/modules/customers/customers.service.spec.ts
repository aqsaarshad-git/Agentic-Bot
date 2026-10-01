import { NotFoundException } from '@nestjs/common';
import { CustomersService } from './customers.service';

describe('CustomersService', () => {
  let prisma: any;
  let service: CustomersService;

  beforeEach(() => {
    prisma = {
      customer: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    };
    service = new CustomersService(prisma);
  });

  describe('findOne', () => {
    it('throws NotFoundException for a missing customer', async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateContactInfo — the only customer-facing (AI-tool) profile-change path', () => {
    it('updates only phone/email/address, never fullName or language', async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: 'cust-1' });
      prisma.customer.update.mockResolvedValue({ id: 'cust-1', phone: '+1000', email: 'new@example.com', address: '1 Main St' });

      await service.updateContactInfo('cust-1', { phone: '+1000', email: 'new@example.com', address: '1 Main St' });

      const dataArg = prisma.customer.update.mock.calls[0][0].data;
      expect(dataArg).toEqual({ phone: '+1000', email: 'new@example.com', address: '1 Main St' });
      expect(dataArg.fullName).toBeUndefined();
      expect(dataArg.language).toBeUndefined();
    });

    it('rejects updating a customer that does not exist', async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.updateContactInfo('missing', { phone: '+1000' })).rejects.toThrow(NotFoundException);
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });

    it('only sends the fields that were actually provided', async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: 'cust-1' });
      prisma.customer.update.mockResolvedValue({ id: 'cust-1' });

      await service.updateContactInfo('cust-1', { email: 'only-email@example.com' });

      const dataArg = prisma.customer.update.mock.calls[0][0].data;
      expect(dataArg.email).toBe('only-email@example.com');
      expect(dataArg.phone).toBeUndefined();
      expect(dataArg.address).toBeUndefined();
    });
  });
});
