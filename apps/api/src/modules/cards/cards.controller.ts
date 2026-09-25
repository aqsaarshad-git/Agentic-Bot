import { Controller, ForbiddenException, Get, Param } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { AccountsService } from '../accounts/accounts.service';
import { CardsService } from './cards.service';

@Controller('cards')
export class CardsController {
  constructor(
    private readonly cards: CardsService,
    private readonly accounts: AccountsService,
  ) {}

  @Get()
  async findAll(@CurrentUser() actor: AuthPrincipal) {
    if (actor.type !== 'customer') {
      throw new ForbiddenException('Specify a customer to view cards for');
    }
    const accounts = await this.accounts.findAllForCustomer(actor.sub);
    return this.cards.findForAccounts(accounts.map((a) => a.id));
  }

  @Get(':id')
  async findOne(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string) {
    if (actor.type === 'customer') {
      return this.cards.findOneForCustomer(id, actor.sub);
    }
    return this.cards.findOne(id);
  }
}
