import { Body, Controller, Param, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { CallsService } from '../calls/calls.service';
import { PstnCallService } from './pstn-call.service';
import { TelephonyWorkerGuard } from './telephony-worker.guard';
import { InboundAnswerDto } from './dto/inbound-answer.dto';
import { WorkerTurnDto } from './dto/worker-turn.dto';

/**
 * Called BY the telephony worker (telephony-worker/worker.js, running on the FreeSWITCH box) —
 * never by a browser or normal API client. Authenticated by TelephonyWorkerGuard's shared
 * secret instead of a customer/staff JWT (hence @Public(), which skips the global JwtAuthGuard
 * entirely — see app.module.ts). Every route here is a thin pass-through into the exact same
 * CallsService/PstnCallService methods the browser call widget and POST /calls/dial-out already
 * use — PSTN calls placed this way produce identical Call/Conversation/CallTranscript history.
 */
@Public()
@UseGuards(TelephonyWorkerGuard)
@Controller('telephony/worker')
export class TelephonyWorkerController {
  constructor(
    private readonly callsService: CallsService,
    private readonly pstnCallService: PstnCallService,
  ) {}

  /** A call the worker didn't originate (i.e. inbound) has just been answered. */
  @Post('inbound-answer')
  inboundAnswer(@Body() dto: InboundAnswerDto) {
    return this.pstnCallService.handleInboundAnswer(dto.fromNumber, dto.toNumber, dto.providerCallUuid);
  }

  /** Is there a spoken opening line to play before the worker starts listening? */
  @Post('calls/:id/greeting')
  greeting(@Param('id') id: string) {
    return this.pstnCallService.getGreetingAudio(id);
  }

  /** Streamed as newline-delimited JSON (one line per event) rather than one buffered JSON
   *  object — see PstnCallService.streamTurnForPstn's doc comment for why: a long reply's audio
   *  can take tens of seconds longer to fully render than its first sentence, and the worker
   *  needs to start playing that first sentence immediately, not once everything is ready. */
  @Post('calls/:id/turn')
  async turn(@Param('id') id: string, @Body() dto: WorkerTurnDto, @Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', 'application/x-ndjson');
    // The worker now aborts its side of this request as soon as a barge-in cuts a reply short
    // (see telephony-worker/worker.js's processTurn) instead of always reading to the end — a
    // write to an already-closed response must not throw here, or one interrupted phone call
    // would take the whole API process down with it.
    res.on('error', () => undefined);
    const audio = Buffer.from(dto.audioBase64, 'base64');
    try {
      await this.pstnCallService.streamTurnForPstn(id, audio, (line) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(JSON.stringify(line) + '\n');
      });
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }) + '\n');
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  @Post('calls/:id/end')
  end(@Param('id') id: string) {
    return this.callsService.endCall(id);
  }
}
