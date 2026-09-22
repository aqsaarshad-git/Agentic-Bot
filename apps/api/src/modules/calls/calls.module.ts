import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { LiveKitModule } from '../../voice/livekit/livekit.module';
import { SttModule } from '../../ai/stt/stt.module';
import { TtsModule } from '../../ai/tts/tts.module';
import { LlmModule } from '../../ai/llm/llm.module';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';

@Module({
  imports: [ConversationsModule, OrchestratorModule, LiveKitModule, SttModule, TtsModule, LlmModule],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
