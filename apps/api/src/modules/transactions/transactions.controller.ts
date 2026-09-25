import { Controller, ForbiddenException, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { AccountsService } from '../accounts/accounts.service';
import { TransactionsService } from './transactions.service';

@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly accounts: AccountsService,
  ) {}

  @Get()
  async findAll(@CurrentUser() actor: AuthPrincipal, @Query('accountId') accountId?: string, @Query('limit') limit?: string) {
    let resolvedAccountId = accountId;
    if (actor.type === 'customer') {
      const account = resolvedAccountId ? await this.accounts.assertOwned(resolvedAccountId, actor.sub) : await this.accounts.getPrimaryAccount(actor.sub);
      resolvedAccountId = account.id;
    }
    if (!resolvedAccountId) {
      throw new ForbiddenException('accountId is required');
    }
    return this.transactions.findForAccount(resolvedAccountId, { limit: limit ? Number(limit) : undefined });
  }

  @Get(':id')
  async findOne(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string) {
    const transaction = await this.transactions.findByRef(id).catch(() => this.transactions.findOne(id));
    if (actor.type === 'customer') {
      return this.transactions.findByRefForCustomer(transaction.transactionRef, actor.sub);
    }
    return transaction;
  }
}
