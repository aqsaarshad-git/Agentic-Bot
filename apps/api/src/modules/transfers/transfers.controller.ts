import { Controller, ForbiddenException, Get, Param } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { TransfersService } from './transfers.service';

@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Get()
  findAll(@CurrentUser() actor: AuthPrincipal) {
    if (actor.type !== 'customer') {
      throw new ForbiddenException('Specify a customer to view transfers for');
    }
    return this.transfers.findAllForCustomer(actor.sub);
  }

  @Get(':id')
  findOne(@CurrentUser() actor: AuthPrincipal, @Param('id') id: string) {
    if (actor.type !== 'customer') {
      throw new ForbiddenException('Specify a customer to view this transfer for');
    }
    return this.transfers.findOneForCustomer(id, actor.sub);
  }
}
