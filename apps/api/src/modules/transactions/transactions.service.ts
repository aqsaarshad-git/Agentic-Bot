import { Injectable, NotFoundException } from '@nestjs/common';
import { TransactionChannel, TransactionFailureReason, TransactionStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class TransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  generateTransactionRef(): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TXN-${stamp}${rand}`;
  }

  findForAccount(accountId: string, params: { limit?: number; status?: TransactionStatus } = {}) {
    const { limit = 5, status } = params;
    return this.prisma.transaction.findMany({
      where: { accountId, status },
      orderBy: { postedAt: 'desc' },
      take: limit,
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
      include: { account: true },
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
      },
    });
  }
}
