import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TransactionChannel, TransactionFailureReason, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

const REFUNDABLE_STATUSES: TransactionStatus[] = ['COMPLETED', 'FAILED'];

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  generateTransactionRef(): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TXN-${stamp}${rand}`;
  }

  /**
   * Account-scoped listing. Optional filters are all real columns (status/type/amount/merchant/
   * posted-date) so "the 120 SAR one" or "the Carrefour payment" can be narrowed by the DATABASE
   * instead of the LLM eyeballing a truncated list. `accountId` is always the authenticated
   * customer's own resolved account, never model-supplied. An unparseable date is ignored rather
   * than silently matching everything wrongly.
   */
  findForAccount(
    accountId: string,
    params: {
      limit?: number;
      status?: TransactionStatus;
      type?: 'DEBIT' | 'CREDIT';
      amount?: number;
      merchant?: string;
      fromDate?: string;
      toDate?: string;
    } = {},
  ) {
    const { limit = 5, status, type, amount, merchant, fromDate, toDate } = params;
    const from = fromDate ? new Date(fromDate) : undefined;
    const to = toDate ? new Date(toDate) : undefined;
    const postedAt: { gte?: Date; lte?: Date } = {};
    if (from && !Number.isNaN(from.getTime())) postedAt.gte = from;
    if (to && !Number.isNaN(to.getTime())) {
      // A bare YYYY-MM-DD upper bound means "through the end of that day".
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(toDate))) to.setUTCHours(23, 59, 59, 999);
      postedAt.lte = to;
    }
    return this.prisma.transaction.findMany({
      where: {
        accountId,
        status,
        type,
        amount: amount !== undefined ? amount : undefined,
        merchantName: merchant ? { contains: merchant } : undefined,
        postedAt: Object.keys(postedAt).length ? postedAt : undefined,
      },
      orderBy: { postedAt: 'desc' },
      take: limit,
      include: { relatedTransaction: true, refunds: true },
    });
  }

  async findOne(id: string) {
    const transaction = await this.prisma.transaction.findUnique({ where: { id } });
    if (!transaction) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }
    return transaction;
  }

  async findByRef(transactionRef: string) {
    const transaction = await this.prisma.transaction.findUnique({ where: { transactionRef } });
    if (!transaction) {
      throw new NotFoundException(`Transaction ${transactionRef} not found`);
    }
    return transaction;
  }

  /** Ownership-checked lookup — the tool layer's only entry point for a customer session. */
  async findByRefForCustomer(transactionRef: string, customerId: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { transactionRef },
      include: { account: true, relatedTransaction: true, refunds: true },
    });
    if (!transaction || transaction.account.customerId !== customerId) {
      throw new NotFoundException(`Transaction ${transactionRef} not found`);
    }
    return transaction;
  }

  create(data: {
    accountId: string;
    cardId?: string;
    type: 'DEBIT' | 'CREDIT';
    channel?: TransactionChannel;
    amount: number;
    currency: string;
    status: TransactionStatus;
    failureReason?: TransactionFailureReason | null;
    description?: string;
    merchantName?: string;
    relatedTransactionId?: string;
  }) {
    return this.prisma.transaction.create({
      data: {
        transactionRef: this.generateTransactionRef(),
        accountId: data.accountId,
        cardId: data.cardId,
        type: data.type,
        channel: data.channel ?? 'OTHER',
        amount: data.amount,
        currency: data.currency,
        status: data.status,
        failureReason: data.failureReason ?? null,
        description: data.description,
        merchantName: data.merchantName,
        relatedTransactionId: data.relatedTransactionId,
      },
    });
  }

  /**
   * Issues a REAL refund: credits the account and creates a linked, auditable REFUND
   * transaction — never just a resolution note on a ticket claiming money moved. Staff-only
   * (see TicketsController.refund); no customer/AI tool can call this directly, since a
   * compromised or manipulated conversation must never be able to move money back to itself.
   */
  async refundTransaction(originalTransactionId: string, params: { amount?: number; reason?: string } = {}) {
    const original = await this.findOne(originalTransactionId);
    if (!REFUNDABLE_STATUSES.includes(original.status)) {
      throw new BadRequestException(`A ${original.status.toLowerCase()} transaction cannot be refunded`);
    }
    const amount = params.amount ?? Number(original.amount);
    if (amount <= 0) {
      throw new BadRequestException('Refund amount must be greater than zero');
    }

    return this.prisma.$transaction(async (tx) => {
      // The account update takes the account's row lock FIRST, so two concurrent refunds of the
      // same transaction serialize here; the already-refunded check below then sees the other's
      // committed row. Throwing rolls the balance increment back.
      await tx.account.update({
        where: { id: original.accountId },
        data: { balance: { increment: amount }, availableBalance: { increment: amount } },
      });
      const alreadyRefunded = await tx.transaction.aggregate({
        where: { relatedTransactionId: original.id, channel: 'REFUND', type: 'CREDIT' },
        _sum: { amount: true },
      });
      const refundedSoFar = Number(alreadyRefunded._sum.amount ?? 0);
      if (refundedSoFar + amount > Number(original.amount) + 0.0001) {
        throw new BadRequestException(
          refundedSoFar > 0
            ? `This transaction has already been refunded ${refundedSoFar} ${original.currency}; only ${Math.max(0, Number(original.amount) - refundedSoFar)} ${original.currency} remains refundable`
            : 'Refund amount exceeds the original transaction amount',
        );
      }
      return tx.transaction.create({
        data: {
          transactionRef: this.generateTransactionRef(),
          accountId: original.accountId,
          cardId: original.cardId,
          type: 'CREDIT',
          channel: 'REFUND',
          amount,
          currency: original.currency,
          status: 'COMPLETED',
          description: params.reason ?? `Refund for ${original.transactionRef}`,
          relatedTransactionId: original.id,
          settledAt: new Date(),
        },
      });
    });
  }
}
