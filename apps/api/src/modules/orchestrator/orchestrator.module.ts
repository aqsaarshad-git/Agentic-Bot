import { Module } from '@nestjs/common';
import { LlmModule } from '../../ai/llm/llm.module';
import { ToolsModule } from '../tools/tools.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { AgentsModule } from '../agents/agents.module';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { VerificationModule } from '../verification/verification.module';
import { TransfersModule } from '../transfers/transfers.module';
import { StatementsModule } from '../statements/statements.module';
import { ContextBuilderService } from './context-builder.service';
import { CustomerMemoryService } from './customer-memory.service';
import { OrchestratorService } from './orchestrator.service';
import { OrchestratorController } from './orchestrator.controller';
import { ChatGateway } from './chat.gateway';

@Module({
  imports: [LlmModule, ToolsModule, ConversationsModule, AgentsModule, AuthModule, KnowledgeModule, VerificationModule, TransfersModule, StatementsModule],
  controllers: [OrchestratorController],
  providers: [OrchestratorService, ContextBuilderService, CustomerMemoryService, ChatGateway],
  exports: [OrchestratorService, ChatGateway],
})
export class OrchestratorModule {}
