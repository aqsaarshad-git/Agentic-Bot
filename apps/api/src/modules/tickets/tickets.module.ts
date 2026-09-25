import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { SupportCasesController } from './support-cases.controller';
import { TicketsService } from './tickets.service';

@Module({
  controllers: [TicketsController, SupportCasesController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
