import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  findAllForCustomer(customerId: string) {
    return this.prisma.account.findMany({ where: { customerId }, orderBy: { openedAt: 'asc' } });
  }

  async findOne(id: string) {
    const account = await this.prisma.account.findUnique({ where: { id } });
    if (!account) {
      throw new NotFoundException(`Account ${id} not found`);
    }
    return account;
  }

  async findByAccountNumber(accountNumber: string) {
    const account = await this.prisma.account.findUnique({ where: { accountNumber } });
    if (!account) {
      throw new NotFoundException(`Account ${accountNumber} not found`);
    }
    return account;
  }

  /** Where a zero-arg account tool resolves when the customer isn't naming a specific account. */
  async getPrimaryAccount(customerId: string) {
    const accounts = await this.findAllForCustomer(customerId);
    if (accounts.length === 0) {
      throw new NotFoundException(`No account on file for customer ${customerId}`);
    }
    return accounts.find((a) => a.status === 'ACTIVE') ?? accounts[0];
  }

  /** Resolves an explicit accountId (staff, or a customer naming a specific account) or falls
   *  back to the primary account — always re-checking ownership for a customer session. */
  async resolveForCustomer(customerId: string, accountId?: string) {
    if (!accountId) {
      return this.getPrimaryAccount(customerId);
    }
    const account = await this.findOne(accountId);
    if (account.customerId !== customerId) {
      throw new NotFoundException(`Account ${accountId} not found`);
    }
    return account;
  }

  async assertOwned(accountId: string, customerId: string) {
    return this.resolveForCustomer(customerId, accountId);
  }

  async getLimits(accountId: string) {
    const account = await this.findOne(accountId);
    return {
      accountId: account.id,
      dailyTransferLimit: Number(account.dailyTransferLimit),
      dailyWithdrawalLimit: Number(account.dailyWithdrawalLimit),
      currency: account.currency,
    };
  }

  /** Applies a signed delta to balance/availableBalance inside the caller's transaction. */
  async adjustBalance(accountId: string, delta: number) {
    return this.prisma.account.update({
      where: { id: accountId },
      data: {
        balance: { increment: delta },
        availableBalance: { increment: delta },
      },
    });
  }
}
