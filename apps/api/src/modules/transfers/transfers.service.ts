import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TransactionsService } from '../transactions/transactions.service';

const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
  ) {}

  findAllForCustomer(customerId: string, take = 20) {
    return this.prisma.transfer.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take });
  }

  async findOneForCustomer(id: string, customerId: string) {
    const transfer = await this.prisma.transfer.findUnique({ where: { id } });
    if (!transfer || transfer.customerId !== customerId) {
      throw new NotFoundException(`Transfer ${id} not found`);
    }
    return transfer;
  }

  private generateTransferReference(): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TRF-${stamp}${rand}`;
  }

  /**
   * Validates and creates a PENDING_CONFIRMATION transfer — never moves money. Supersedes any
   * other pending transfer already open on this conversation, so confirm_transfer can only ever
   * act on the ONE transfer this same conversation most recently proposed.
   */
  async proposeTransfer(params: {
    customerId: string;
    conversationId: string;
    fromAccountId: string;
    toAccountId?: string;
    beneficiaryId?: string;
    amount: number;
    reason?: string;
    verificationSessionId?: string;
  }) {
    if (params.amount <= 0) {
      throw new BadRequestException('Transfer amount must be greater than zero');
    }
    if (Boolean(params.toAccountId) === Boolean(params.beneficiaryId)) {
      throw new BadRequestException('Provide exactly one of a destination account or a saved beneficiary');
    }

    const fromAccount = await this.prisma.account.findUnique({ where: { id: params.fromAccountId } });
    if (!fromAccount || fromAccount.customerId !== params.customerId) {
      throw new NotFoundException('Source account not found');
    }
    if (fromAccount.status !== 'ACTIVE') {
      throw new BadRequestException(`Your account is ${fromAccount.status.toLowerCase()} and cannot send transfers`);
    }

    let toAccount = null;
    let beneficiary = null;
    if (params.toAccountId) {
      toAccount = await this.prisma.account.findUnique({ where: { id: params.toAccountId } });
      if (!toAccount) {
        throw new NotFoundException('Destination account not found');
      }
    } else if (params.beneficiaryId) {
      beneficiary = await this.prisma.beneficiary.findUnique({ where: { id: params.beneficiaryId } });
      if (!beneficiary || beneficiary.customerId !== params.customerId) {
        throw new NotFoundException('Beneficiary not found');
      }
      if (beneficiary.status !== 'ACTIVE') {
        throw new BadRequestException('This beneficiary is not currently active');
      }
    }

    if (params.amount > Number(fromAccount.availableBalance)) {
      throw new BadRequestException('Insufficient available balance for this transfer');
    }
    if (params.amount > Number(fromAccount.dailyTransferLimit)) {
      throw new BadRequestException(
        `This transfer exceeds your daily transfer limit of ${Number(fromAccount.dailyTransferLimit)} ${fromAccount.currency}`,
      );
    }

    const [, transfer] = await this.prisma.$transaction([
      this.prisma.transfer.updateMany({
        where: { conversationId: params.conversationId, status: 'PENDING_CONFIRMATION' },
        data: { status: 'SUPERSEDED' },
      }),
      this.prisma.transfer.create({
        data: {
          transferReference: this.generateTransferReference(),
          customerId: params.customerId,
          conversationId: params.conversationId,
          verificationSessionId: params.verificationSessionId,
          fromAccountId: fromAccount.id,
          toAccountId: toAccount?.id,
          beneficiaryId: beneficiary?.id,
          type: toAccount ? 'INTERNAL' : 'BENEFICIARY',
          amount: params.amount,
          currency: fromAccount.currency,
          reason: params.reason,
          confirmationExpiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
        },
      }),
    ]);

    return { transfer, fromAccount, toAccount, beneficiary };
  }

  /**
   * Claims and executes the ONE pending transfer open on this conversation. Deliberately takes
   * no identifying argument — it can only ever act on "whatever this conversation currently has
   * pending," which is what makes an unrelated earlier "yes" structurally unable to trigger a
   * transfer. Re-validates balance/limits fresh (not the value captured at propose time) to
   * close the TOCTOU window between propose and confirm.
   */
  async confirmAndExecute(customerId: string, conversationId: string) {
    const pending = await this.prisma.transfer.findFirst({
      where: { customerId, conversationId, status: 'PENDING_CONFIRMATION' },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) {
      throw new NotFoundException('No pending transfer to confirm');
    }

    if (pending.confirmationExpiresAt.getTime() < Date.now()) {
      await this.prisma.transfer.update({ where: { id: pending.id }, data: { status: 'EXPIRED' } });
      throw new BadRequestException('That transfer request has expired — please ask again to start a new one');
    }

    // Atomic claim: MySQL has no partial-unique-index equivalent, so the conditional UPDATE's
    // own atomicity (not a row lock) is what closes the double-confirm race.
    const claim = await this.prisma.transfer.updateMany({
      where: { id: pending.id, status: 'PENDING_CONFIRMATION', confirmationExpiresAt: { gt: new Date() } },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });
    if (claim.count !== 1) {
      const current = await this.prisma.transfer.findUnique({ where: { id: pending.id } });
      throw new BadRequestException(`That transfer is already ${current?.status.toLowerCase() ?? 'resolved'}`);
    }

    const amount = Number(pending.amount);
    const fromAccount = await this.prisma.account.findUniqueOrThrow({ where: { id: pending.fromAccountId } });
    if (amount > Number(fromAccount.availableBalance) || amount > Number(fromAccount.dailyTransferLimit)) {
      await this.prisma.transfer.update({
        where: { id: pending.id },
        data: { status: 'FAILED', failureReason: 'INSUFFICIENT_FUNDS' },
      });
      throw new BadRequestException('Insufficient available balance to complete this transfer now');
    }

    const transaction = await this.prisma.$transaction(async (prismaTx) => {
      await prismaTx.account.update({
        where: { id: pending.fromAccountId },
        data: { balance: { decrement: amount }, availableBalance: { decrement: amount } },
      });
      if (pending.toAccountId) {
        await prismaTx.account.update({
          where: { id: pending.toAccountId },
          data: { balance: { increment: amount }, availableBalance: { increment: amount } },
        });
      }
      const txn = await prismaTx.transaction.create({
        data: {
          transactionRef: this.transactions.generateTransactionRef(),
          accountId: pending.fromAccountId,
          type: 'DEBIT',
          channel: 'TRANSFER',
          amount,
          currency: pending.currency,
          status: 'COMPLETED',
          description: pending.reason ?? 'Transfer',
          settledAt: new Date(),
        },
      });
      await prismaTx.transfer.update({
        where: { id: pending.id },
        data: {
          status: 'COMPLETED',
          executedAt: new Date(),
          resultingTransactionId: txn.id,
          providerReference: `PRV-${txn.transactionRef}`,
        },
      });
      return txn;
    });

    return { transferReference: pending.transferReference, transaction };
  }

  async cancelPending(customerId: string, conversationId: string) {
    const pending = await this.prisma.transfer.findFirst({
      where: { customerId, conversationId, status: 'PENDING_CONFIRMATION' },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) {
      throw new NotFoundException('No pending transfer to cancel');
    }
    await this.prisma.transfer.update({ where: { id: pending.id }, data: { status: 'CANCELLED' } });
    return { cancelled: true, transferReference: pending.transferReference };
  }

  /** Used by the orchestrator to remind Qwen a pending transfer exists — never the security boundary itself. */
  async getActivePendingSummary(conversationId: string) {
    const pending = await this.prisma.transfer.findFirst({
      where: { conversationId, status: 'PENDING_CONFIRMATION', confirmationExpiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) return null;
    return { transferReference: pending.transferReference, amount: Number(pending.amount), currency: pending.currency };
  }

  async getRemainingDailyLimit(accountId: string) {
    const account = await this.prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todays = await this.prisma.transfer.aggregate({
      where: { fromAccountId: accountId, status: { in: ['COMPLETED', 'CONFIRMED'] }, createdAt: { gte: startOfDay } },
      _sum: { amount: true },
    });
    const usedToday = Number(todays._sum.amount ?? 0);
    const dailyTransferLimit = Number(account.dailyTransferLimit);
    return {
      dailyTransferLimit,
      usedToday,
      remainingToday: Math.max(0, dailyTransferLimit - usedToday),
      currency: account.currency,
    };
  }
}
