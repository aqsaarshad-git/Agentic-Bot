import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { AccountsService } from './accounts.service';

/**
 * Read-only, customer-session-scoped by design: identity comes from the JWT (`actor.sub`), never
 * from a query/path param — a staff session (`actor.type === 'user'`) may pass an explicit
 * customerId query to look up any customer's accounts (matches the existing CustomersController
 * RBAC convention); a customer session always sees only their own, and a foreign :id 404s rather
 * than leaking whether it exists.
 */
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  findAll(@CurrentUser() actor: AuthPrincipal) {
    if (actor.type !== 'customer') {
      throw new NotFoundException('Specify a customer to view accounts for');
    }
    return this.accounts.findAllForCustomer(actor.sub);
  }

  @Get(':id')
  async findOne(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string) {
    const account = await this.accounts.findOne(id);
    if (actor.type === 'customer' && account.customerId !== actor.sub) {
      throw new NotFoundException(`Account ${id} not found`);
    }
    return account;
  }
}
