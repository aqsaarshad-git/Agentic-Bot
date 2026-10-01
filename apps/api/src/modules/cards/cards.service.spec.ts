import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CardsService } from './cards.service';

function card(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'card-1',
    accountId: 'account-1',
    cardNumberMasked: '**** **** **** 1234',
    cardType: 'DEBIT',
    status: 'ACTIVE',
    expiryMonth: 11,
    expiryYear: 2028,
    replacesCardId: null,
    account: { customerId: 'cust-1' },
    ...overrides,
  };
}

describe('CardsService', () => {
  let prisma: any;
  let service: CardsService;

  beforeEach(() => {
    prisma = {
      card: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
      $transaction: jest.fn(),
    };
    service = new CardsService(prisma);
  });

  describe('resolveForCustomer — ambiguity', () => {
    it('rejects when the customer has more than one card and none was specified', async () => {
      prisma.card.findMany.mockResolvedValue([card({ id: 'card-1' }), card({ id: 'card-2' })]);
      await expect(service.resolveForCustomer('cust-1')).rejects.toThrow(BadRequestException);
    });

    it('auto-resolves when the customer has exactly one card', async () => {
      prisma.card.findMany.mockResolvedValue([card({ id: 'card-1' })]);
      const result = await service.resolveForCustomer('cust-1');
      expect(result.id).toBe('card-1');
    });

    it('throws NotFoundException when the customer has no card at all', async () => {
      prisma.card.findMany.mockResolvedValue([]);
      await expect(service.resolveForCustomer('cust-1')).rejects.toThrow(NotFoundException);
    });
  });

  // Reference resolution (2026-09-29): "block the card ending in 7712" previously had no way
  // to resolve at all with 2+ cards on file — only an exact cardId or the single-card default
  // worked. Resolves from the customer's OWN masked numbers, never invented.
  describe('resolveForCustomer — last4', () => {
    it('resolves the one card whose masked number ends in the given last4', async () => {
      prisma.card.findMany.mockResolvedValue([
        card({ id: 'card-1', cardNumberMasked: '**** **** **** 7712' }),
        card({ id: 'card-2', cardNumberMasked: '**** **** **** 4452' }),
      ]);
      const result = await service.resolveForCustomer('cust-1', undefined, '7712');
      expect(result.id).toBe('card-1');
    });

    it('asks which one when the last4 matches more than one card', async () => {
      prisma.card.findMany.mockResolvedValue([
        card({ id: 'card-1', cardNumberMasked: '**** **** **** 7712' }),
        card({ id: 'card-2', cardNumberMasked: '**** **** **** 7712' }),
      ]);
      await expect(service.resolveForCustomer('cust-1', undefined, '7712')).rejects.toThrow(BadRequestException);
    });

    it('reports not-found rather than guessing when no card matches the last4', async () => {
      prisma.card.findMany.mockResolvedValue([card({ id: 'card-1', cardNumberMasked: '**** **** **** 4452' })]);
      await expect(service.resolveForCustomer('cust-1', undefined, '7712')).rejects.toThrow(NotFoundException);
    });

    it('an explicit cardId still takes priority over last4', async () => {
      prisma.card.findUnique.mockResolvedValue(card({ id: 'card-9', account: { customerId: 'cust-1' } }));
      const result = await service.resolveForCustomer('cust-1', 'card-9', '0000');
      expect(result.id).toBe('card-9');
    });
  });

  describe('findOneForCustomer — ownership', () => {
    it('rejects a card belonging to a different customer', async () => {
      prisma.card.findUnique.mockResolvedValue(card({ account: { customerId: 'someone-else' } }));
      await expect(service.findOneForCustomer('card-1', 'cust-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('reportLost / reportStolen — idempotency', () => {
    // CONFIRMED LIVE (2026-09-29): a second report_lost_card call for the same card used to
    // throw a raw unhandled Prisma unique-constraint error (replacesCardId is @unique) instead
    // of failing gracefully or no-op'ing — a real, unhandled crash on a duplicate/retried call.
    it('returns the existing replacement instead of crashing when the card is already LOST', async () => {
      const lostCard = card({ status: 'LOST' });
      const existingReplacement = card({ id: 'card-2', status: 'PENDING_REPLACEMENT', replacesCardId: 'card-1' });
      prisma.card.findUnique
        .mockResolvedValueOnce(lostCard) // findOne(cardId)
        .mockResolvedValueOnce(existingReplacement); // the replacesCardId lookup

      const result = await service.reportLost('card-1');

      expect(result.replacement).toBe(existingReplacement);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('is safe to call reportStolen after an earlier reportLost — updates status without a duplicate replacement', async () => {
      const lostCard = card({ status: 'LOST' });
      const existingReplacement = card({ id: 'card-2', status: 'PENDING_REPLACEMENT', replacesCardId: 'card-1' });
      prisma.card.findUnique.mockResolvedValueOnce(lostCard).mockResolvedValueOnce(existingReplacement);
      prisma.card.update.mockResolvedValue(card({ status: 'STOLEN' }));

      const result = await service.reportStolen('card-1');

      expect(result.replacement).toBe(existingReplacement);
      expect(result.card.status).toBe('STOLEN');
      expect(prisma.card.update.mock.calls[0][0].data.status).toBe('STOLEN');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // The bug that actually happened live: `replace()` (e.g. a damaged-card request) leaves the
    // original card ACTIVE — so the status-only check would miss this entirely and still crash
    // on a later reportLost/reportStolen for the same card.
    it('is also safe when a replacement already exists from a plain replace() call, even though the card is still ACTIVE', async () => {
      const activeCard = card({ status: 'ACTIVE' });
      const existingReplacement = card({ id: 'card-2', status: 'PENDING_REPLACEMENT', replacesCardId: 'card-1' });
      prisma.card.findUnique.mockResolvedValueOnce(activeCard).mockResolvedValueOnce(existingReplacement);
      prisma.card.update.mockResolvedValue(card({ status: 'STOLEN' }));

      const result = await service.reportStolen('card-1');

      expect(result.replacement).toBe(existingReplacement);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates a real replacement on the first report', async () => {
      const activeCard = card({ status: 'ACTIVE' });
      prisma.card.findUnique.mockResolvedValueOnce(activeCard).mockResolvedValueOnce(null);
      const updated = card({ status: 'LOST' });
      const replacement = card({ id: 'card-2', status: 'PENDING_REPLACEMENT', replacesCardId: 'card-1' });
      prisma.$transaction.mockResolvedValue([updated, replacement]);

      const result = await service.reportLost('card-1');

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result.replacement).toBe(replacement);
    });
  });

  describe('replace — idempotency', () => {
    it('returns the existing replacement instead of crashing on a duplicate replace_card call', async () => {
      const activeCard = card({ status: 'ACTIVE', blockReason: 'Screen damaged' });
      const existingReplacement = card({ id: 'card-2', status: 'PENDING_REPLACEMENT', replacesCardId: 'card-1' });
      prisma.card.findUnique.mockResolvedValueOnce(activeCard).mockResolvedValueOnce(existingReplacement);

      const result = await service.replace('card-1', 'Screen damaged');

      expect(result).toBe(existingReplacement);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('creates a real replacement on the first call', async () => {
      const activeCard = card({ status: 'ACTIVE' });
      prisma.card.findUnique.mockResolvedValueOnce(activeCard).mockResolvedValueOnce(null);
      const replacement = card({ id: 'card-2', status: 'PENDING_REPLACEMENT', replacesCardId: 'card-1' });
      prisma.$transaction.mockResolvedValue([activeCard, replacement]);

      const result = await service.replace('card-1', 'Damaged');

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result).toBe(replacement);
    });
  });

  describe('block — idempotency', () => {
    it('is a safe no-op when the card is already BLOCKED (no duplicate block/audit action)', async () => {
      prisma.card.findUnique.mockResolvedValue(card({ status: 'BLOCKED', blockReason: 'PIN blocked' }));
      const result = await service.block('card-1', 'Suspected misuse');
      expect(result.status).toBe('BLOCKED');
      expect(prisma.card.update).not.toHaveBeenCalled();
    });
  });

  describe('unblock', () => {
    it('refuses to unblock a LOST/STOLEN/EXPIRED card', async () => {
      prisma.card.findUnique.mockResolvedValue(card({ status: 'STOLEN' }));
      await expect(service.unblock('card-1')).rejects.toThrow(BadRequestException);
    });

    it('unblocks a BLOCKED card and clears the block reason', async () => {
      prisma.card.findUnique.mockResolvedValue(card({ status: 'BLOCKED', blockReason: 'PIN blocked' }));
      prisma.card.update.mockResolvedValue(card({ status: 'ACTIVE', blockReason: null }));
      const result = await service.unblock('card-1');
      expect(result.status).toBe('ACTIVE');
      expect(prisma.card.update.mock.calls[0][0].data.blockReason).toBeNull();
    });
  });
});
