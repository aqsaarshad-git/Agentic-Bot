import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { TicketsService } from './tickets.service';

/**
 * Customer-facing case/dispute viewing — deliberately separate from TicketsController, which is
 * staff-only (`@Roles('ADMIN','AGENT','SUPERVISOR')` at the class level). Identity always comes
 * from the JWT; a customer session only ever sees their own cases.
 */
@Controller('support/cases')
export class SupportCasesController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  findAll(@CurrentUser() actor: AuthPrincipal, @Query('status') status?: TicketStatus) {
    if (actor.type !== 'customer') {
      throw new ForbiddenException('Specify a customer to view cases for');
    }
    return this.tickets.findAllForCustomer(actor.sub, { status });
  }
}
