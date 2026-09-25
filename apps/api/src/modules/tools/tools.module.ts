import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { TicketsModule } from '../tickets/tickets.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { CallbacksModule } from '../callbacks/callbacks.module';
import { AccountsModule } from '../accounts/accounts.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { CardsModule } from '../cards/cards.module';
import { BeneficiariesModule } from '../beneficiaries/beneficiaries.module';
import { TransfersModule } from '../transfers/transfers.module';
import { StatementsModule } from '../statements/statements.module';
import { VerificationModule } from '../verification/verification.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ToolsController } from './tools.controller';
import { ToolRegistryService } from './tool-registry.service';
import { ToolsService } from './tools.service';
import { toolDefinitionsProvider } from './tool-definitions.provider';

@Module({
  imports: [
    CustomersModule,
    TicketsModule,
    ConversationsModule,
    CallbacksModule,
    AccountsModule,
    TransactionsModule,
    CardsModule,
    BeneficiariesModule,
    TransfersModule,
    StatementsModule,
    VerificationModule,
    NotificationsModule,
  ],
  controllers: [ToolsController],
  providers: [ToolRegistryService, ToolsService, toolDefinitionsProvider],
  exports: [ToolRegistryService],
})
export class ToolsModule {}
