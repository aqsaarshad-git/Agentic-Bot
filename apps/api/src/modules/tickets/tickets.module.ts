import { Module } from '@nestjs/common';
import { TransactionsModule } from '../transactions/transactions.module';
import { TicketsController } from './tickets.controller';
import { SupportCasesController } from './support-cases.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [TransactionsModule],
  controllers: [TicketsController, SupportCasesController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
