import { Module } from '@nestjs/common';
import { CallsModule } from '../calls/calls.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { TtsModule } from '../../ai/tts/tts.module';
import { PstnCallService } from './pstn-call.service';
import { TelephonyWorkerGuard } from './telephony-worker.guard';
import { TelephonyController } from './telephony.controller';
import { TelephonyWorkerController } from './telephony-worker.controller';

@Module({
  imports: [CallsModule, OrchestratorModule, TtsModule],
  controllers: [TelephonyController, TelephonyWorkerController],
  providers: [PstnCallService, TelephonyWorkerGuard],
  exports: [PstnCallService],
})
export class TelephonyModule {}
