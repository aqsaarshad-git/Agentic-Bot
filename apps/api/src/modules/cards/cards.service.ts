import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../database/prisma.service';

const PIN_MAX_ATTEMPTS = 3;

@Injectable()
export class CardsService {
  constructor(private readonly prisma: PrismaService) {}

  findForAccounts(accountIds: string[]) {
    return this.prisma.card.findMany({ where: { accountId: { in: accountIds } }, orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string) {
    const card = await this.prisma.card.findUnique({ where: { id }, include: { account: true } });
    if (!card) {
      throw new NotFoundException(`Card ${id} not found`);
    }
    return card;
  }

  /** Ownership-checked lookup — the tool layer's only entry point for a customer session. */
  async findOneForCustomer(cardId: string, customerId: string) {
    const card = await this.findOne(cardId);
    if (card.account.customerId !== customerId) {
      throw new NotFoundException(`Card ${cardId} not found`);
    }
    return card;
  }

  /**
   * Resolves an explicit cardId (ownership-checked) or, when omitted, the customer's single
   * card — the same "default when there's only one, otherwise make it explicit" pattern
   * AccountsService uses for accounts. This sidesteps a real, observed small-model failure
   * mode: asked to act on "the" card, it would sometimes invent a plausible-looking ID instead
   * of copying the real one from a prior get_cards result. With only one card on file (the
   * overwhelmingly common case), there is nothing left to get wrong.
   */
  async resolveForCustomer(customerId: string, cardId?: string) {
    if (cardId) {
      return this.findOneForCustomer(cardId, customerId);
    }
    const cards = await this.prisma.card.findMany({
      where: { account: { customerId } },
      include: { account: true },
    });
    if (cards.length === 0) {
      throw new NotFoundException('No card on file for this customer');
    }
    if (cards.length > 1) {
      throw new BadRequestException('The customer has more than one card — ask which one, or call get_cards to list them and use its cardId');
    }
    return cards[0];
  }

  async activate(cardId: string) {
    const card = await this.findOne(cardId);
    if (card.status !== 'PENDING_ACTIVATION') {
      throw new BadRequestException(`Card is ${card.status.toLowerCase()} and cannot be activated`);
    }
    return this.prisma.card.update({ where: { id: cardId }, data: { status: 'ACTIVE', activatedAt: new Date() } });
  }

  async block(cardId: string, reason?: string) {
    const card = await this.findOne(cardId);
    if (card.status === 'BLOCKED') {
      return card;
    }
    return this.prisma.card.update({
      where: { id: cardId },
      data: { status: 'BLOCKED', blockedAt: new Date(), blockReason: reason ?? 'Blocked at customer request' },
    });
  }

  async unblock(cardId: string) {
    const card = await this.findOne(cardId);
    if (card.status === 'LOST' || card.status === 'STOLEN' || card.status === 'EXPIRED') {
      throw new BadRequestException(`A ${card.status.toLowerCase()} card cannot be unblocked — request a replacement instead`);
    }
    if (card.status !== 'BLOCKED') {
      return card;
    }
    return this.prisma.card.update({
      where: { id: cardId },
      data: { status: 'ACTIVE', blockedAt: null, blockReason: null },
    });
  }

  /** Blocks the card and creates a PENDING_REPLACEMENT sibling in one transaction. */
  private async reportAndReplace(cardId: string, status: 'LOST' | 'STOLEN', reportedAtField: 'lostReportedAt' | 'stolenReportedAt') {
    const card = await this.findOne(cardId);
    const [updated, replacement] = await this.prisma.$transaction([
      this.prisma.card.update({
        where: { id: cardId },
        data: {
          status,
          blockedAt: new Date(),
          blockReason: `Reported ${status.toLowerCase()} by customer`,
          [reportedAtField]: new Date(),
        },
      }),
      this.prisma.card.create({
        data: {
          accountId: card.accountId,
          cardNumberMasked: this.generateReplacementMask(card.cardNumberMasked),
          cardType: card.cardType,
          status: 'PENDING_REPLACEMENT',
          expiryMonth: card.expiryMonth,
          expiryYear: card.expiryYear + 3,
          replacesCardId: cardId,
        },
      }),
    ]);
    return { card: updated, replacement };
  }

  reportLost(cardId: string) {
    return this.reportAndReplace(cardId, 'LOST', 'lostReportedAt');
  }

  reportStolen(cardId: string) {
    return this.reportAndReplace(cardId, 'STOLEN', 'stolenReportedAt');
  }

  /** Standalone replacement request for a card that isn't lost/stolen (e.g. expired, damaged). */
  async replace(cardId: string, reason?: string) {
    const card = await this.findOne(cardId);
    return this.prisma.$transaction([
      this.prisma.card.update({
        where: { id: cardId },
        data: { blockReason: reason ?? card.blockReason },
      }),
      this.prisma.card.create({
        data: {
          accountId: card.accountId,
          cardNumberMasked: this.generateReplacementMask(card.cardNumberMasked),
          cardType: card.cardType,
          status: 'PENDING_REPLACEMENT',
          expiryMonth: card.expiryMonth,
          expiryYear: card.expiryYear + 3,
          replacesCardId: cardId,
        },
      }),
    ]).then(([, replacement]) => replacement);
  }

  private generateReplacementMask(previousMask: string): string {
    const rand = Math.floor(1000 + Math.random() * 9000);
    return previousMask.replace(/\d{4}$/, String(rand));
  }

  isPinBlocked(card: { pinBlockedAt: Date | null }): boolean {
    return card.pinBlockedAt !== null;
  }

  async recordFailedPinAttempt(cardId: string) {
    const card = await this.findOne(cardId);
    const attempts = card.pinFailedAttempts + 1;
    const blocked = attempts >= PIN_MAX_ATTEMPTS;
    return this.prisma.card.update({
      where: { id: cardId },
      data: {
        pinFailedAttempts: attempts,
        status: blocked ? 'BLOCKED' : card.status,
        pinBlockedAt: blocked ? new Date() : null,
        blockReason: blocked ? 'PIN blocked after 3 consecutive failed attempts' : card.blockReason,
      },
    });
  }

  resetPinAttempts(cardId: string) {
    return this.prisma.card.update({
      where: { id: cardId },
      data: { pinFailedAttempts: 0, pinBlockedAt: null },
    });
  }

  /** Sets a new PIN (bcrypt-hashed) and clears any block that was purely PIN-related. */
  async setPin(cardId: string, plaintextPin: string) {
    const pinHash = await bcrypt.hash(plaintextPin, 10);
    const card = await this.findOne(cardId);
    const wasPinBlockedOnly = card.pinBlockedAt !== null && card.status === 'BLOCKED';
    return this.prisma.card.update({
      where: { id: cardId },
      data: {
        pinHash,
        pinSetAt: new Date(),
        pinFailedAttempts: 0,
        pinBlockedAt: null,
        ...(wasPinBlockedOnly ? { status: 'ACTIVE', blockReason: null } : {}),
      },
    });
  }
}
