import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { TicketsModule } from '../tickets/tickets.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { CallbacksModule } from '../callbacks/callbacks.module';
import { ToolsController } from './tools.controller';
import { ToolRegistryService } from './tool-registry.service';
import { ToolsService } from './tools.service';
import { toolDefinitionsProvider } from './tool-definitions.provider';

@Module({
  imports: [CustomersModule, TicketsModule, ConversationsModule, CallbacksModule],
  controllers: [ToolsController],
  providers: [ToolRegistryService, ToolsService, toolDefinitionsProvider],
  exports: [ToolRegistryService],
})
export class ToolsModule {}
