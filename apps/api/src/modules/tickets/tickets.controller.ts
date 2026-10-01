import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { TicketStatus } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { TicketsService } from './tickets.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { UpdateTicketDto } from './dto/update-ticket.dto';
import { CreateTicketMessageDto } from './dto/create-ticket-message.dto';
import { RefundTicketDto } from './dto/refund-ticket.dto';

@Controller('tickets')
@UseGuards(RolesGuard)
@Roles('ADMIN', 'AGENT', 'SUPERVISOR')
export class TicketsController {
  constructor(private readonly ticketsService: TicketsService) {}

  @Post()
  @Audit('ticket.create')
  create(@Body() dto: CreateTicketDto) {
    return this.ticketsService.create(dto);
  }

  @Get()
  findAll(
    @Query('status') status?: TicketStatus,
    @Query('customerId') customerId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.ticketsService.findAll({
      status,
      customerId,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ticketsService.findOne(id);
  }

  @Patch(':id')
  @Audit('ticket.update')
  update(@Param('id') id: string, @Body() dto: UpdateTicketDto) {
    return this.ticketsService.update(id, dto);
  }

  @Post(':id/messages')
  @Audit('ticket.note_added')
  addMessage(
    @CurrentUser() actor: AuthPrincipal,
    @Param('id') id: string,
    @Body() dto: CreateTicketMessageDto,
  ) {
    return this.ticketsService.addMessage(id, 'AGENT', dto.content, actor.sub);
  }

  /** Issues a real, DB-backed refund against this case's linked transaction — never just a resolution note. */
  @Post(':id/refund')
  @Audit('ticket.refund')
  refund(@Param('id') id: string, @Body() dto: RefundTicketDto) {
    return this.ticketsService.refund(id, dto);
  }
}
