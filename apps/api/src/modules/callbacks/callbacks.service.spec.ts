import { NotFoundException } from '@nestjs/common';
import { CallbacksService } from './callbacks.service';

describe('CallbacksService', () => {
  let prisma: any;
  let service: CallbacksService;

  beforeEach(() => {
    prisma = {
      callback: { findFirst: jest.fn(), create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    service = new CallbacksService(prisma);
  });

  describe('create — idempotent by (customer, date, time)', () => {
    const input = { customerId: 'cust-1', requestedDate: new Date('2026-10-01'), requestedTime: '15:00', reason: 'card question' };

    it('returns the existing PENDING/SCHEDULED request instead of creating a duplicate', async () => {
      const existing = { id: 'cb-1', status: 'PENDING' };
      prisma.callback.findFirst.mockResolvedValue(existing);

      const result = await service.create(input);

      expect(result).toBe(existing);
      expect(prisma.callback.create).not.toHaveBeenCalled();
    });

    it('creates a new callback when no active one exists for that slot', async () => {
      prisma.callback.findFirst.mockResolvedValue(null);
      prisma.callback.create.mockResolvedValue({ id: 'cb-2', status: 'PENDING' });

      await service.create(input);

      expect(prisma.callback.create).toHaveBeenCalledWith({ data: { ...input, status: 'PENDING' } });
    });

    it('does not dedupe against a CANCELLED callback for the same slot', async () => {
      prisma.callback.findFirst.mockResolvedValue(null); // findFirst is scoped to PENDING/SCHEDULED only
      prisma.callback.create.mockResolvedValue({ id: 'cb-3', status: 'PENDING' });

      await service.create(input);

      expect(prisma.callback.findFirst.mock.calls[0][0].where.status).toEqual({ in: ['PENDING', 'SCHEDULED'] });
      expect(prisma.callback.create).toHaveBeenCalled();
    });
  });

  describe('cancelForCustomer', () => {
    it('rejects cancelling someone else\'s callback', async () => {
      prisma.callback.findUnique.mockResolvedValue({ id: 'cb-1', customerId: 'someone-else', status: 'PENDING' });
      await expect(service.cancelForCustomer('cb-1', 'cust-1')).rejects.toThrow(NotFoundException);
      expect(prisma.callback.update).not.toHaveBeenCalled();
    });

    it('rejects cancelling one that is already CANCELLED/COMPLETED', async () => {
      prisma.callback.findUnique.mockResolvedValue({ id: 'cb-1', customerId: 'cust-1', status: 'COMPLETED' });
      await expect(service.cancelForCustomer('cb-1', 'cust-1')).rejects.toThrow(NotFoundException);
    });

    it('cancels an active callback owned by the requesting customer', async () => {
      prisma.callback.findUnique.mockResolvedValue({ id: 'cb-1', customerId: 'cust-1', status: 'PENDING' });
      prisma.callback.update.mockResolvedValue({ id: 'cb-1', status: 'CANCELLED' });

      const result = await service.cancelForCustomer('cb-1', 'cust-1');

      expect(result.status).toBe('CANCELLED');
    });
  });
});
