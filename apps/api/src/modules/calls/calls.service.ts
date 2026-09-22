import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AuditActorType, CallDirection, CallTransport, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ConversationsService } from '../conversations/conversations.service';
import { OrchestratorService } from '../orchestrator/orchestrator.service';
import { ChatGateway } from '../orchestrator/chat.gateway';
import { LiveKitService } from '../../voice/livekit/livekit.service';
import { STT_PROVIDER, SttProvider } from '../../ai/stt/stt-provider.interface';
import { TTS_PROVIDER, TtsProvider, TtsResult } from '../../ai/tts/tts-provider.interface';
import { CustomerEmotion, EMOTION_TTS_STYLE, Sentiment, Urgency } from '../../ai/tts/emotion-style-map';
import { LLM_PROVIDER, LlmProvider } from '../../ai/llm/llm-provider.interface';

interface TranscriptSegment {
  role: 'customer' | 'ai';
  text: string;
  at: string;
}

/**
 * Everything worth knowing about how ONE turn's spoken language was resolved — added
 * 2026-09-15 specifically so real-call logs are self-sufficient for diagnosing language
 * behavior without needing to reproduce anything. Every field the language-fix task asked for
 * is here: previousConfirmedLanguage, sttMode (the `path` field alongside this), both
 * transcripts when the dual path ran, whether a switch was suspected/detected, and the judge's
 * own reasoning when it actually ran (as opposed to one of pickSpokenLanguage's cheaper
 * shortcuts — see decisionPath).
 */
interface LanguageResolutionDiagnostics {
  /** The language confirmed from an earlier turn THIS call, or null on turn one. */
  previousConfirmedLanguage: 'en' | 'ar' | null;
  /** Only meaningful when the fast path ran at all (previousConfirmedLanguage was non-null) —
   *  true means the fast path's own cheap self-check found a reason to doubt it and escalated
   *  to the full dual-transcribe+judge path. */
  suspectedSwitch: boolean;
  /** The fast path's own single-attempt transcript, when the fast path ran — present even when
   *  it went on to suspect a switch and escalate (so the log shows exactly what looked wrong). */
  fastPathText?: string;
  /** Present only when the dual-transcribe path actually ran (turn one, an empty fast-path
   *  attempt, or a suspected switch). */
  enText?: string;
  arText?: string;
  /** Which branch of pickSpokenLanguage actually decided the language, e.g. 'llm-judge',
   *  'arabic-attempt-has-no-arabic-script', 'english-attempt-empty' — 'llm-judge' is the only
   *  one where judgeReasoning below is populated; every other value means the real LLM judge
   *  call was skipped because a cheaper check already had a confident answer. */
  decisionPath?: string;
  /** The judge's own one-sentence reasoning — only populated when decisionPath is 'llm-judge'. */
  judgeReasoning?: string;
  /** True when previousConfirmedLanguage was non-null AND the final resolved language differs
   *  from it — i.e. a genuine mid-call language switch was actually detected and honored.
   *  Optional only because this object is built up incrementally as resolveTranscript runs —
   *  every actual `return` in that method fills both this and finalLanguage in before
   *  returning; never actually absent by the time a caller sees it. */
  switchDetected?: boolean;
  finalLanguage?: 'en' | 'ar';
}

/**
 * Serializes access to the shared GPU box's Cohere STT + VoxCPM2 TTS endpoints — confirmed
 * live (2026-09-09) that both are served by the SAME single-worker Flask app: firing a
 * /transcribe request while a /speak_stream response is still being read fails the /transcribe
 * call outright (connection-level failure, not a slow response), and the reverse is presumably
 * just as true. This matters far more now that TTS synthesis runs fully in the background
 * rather than blocking the turn's own HTTP response (see streamChunksIncremental) — a customer
 * talking again while the agent is still speaking is completely normal usage, not an edge
 * case, so without this queue that would routinely 503 the customer's own next turn's STT.
 * `run()` queues callers FIFO rather than letting them collide; combined with aborting a
 * superseded TTS stream early (see bumpGeneration below), a barge-in still gets the shared
 * endpoint back quickly instead of waiting out the full remaining reply.
 */
// REMOVED (2026-09-15, customer request): the pre-cached "One moment, let me check that for
// you" filler and its FILLER_TRIGGER_MS/FILLER_TEXT/messageMayNeedToolLookup gate are gone —
// the customer explicitly does not want it, regardless of how long a turn takes. Removing it
// does not change "time to first audio" for the real reply at all (the filler ran on its own
// independent timer against a separately pre-cached clip; it never gated, delayed, or fed the
// real STT->LLM->tool->TTS pipeline in any way) — a slow turn now simply goes back to silence
// until the real reply's audio is ready, exactly as it behaved before 2026-09-14. See
// OrchestratorService's onToolPreambleSpoken / recordSpokenPreamble below for the SEPARATE,
// real bug this investigation also turned up: Qwen itself can stream a few words of genuine
// preamble before deciding to call a tool, which used to be spoken but silently dropped from
// the transcript — that is now fixed at the source instead of being confused with this filler.

class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Bridges Qwen's streamed text deltas (pushed as they arrive, from OrchestratorService's
 * onTextDelta callback) into streamChunksIncremental's `for await` consumption, which expects
 * an AsyncIterable — this is what lets TTS synthesis start on the FIRST speakable chunk while
 * Qwen is still generating the rest of the reply, instead of waiting for the whole response
 * before any chunking/synthesis begins. Single-consumer only (streamChunksIncremental is the
 * only thing that ever reads from one of these).
 */
class TextChunkQueue implements AsyncIterable<string> {
  private items: string[] = [];
  private waiting: ((result: IteratorResult<string>) => void) | null = null;
  private closed = false;

  push(chunk: string): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: chunk, done: false });
    } else {
      this.items.push(chunk);
    }
  }

  /** No more chunks are coming — the consumer's `for await` loop ends once it drains
   *  whatever's already queued. */
  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as string, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: (): Promise<IteratorResult<string>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as string, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);

  // Tracks which "generation" of streamed reply is current per conversation, so a barge-in
  // (or a brand new turn starting while a previous long reply is still streaming its trailing
  // chunks in the background — see streamRemainingChunks) can make the OLD generation's loop
  // abandon itself instead of continuing to synthesize/broadcast audio nobody wants anymore.
  // This matters for more than correctness: /speak and /transcribe are both served by the same
  // single-concurrency Flask app on the shared GPU box, so an abandoned reply's trailing TTS
  // calls would otherwise keep competing with (and slowing down) the NEW turn's own STT/TTS
  // calls instead of just stopping.
  private readonly streamGeneration = new Map<string, number>();
  // The one in-flight streaming TTS request per conversation, if any — aborted the moment its
  // generation is superseded (see bumpGeneration), so the shared GPU box is freed up
  // immediately instead of finishing audio nobody wants anymore. See streamChunksIncremental.
  private readonly activeTtsAbort = new Map<string, AbortController>();
  // Every real call to the shared GPU box's STT/TTS endpoints — across every conversation —
  // funnels through this single queue. See the AsyncMutex doc comment above for why this has
  // to be a hard cross-provider serialization, not just a per-conversation one.
  private readonly gpuBoxQueue = new AsyncMutex();

  private bumpGeneration(conversationId: string): number {
    const next = (this.streamGeneration.get(conversationId) ?? 0) + 1;
    this.streamGeneration.set(conversationId, next);
    this.activeTtsAbort.get(conversationId)?.abort();
    return next;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly orchestrator: OrchestratorService,
    private readonly chatGateway: ChatGateway,
    private readonly liveKit: LiveKitService,
    @Inject(STT_PROVIDER) private readonly stt: SttProvider,
    @Inject(TTS_PROVIDER) private readonly tts: TtsProvider,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly auditService: AuditService,
  ) {}

  async startCall(customerId: string, direction: CallDirection, aiAgentId?: string, language?: 'ar' | 'en') {
    const resolvedLanguage = await this.resolveCustomerLanguage(customerId, language);
    const { call } = await this.createCallRecord({
      customerId,
      direction,
      aiAgentId,
      language: resolvedLanguage,
      transport: 'WEBRTC',
    });
    const roomName = call.liveKitRoomName!;

    let voiceSession: { roomName: string; participantToken: string } | undefined;
    let voiceTransportNote: string | undefined;
    if (this.liveKit.isConfigured()) {
      try {
        voiceSession = await this.liveKit.createSession(roomName, customerId);
      } catch (error) {
        voiceTransportNote = error instanceof Error ? error.message : String(error);
      }
    } else {
      voiceTransportNote =
        'Voice transport is not configured yet (LIVEKIT_URL/LIVEKIT_API_KEY/LIVEKIT_API_SECRET missing). ' +
        'Call and conversation records were created; use POST /calls/:id/turns to simulate spoken turns.';
    }

    return { call, voiceSession, voiceTransportNote };
  }

  /**
   * Places a real PSTN call's Call+Conversation rows (used by PstnCallService for both outbound
   * origination and inbound answer) — same underlying persistence as startCall's browser path,
   * just tagged with the SIP/telephony fields instead of a LiveKit room.
   */
  async startPstnCall(params: {
    customerId: string;
    direction: CallDirection;
    fromNumber: string;
    toNumber: string;
    providerCallUuid: string;
    aiAgentId?: string;
    language?: 'ar' | 'en';
  }) {
    const resolvedLanguage = await this.resolveCustomerLanguage(params.customerId, params.language);
    return this.createCallRecord({
      customerId: params.customerId,
      direction: params.direction,
      aiAgentId: params.aiAgentId,
      language: resolvedLanguage,
      transport: 'PSTN',
      fromNumber: params.fromNumber,
      toNumber: params.toNumber,
      providerCallUuid: params.providerCallUuid,
    });
  }

  /**
   * The STT provider has no auto-detect (see cohere-arabic-stt.provider.ts) — without an
   * explicit choice here it silently defaulted to "ar" for every call, which mis-transcribed
   * English speech into garbled Arabic text instead of failing loudly. Fall back to the
   * customer's own profile language only if the call itself didn't specify one.
   */
  private async resolveCustomerLanguage(customerId: string, language?: 'ar' | 'en'): Promise<'ar' | 'en'> {
    if (language) return language;
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { language: true } });
    return customer?.language === 'en' ? 'en' : 'ar';
  }

  private async createCallRecord(params: {
    customerId: string;
    direction: CallDirection;
    aiAgentId?: string;
    language: 'ar' | 'en';
    transport: CallTransport;
    liveKitRoomName?: string;
    fromNumber?: string;
    toNumber?: string;
    providerCallUuid?: string;
  }) {
    const conversation = await this.conversations.create({ customerId: params.customerId, aiAgentId: params.aiAgentId, channel: 'VOICE' });
    // Preserve the original room-naming convention (derived from the conversation, not knowable
    // until it's created) for the WEBRTC path; PSTN calls have no LiveKit room at all.
    const liveKitRoomName = params.transport === 'WEBRTC' ? params.liveKitRoomName ?? `call-${conversation.id}` : undefined;
    const call = await this.prisma.call.create({
      data: {
        customerId: params.customerId,
        aiAgentId: params.aiAgentId,
        conversationId: conversation.id,
        direction: params.direction,
        language: params.language,
        transport: params.transport,
        liveKitRoomName,
        fromNumber: params.fromNumber,
        toNumber: params.toNumber,
        providerCallUuid: params.providerCallUuid,
      },
    });
    return { call, conversation };
  }

  async handleTurn(callId: string, audio: Buffer, requestId?: string) {
    const turnStartedAt = Date.now();
    const call = await this.getCallOrThrow(callId);
    if (!call.conversationId) {
      throw new BadRequestException('Call has no linked conversation');
    }
    // A clear per-turn separator in the console, purely for human readability when a tester
    // copies a chunk of terminal output covering several turns of a real voice call back for
    // analysis — everything below this line up to the matching turn.http_response_ready line
    // belongs to the same turn.
    this.logger.log(`──── Turn start (call:${callId}, audio:${audio.length}b) ────`);
    // A brand new turn always supersedes whatever the previous one was still streaming —
    // bump immediately so a long reply's trailing chunks (still in flight in the background,
    // see streamRemainingChunks) stop themselves rather than racing this turn's own STT/TTS
    // calls on the shared single-concurrency endpoint.
    const generation = this.bumpGeneration(call.conversationId);

    // The STT provider has no auto-detect and only understands "ar"|"en" (see
    // cohere-arabic-stt.provider.ts) — asked in the wrong language it doesn't fail, it
    // hallucinates plausible-looking nonsense IN that language, so a single guess can't
    // always be trusted blindly. Turn ONE of every call still pays for the full
    // dual-transcribe-and-judge path (nothing is confirmed yet, and a customer's profile
    // default is just a guess — see the cold-start bug this was fixed for). From turn two
    // onward, though, paying for a second Cohere STT call AND an LLM judge call on every
    // single turn is wasted work in the common case where the customer just keeps speaking
    // whatever language they already confirmed — see resolveTranscript() below for the fast
    // single-call path used once a language is known, with a cheap same-result self-check
    // that still catches a genuine mid-call language switch (rare) and falls back to the full
    // dual-transcribe+judge path when it fires, rather than trusting a stale language forever.
    // A same-day variant that always compared both languages (catching a switch immediately
    // instead of within a turn or two) was tried and reverted at the user's request — the real
    // per-turn latency cost (every turn, not just occasionally) outweighed the reliability
    // gain; see resolveTranscript's own note for specifics.
    const hasPriorTurn = Boolean(await this.prisma.callTranscript.findUnique({ where: { callId: call.id } }));
    const knownLanguage = hasPriorTurn ? (call.language as 'en' | 'ar' | null) : null;
    // BUG FIX (2026-09-14, confirmed live): `call.language` already holds the account's own
    // profile default from the moment the call starts (see resolveCustomerLanguage) — genuinely
    // useful as a tie-breaker for a short, truly ambiguous turn-one greeting ("Hello" vs "ألو"
    // are both short and plausible; content alone can't always decide), which is exactly what
    // an existing comment inside pickSpokenLanguage already argued for. But it was never
    // actually reachable: `knownLanguage` above is deliberately null on turn one (correctly
    // gating the FAST PATH, which really must stay off until a language is confirmed), and that
    // same null was also being handed to the judge as "no hint at all." Separating "gates the
    // fast path" from "hint for the judge" fixes this without touching the fast-path gating.
    const accountDefaultLanguage: 'en' | 'ar' = call.language === 'ar' ? 'ar' : 'en';
    const sttStartedAt = Date.now();
    const { text: transcriptText, language: detectedLanguage, path: sttPath, diagnostics: langDiag } = await this.resolveTranscript(
      audio,
      knownLanguage,
      hasPriorTurn,
      accountDefaultLanguage,
      callId,
      requestId,
    );
    const sttDurationMs = Date.now() - sttStartedAt;
    // `sttPath` reflects which path ACTUALLY ran, not just which one was attempted first —
    // the fast path can internally fall back to a full dual-transcribe+judge mid-call (see
    // resolveTranscript's suspectedSwitch check), and logging `knownLanguage` alone here used
    // to mislabel those cases as "fast-single" even though a full judge call happened.
    await this.logLatency(requestId, call.id, 'latency.stt', sttDurationMs, {
      mode: sttPath,
      resolvedLanguage: detectedLanguage,
    });
    // 2026-09-15 language-fix task, requirement 7: ONE clear, complete record per turn of how
    // the spoken language was resolved — previously this information was scattered across
    // several separate `this.logger.log`/`warn` calls inside resolveTranscript/
    // pickSpokenLanguage (still there, for step-by-step tracing) with no single place a real
    // call's language behavior could be read from directly. This is that single place, both as
    // a structured audit-log entry (queryable later) and one readable console line (for
    // grepping raw terminal output from a real PSTN call).
    await this.logLatency(requestId, call.id, 'language.resolution', sttDurationMs, {
      previousConfirmedLanguage: langDiag.previousConfirmedLanguage,
      sttMode: sttPath,
      suspectedSwitch: langDiag.suspectedSwitch,
      fastPathText: langDiag.fastPathText,
      enText: langDiag.enText,
      arText: langDiag.arText,
      decisionPath: langDiag.decisionPath,
      judgeReasoning: langDiag.judgeReasoning,
      switchDetected: langDiag.switchDetected,
      finalLanguage: langDiag.finalLanguage,
    });
    this.logger.log(
      `[LANGUAGE] prevConfirmed=${langDiag.previousConfirmedLanguage ?? 'none (turn 1)'} mode=${sttPath} ` +
        `sttDurationMs=${sttDurationMs} suspectedSwitch=${langDiag.suspectedSwitch}` +
        (langDiag.fastPathText !== undefined ? ` fastPathText=${JSON.stringify(langDiag.fastPathText)}` : '') +
        (langDiag.enText !== undefined ? ` enText=${JSON.stringify(langDiag.enText)} arText=${JSON.stringify(langDiag.arText)}` : '') +
        (langDiag.decisionPath ? ` decisionPath=${langDiag.decisionPath}` : '') +
        (langDiag.judgeReasoning ? ` judgeReasoning=${JSON.stringify(langDiag.judgeReasoning)}` : '') +
        ` switchDetected=${langDiag.switchDetected} finalLanguage=${langDiag.finalLanguage}`,
    );
    if (!transcriptText) {
      // Both STT attempts came back with literally nothing (see resolveTranscript) — most
      // often a very short/quiet first utterance (e.g. a quick "hello" right as the call
      // connects, before much audio has accumulated). This used to return total silence: the
      // customer had no idea anything had happened and had to guess to just try again.
      // Confirmed live (2026-09-11) across several real calls, not limited to turn one — speak
      // a short "please repeat" prompt instead, the same way a human agent would ask someone
      // to repeat themselves over a bad line, reusing the exact same reply path a normal turn
      // uses (so PSTN's gain boost and the shared-GPU-box mutex both apply automatically).
      return this.speakClarification(call.id, call.conversationId, call.language, generation, requestId);
    }
    this.logger.log(`STT resolved (${sttPath}): ${detectedLanguage} -> ${JSON.stringify(transcriptText)}`);
    if (detectedLanguage !== call.language) {
      await this.prisma.call.update({ where: { id: call.id }, data: { language: detectedLanguage } });
    }

    // Broadcast what STT heard immediately — the LLM+TTS work below (this same call's
    // orchestrator round-trip + speech synthesis) is what actually takes real time, and the
    // customer should see confirmation of what they said well before that finishes, not
    // only once the whole turn (including audio) is ready.
    this.chatGateway.broadcast(call.conversationId, 'message', {
      sender: 'CUSTOMER',
      content: transcriptText,
    });
    // BUG FIX (2026-09-15): this segment used to only be appended at the very end of the turn,
    // together with the AI's reply (see the single appendTranscript call this used to be part
    // of, further down). Anything appended to the transcript mid-turn — e.g. a spoken tool
    // preamble, see recordSpokenPreamble below — would otherwise land BEFORE this customer
    // segment in transcript order, even though it's a reaction to what the customer just said:
    // a reader would see "AI: ...checking..." appear before "Customer: what's my balance?",
    // which reads backwards. Appending the customer's segment now, right alongside the
    // broadcast above (both reflect the same "STT just finished" moment), keeps transcript
    // order matching real speaking order regardless of what else gets appended mid-turn.
    await this.appendTranscript(call.id, [{ role: 'customer', text: transcriptText, at: new Date().toISOString() }]);

    // STT and the LLM reply already succeeded by this point — a TTS hiccup (transient network
    // blip, the shared GPU box being briefly unreachable, etc.) must NOT throw away a reply
    // that's already fully computed. Confirmed live: before this fix, a failed synthesize()
    // call threw, the whole request 500'd, and the customer got nothing at all — not even the
    // text — despite the AI already knowing the answer. Degrade to a text-only turn instead:
    // the frontend already shows result.reply in the transcript whenever it's present,
    // audioBase64 or not, so this doesn't need any client-side change to work.
    //
    // Delivery modes, chosen by provider capability (checked BEFORE the orchestrator call
    // below, since Qwen-streamed text — if it happens — needs somewhere to go the moment it
    // starts arriving, not only once the whole reply is known):
    //  - Qwen streaming (LlmProvider.generateStream) + VoxCPM2 streaming (TtsProvider.
    //    synthesizeStream) together: the best case. TTS starts on the reply's first sentence
    //    while Qwen is still generating the rest — see extractSpeakableChunk/TextChunkQueue.
    //    Only possible when the TTS side can ALSO stream (no point handing early text to a
    //    provider that can only synthesize a complete utterance at once).
    //  - VoxCPM2 streaming only (Qwen streaming unavailable, or it fails for this turn — see
    //    OrchestratorService.HandleMessageResult.replyWasStreamed): the same behavior this
    //    already had before Qwen streaming existed — wait for the complete reply, then split
    //    and stream it chunk by chunk.
    //  - Neither: original fallback — await the first chunk's full WAV, return it inline,
    //    stream any remaining chunks in the background.
    const audioStreaming = typeof this.tts.synthesizeStream === 'function';
    let chunkQueue: TextChunkQueue | undefined;
    let onTextDelta: ((delta: string) => void) | undefined;
    const emotionRef = { current: 'neutral' as CustomerEmotion };
    let speakableBuffer = '';
    let chunksPushed = 0;
    let firstSpeakableLoggedAt: number | null = null;

    if (audioStreaming) {
      chunkQueue = new TextChunkQueue();
      onTextDelta = (delta: string) => {
        speakableBuffer += delta;
        let extracted = extractSpeakableChunk(speakableBuffer, chunksPushed === 0);
        while (extracted) {
          if (firstSpeakableLoggedAt === null) {
            firstSpeakableLoggedAt = Date.now();
            this.logLatency(requestId, call.id, 'latency.first_speakable_text', firstSpeakableLoggedAt - turnStartedAt).catch(() => {});
          }
          chunkQueue!.push(stripMarkdownForSpeech(extracted.chunk));
          chunksPushed++;
          speakableBuffer = extracted.remainder;
          extracted = extractSpeakableChunk(speakableBuffer, chunksPushed === 0);
        }
      };
      // Starts consuming immediately, detached from this request — synthesis begins on chunk
      // 1 the moment onTextDelta above pushes it, which can be WHILE the orchestrator call
      // below is still running (mid tool-calling loop's final, text-generating iteration).
      this.streamChunksIncremental(call.id, call.conversationId, chunkQueue, emotionRef, generation, requestId, turnStartedAt);
    }

    const result = await this.orchestrator.handleIncomingMessage({
      conversationId: call.conversationId,
      customerId: call.customerId,
      content: transcriptText,
      requestId,
      callId: call.id,
      isVoiceChannel: true,
      onTextDelta,
      // BUG FIX (2026-09-15 — "heard something the transcript doesn't show"): Qwen can stream
      // a few words of genuine preamble before deciding to call a tool (confirmed live: it
      // doesn't always, but sometimes does) — those words were already being spoken via
      // onTextDelta/chunkQueue above like any other reply text, but silently dropped from the
      // transcript once the same iteration turned out to carry tool_calls (see
      // OrchestratorService's tool-loop and QwenProvider.generateStream's return value, which
      // discards accumulated content whenever tool_calls are present). Rather than delaying/
      // buffering streamed text to try to predict a tool call before it happens (which would
      // cost real latency on every turn to guard against an intermittent case), this just makes
      // sure whatever DOES get spoken is always reflected in the transcript — zero added delay,
      // since the audio has already gone out by the time this fires.
      // Non-null assertion: guarded at the top of this method (`if (!call.conversationId) throw`)
      // — TS narrowing doesn't extend into this closure, but the invariant still holds.
      onToolPreambleSpoken: (text) => this.recordSpokenPreamble(call.id, call.conversationId!, text),
      // The STT pipeline above already determined this far more carefully than a raw
      // Arabic-script regex on the (possibly imperfectly transcribed) text ever could — see
      // HandleMessageParams.knownLanguage's doc comment for the bug this fixes.
      knownLanguage: detectedLanguage,
    });
    // Classification (which decides the emotion) races the reply itself and, for a
    // Qwen-streamed reply, essentially never finishes before the FIRST chunk is already being
    // spoken — see the class doc comment on streamChunksIncremental. Updating the ref in place
    // once it resolves means any chunk not yet dispatched at that point still gets properly
    // toned; earlier chunks already handed to TTS keep whatever they were synthesized with
    // (neutral). A real but minor, deliberate trade-off — the alternative (waiting for
    // classification before starting TTS at all) would defeat the point of streaming.
    //
    // BEHAVIOR CHANGE (2026-09-14, customer-approved latency fix): `result` itself no longer
    // guarantees classification is done by the time handleIncomingMessage resolves (it used to
    // block internally on this) — result.emotion here is just the safe neutral default. The
    // real value now arrives via this promise, whenever it actually finishes; never rejects.
    result.classification.then((c) => { emotionRef.current = c.emotion; }).catch(() => {});

    // The customer's detected emotion is never mirrored back at them (an angry customer
    // should hear a calm, de-escalating agent, not an angry one) — EMOTION_TTS_STYLE is the
    // single place that decides the agent's spoken tone from it. VoxCpm2TtsProvider is the
    // only place that actually combines this with the reply text.
    let audioBase64: string | null = null;
    let audioFormat: string | undefined;
    let hasMoreAudio = false;
    // Safe neutral defaults (matching `result`'s own synchronous placeholders) — replaced with
    // the real classification below ONLY on the non-streaming fallback path, which already
    // does one fully-blocking TTS call with no per-chunk update opportunity, so there's no
    // streaming benefit to protect there and no reason not to use the real value once known.
    let finalEmotion: CustomerEmotion = result.emotion;
    let finalSentiment: Sentiment = result.sentiment;
    let finalUrgency: Urgency = result.urgency;

    if (audioStreaming && chunkQueue) {
      if (result.replyWasStreamed) {
        // Whatever's left in the buffer — typically a final sentence with no trailing
        // punctuation before Qwen's stream ended — still needs to be spoken. For a very short
        // reply (e.g. "Yes."), this is the ENTIRE reply — extractSpeakableChunk never crosses
        // its size threshold mid-stream, so nothing gets pushed until this exact flush point.
        if (speakableBuffer.trim()) {
          if (firstSpeakableLoggedAt === null) {
            // Wasn't logged during streaming (see above) — this flush IS the first speakable
            // text for this turn, so the metric should still reflect that instead of being
            // silently absent for short replies.
            firstSpeakableLoggedAt = Date.now();
            await this.logLatency(requestId, call.id, 'latency.first_speakable_text', firstSpeakableLoggedAt - turnStartedAt);
          }
          chunkQueue.push(stripMarkdownForSpeech(speakableBuffer.trim()));
        }
      } else {
        // Qwen streaming wasn't used for this turn's final reply (the provider doesn't
        // support it, or OrchestratorService's own fallback kicked in — see
        // LlmProvider.generateStream) — nothing was ever pushed via onTextDelta, so feed the
        // queue the complete reply the exact same way this worked before Qwen streaming
        // existed. Markdown stripped for SPEECH only — the stored transcript and on-screen
        // text below still get the original result.reply.
        for (const chunk of splitIntoSpeechChunks(stripMarkdownForSpeech(result.reply))) {
          chunkQueue.push(chunk);
        }
      }
      chunkQueue.close();
    } else {
      // No streaming benefit to protect on this fallback path (the whole reply is synthesized
      // in one blocking call below regardless) — awaiting the real classification here costs
      // nothing extra in practice and keeps this path's tone/analytics accurate, unlike the
      // streaming path above where waiting would defeat the point of streaming.
      const classification = await result.classification;
      finalEmotion = classification.emotion;
      finalSentiment = classification.sentiment;
      finalUrgency = classification.urgency;

      const chunks = splitIntoSpeechChunks(stripMarkdownForSpeech(result.reply));
      const [firstChunk, ...restChunks] = chunks;
      const ttsStartedAt = Date.now();
      let ttsResult: TtsResult | null = null;
      try {
        ttsResult = await this.gpuBoxQueue.run(() =>
          this.tts.synthesize(firstChunk, { styleInstruction: EMOTION_TTS_STYLE[finalEmotion] }),
        );
      } catch (error) {
        this.logger.warn(`TTS failed for this turn, delivering text-only: ${error instanceof Error ? error.message : error}`);
      }
      await this.logLatency(requestId, call.id, 'latency.tts', Date.now() - ttsStartedAt, {
        mode: 'non-streaming-fallback',
        chunkIndex: 0,
        totalChunks: chunks.length,
        chunkChars: firstChunk.length,
      });
      if (ttsResult) {
        await this.logLatency(requestId, call.id, 'latency.time_to_first_audio', Date.now() - turnStartedAt, {
          mode: 'non-streaming-fallback',
        });
        audioBase64 = ttsResult.audio.toString('base64');
        audioFormat = ttsResult.format;
        hasMoreAudio = restChunks.length > 0;
        if (hasMoreAudio) {
          this.streamRemainingChunks(call.conversationId, restChunks, finalEmotion, generation);
        }
      }
    }

    // The customer's own segment for this turn was already appended right after STT resolved
    // (see above) — only the AI's real reply is appended here now.
    await this.appendTranscript(call.id, [{ role: 'ai', text: result.reply, at: new Date().toISOString() }]);

    if (result.state === 'ESCALATING') {
      await this.prisma.call.update({ where: { id: call.id }, data: { escalationStatus: 'ESCALATED' } });
    }

    // The agent itself decided the conversation is over (the `end_call` tool, e.g. once the
    // customer says something like "okay thanks, that's it") — finalize the Call record here
    // rather than waiting for the customer to press "End Call" themselves, since there's no
    // reason to leave a call sitting open once both sides are done. The final goodbye
    // reply/audio below still gets delivered normally; only the bookkeeping happens now.
    if (result.state === 'CALL_ENDED') {
      await this.endCall(call.id);
    }

    // The HTTP response is ready NOW — this is "time to first audio" minus whatever the TTS
    // engine's own time-to-first-byte adds (see the separate latency.tts log, logged
    // asynchronously once streaming actually starts producing bytes). Matches the
    // "──── Turn start" line above so a tester can see exactly how long one full turn's
    // STT+LLM phase took, straight from the terminal.
    this.logger.log(
      `[LATENCY] turn.http_response_ready = ${Date.now() - turnStartedAt}ms (call:${callId})` +
        `${audioStreaming ? ' — audio streaming separately, see latency.tts below' : ' — audio included inline'}`,
    );

    return {
      transcript: transcriptText,
      reply: result.reply,
      state: result.state,
      emotion: finalEmotion,
      sentiment: finalSentiment,
      urgency: finalUrgency,
      audioBase64,
      audioFormat,
      // True when audio for this turn is being delivered incrementally over the socket
      // ('audio-stream-start'/'audio-stream-chunk'/'audio-stream-end') instead of inline —
      // the client must not expect audioBase64 to ever be populated for this turn.
      audioStreaming,
      // Tells the client whether to expect more 'audio-chunk' socket events for this same
      // turn before treating it as fully delivered (e.g. before hanging up on CALL_ENDED).
      // Always false in streaming mode — 'audio-stream-end' is the equivalent signal there.
      hasMoreAudio,
    };
  }

  /**
   * Speaks a short, fixed, non-LLM-generated reply (currently only "please repeat that" — see
   * handleTurn's empty-transcript branch) through the exact same delivery path a normal reply
   * uses, rather than a bespoke one-off, so it automatically gets PSTN's segment gain boost
   * (streamChunksIncremental → the caller's own flushSegment) and the shared-GPU-box mutex,
   * and so the caller (PstnCallService/the browser widget) doesn't need any special-casing —
   * this returns the exact same shape handleTurn always returns.
   */
  private async speakClarification(
    callId: string,
    conversationId: string,
    language: string | null,
    generation: number,
    requestId: string | undefined,
  ) {
    const text = language === 'ar' ? 'عذرًا، لم أسمعك بوضوح. هل يمكنك تكرار ما قلته؟' : "Sorry, I didn't quite catch that — could you say that again?";
    const audioStreaming = typeof this.tts.synthesizeStream === 'function';
    let audioBase64: string | null = null;
    let audioFormat: string | undefined;

    if (audioStreaming) {
      const chunkQueue = new TextChunkQueue();
      const emotionRef = { current: 'neutral' as CustomerEmotion };
      this.streamChunksIncremental(callId, conversationId, chunkQueue, emotionRef, generation, requestId, Date.now());
      chunkQueue.push(text);
      chunkQueue.close();
    } else {
      const ttsResult = await this.gpuBoxQueue.run(() => this.tts.synthesize(text)).catch(() => null);
      if (ttsResult) {
        audioBase64 = ttsResult.audio.toString('base64');
        audioFormat = ttsResult.format;
      }
    }

    return {
      transcript: '',
      reply: text,
      state: null,
      emotion: 'neutral' as CustomerEmotion,
      audioBase64,
      audioFormat,
      audioStreaming,
      hasMoreAudio: false,
    };
  }

  /**
   * BUG FIX (2026-09-15 — "heard something the transcript doesn't show"): called by
   * OrchestratorService whenever a tool-calling iteration streamed some real text (via
   * onTextDelta, same as any other reply text — already spoken through the normal
   * chunkQueue/streamChunksIncremental path by the time this fires) before the model actually
   * committed to calling a tool. That text was previously discarded entirely once
   * QwenProvider.generateStream() saw tool_calls appear later in the same response stream —
   * spoken to the customer in real time, but invisible afterward in both the live transcript
   * view and the persisted CallTranscript. Broadcasts and persists it the exact same way the
   * customer's own message already is, so the transcript always matches what was actually said,
   * with no effect on when that audio was originally spoken (it already happened by now).
   */
  private async recordSpokenPreamble(callId: string, conversationId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.chatGateway.broadcast(conversationId, 'message', { sender: 'AI', content: trimmed });
    await this.appendTranscript(callId, [{ role: 'ai', text: trimmed, at: new Date().toISOString() }]).catch((error) => {
      this.logger.warn(`Failed to append spoken tool-preamble to call transcript: ${error instanceof Error ? error.message : error}`);
    });
  }

  /**
   * True incremental TTS delivery (see the TtsProvider.synthesizeStream doc comment): for
   * each text chunk, in order (the shared TTS endpoint isn't safe to call concurrently, same
   * constraint as STT), opens a streaming synthesis request and forwards every raw PCM chunk
   * to the call's socket room the moment VoxCPM2 produces it — never buffering a whole
   * chunk's audio before sending any of it. Runs detached from the HTTP response (fire and
   * forget from handleTurn's point of view), which is what lets that response return the
   * instant the reply TEXT is ready instead of waiting on any audio at all.
   *
   * `chunks` is an AsyncIterable rather than a plain array so the SAME consumption/broadcast
   * logic serves two different producers: the existing full-reply-then-split path (an array,
   * wrapped as a trivial async iterable) and the new Qwen-streaming path (a TextChunkQueue fed
   * dynamically as text arrives — see handleTurn). `emotionRef` is a mutable ref rather than a
   * plain value for the same reason: for the Qwen-streaming path, the emotion classification
   * (a separate LLM call) typically isn't done yet when the FIRST chunk is ready to speak — it
   * starts at 'neutral' and gets updated in place once classification resolves, so at least
   * later chunks of a multi-chunk reply still get proper tone styling.
   */
  private async streamChunksIncremental(
    callId: string,
    conversationId: string,
    chunks: AsyncIterable<string>,
    emotionRef: { current: CustomerEmotion },
    generation: number,
    requestId: string | undefined,
    turnStartedAt: number,
  ): Promise<void> {
    let formatAnnounced = false;
    let firstByteLogged = false;
    let chunkIndex = 0;
    try {
      for await (const chunkText of chunks) {
        const thisChunkIndex = chunkIndex++;
        if (this.streamGeneration.get(conversationId) !== generation) return;

        // The WHOLE lifecycle of this chunk's request — opening the stream AND draining every
        // PCM chunk from it — has to sit inside ONE mutex section, not just the opening call:
        // the shared GPU box can't serve a second request while this one's response is still
        // being read, so releasing the queue early (e.g. right after synthesizeStream()
        // resolves) would let a queued STT/TTS call collide with the rest of this very stream.
        const abortController = new AbortController();
        this.activeTtsAbort.set(conversationId, abortController);
        const chunkRequestStartedAt = Date.now();
        // AUDIT INSTRUMENTATION ONLY (2026-09-10 latency audit — no behavior change): the
        // existing latency.tts/time_to_first_audio pair only ever fires for chunk 0 of the
        // whole turn (firstByteLogged is scoped above this loop). chunkFirstByteAt/pcmGapStats
        // below add PER-CHUNK visibility — every chunk's own TTFB, and the gaps between its
        // individual PCM packets — without touching what's already logged for chunk 0.
        let chunkFirstByteAt: number | null = null;
        let pcmPacketCount = 0;
        let pcmMaxGapMs = 0;
        let pcmLastAt = chunkRequestStartedAt;
        try {
          await this.gpuBoxQueue.run(async () => {
            const stream = await this.tts.synthesizeStream!(
              chunkText,
              { styleInstruction: EMOTION_TTS_STYLE[emotionRef.current] },
              abortController.signal,
            );
            if (!formatAnnounced) {
              this.chatGateway.broadcast(conversationId, 'audio-stream-start', { format: stream.format });
              formatAnnounced = true;
            }
            for await (const pcmChunk of stream.chunks) {
              if (this.streamGeneration.get(conversationId) !== generation) return;
              const pcmNow = Date.now();
              if (chunkFirstByteAt === null) {
                chunkFirstByteAt = pcmNow;
                await this.logLatency(requestId, callId, 'latency.tts_chunk', pcmNow - chunkRequestStartedAt, {
                  chunkIndex: thisChunkIndex,
                  chunkChars: chunkText.length,
                });
              } else {
                pcmMaxGapMs = Math.max(pcmMaxGapMs, pcmNow - pcmLastAt);
              }
              pcmPacketCount++;
              pcmLastAt = pcmNow;
              if (!firstByteLogged) {
                firstByteLogged = true;
                const now = pcmNow;
                // Chunk-relative: how long THIS chunk's own synthesis took to produce its
                // first byte — supersedes the old latency.tts meaning ("how long the first
                // WHOLE chunk took to render") now that audio starts playing well before that.
                await this.logLatency(requestId, callId, 'latency.tts', now - chunkRequestStartedAt, {
                  mode: 'streaming-ttfb',
                  chunkIndex: thisChunkIndex,
                  chunkChars: chunkText.length,
                });
                // Turn-relative: the number the whole Qwen-streaming feature exists to
                // improve — from the moment the customer's audio was fully received (before
                // STT even started) to the first audible byte of the reply.
                await this.logLatency(requestId, callId, 'latency.time_to_first_audio', now - turnStartedAt, {
                  mode: 'streaming',
                });
              }
              this.chatGateway.broadcast(conversationId, 'audio-stream-chunk', { pcmBase64: pcmChunk.toString('base64') });
            }
            // AUDIT INSTRUMENTATION ONLY — console, not DB (could be dozens of PCM packets per
            // chunk; a DB row per packet would be spam). Answers "are PCM packets trickling in
            // with real gaps (buffering/silence risk) or arriving in one burst after the TTS
            // engine already rendered the whole chunk internally."
            this.logger.log(
              `[LATENCY] chunk ${thisChunkIndex} pcm: ${pcmPacketCount} packets, max inter-packet gap ${pcmMaxGapMs}ms (call:${callId})`,
            );
            // Marks exactly when THIS chunk's PCM is fully delivered — a browser client doesn't
            // need this (it just keeps consuming one continuous stream), but it's what lets a
            // non-streaming consumer (PstnCallService, for a real phone call — see
            // handleTurnForPstn/streamTurnForPstn) start playing chunk 0 the moment it's ready
            // instead of waiting for the whole multi-chunk reply, which for a long reply can
            // take tens of seconds longer than the first chunk alone.
            this.chatGateway.broadcast(conversationId, 'audio-stream-chunk-end', { chunkIndex: thisChunkIndex });
          });
        } catch (error) {
          if (abortController.signal.aborted) return; // Superseded — bumpGeneration already handled it, nothing more to do.
          this.logger.warn(`TTS streaming failed on chunk ${thisChunkIndex}, ending stream: ${error instanceof Error ? error.message : error}`);
          if (this.streamGeneration.get(conversationId) === generation) {
            this.chatGateway.broadcast(conversationId, 'audio-stream-end', { error: true });
          }
          return;
        } finally {
          if (this.activeTtsAbort.get(conversationId) === abortController) {
            this.activeTtsAbort.delete(conversationId);
          }
        }
      }
      if (this.streamGeneration.get(conversationId) === generation) {
        this.chatGateway.broadcast(conversationId, 'audio-stream-end', {});
        // Full duration from turn start to "all audio for this reply has finished streaming"
        // — not the customer-perceived TTFA (see the latency.time_to_first_audio log above
        // for that), but useful for a tester to see how long total playback for a reply took.
        await this.logLatency(requestId, callId, 'latency.tts_full_stream', Date.now() - turnStartedAt, {
          totalChunks: chunkIndex,
        });
      }
    } catch (error) {
      this.logger.warn(`Unexpected error streaming TTS audio: ${error instanceof Error ? error.message : error}`);
      if (this.streamGeneration.get(conversationId) === generation) {
        this.chatGateway.broadcast(conversationId, 'audio-stream-end', { error: true });
      }
    }
  }

  /** Synthesizes the trailing chunks of a long reply one at a time (in order — the shared TTS
   *  endpoint isn't safe to call concurrently, same constraint as STT) and streams each one to
   *  the call's socket room as it's ready, so playback can continue seamlessly once the first
   *  (already-returned) chunk finishes, instead of the customer waiting through the whole
   *  reply's synthesis time up front. Fallback path only — used when the active TTS provider
   *  doesn't implement synthesizeStream(); see streamChunksIncremental for the real streaming
   *  path. */
  private streamRemainingChunks(conversationId: string, chunks: string[], emotion: CustomerEmotion, generation: number): void {
    (async () => {
      for (let i = 0; i < chunks.length; i++) {
        // Superseded by a barge-in or a brand new turn (see bumpGeneration) — stop quietly.
        // No 'isLast' sentinel needed: the client already abandoned this reply's audio queue
        // the moment it interrupted, so there's nothing left waiting on one.
        if (this.streamGeneration.get(conversationId) !== generation) return;
        try {
          const ttsResult = await this.gpuBoxQueue.run(() =>
            this.tts.synthesize(chunks[i], { styleInstruction: EMOTION_TTS_STYLE[emotion] }),
          );
          if (this.streamGeneration.get(conversationId) !== generation) return;
          this.chatGateway.broadcast(conversationId, 'audio-chunk', {
            audioBase64: ttsResult.audio.toString('base64'),
            audioFormat: ttsResult.format,
            isLast: i === chunks.length - 1,
          });
        } catch (error) {
          this.logger.warn(`Failed to synthesize a trailing speech chunk: ${error instanceof Error ? error.message : error}`);
          if (this.streamGeneration.get(conversationId) !== generation) return;
          // Tell the client not to wait for anything further rather than leave it hanging on
          // a chunk that's never coming.
          this.chatGateway.broadcast(conversationId, 'audio-chunk', { audioBase64: null, isLast: true });
          return;
        }
      }
    })().catch(() => {});
  }

  /**
   * Resolves one utterance's transcript, taking the fast single-STT-call path whenever the
   * call's language is already known (confirmed by an earlier turn this call) and falling
   * back to the full dual-transcribe-and-judge path otherwise (turn one of every call, or
   * whenever the fast path's own self-check below smells a real mid-call language switch).
   */
  private async resolveTranscript(
    audio: Buffer,
    knownLanguage: 'en' | 'ar' | null,
    hasPriorTurn: boolean,
    accountDefaultLanguage: 'en' | 'ar',
    callId?: string,
    requestId?: string,
  ): Promise<{
    text: string;
    language: 'en' | 'ar';
    path: 'fast-single' | 'dual-transcribe+judge';
    diagnostics: LanguageResolutionDiagnostics;
  }> {
    // 2026-09-15 language-resolution logging fix: accumulated as the method runs and returned
    // alongside the normal result so handleTurn can log ONE clear, complete picture per turn
    // (previous confirmed language, STT mode, both transcripts when dual ran, suspected-switch
    // flag, judge reasoning, and whether a switch was actually detected) — see
    // LanguageResolutionDiagnostics's own doc comment.
    const diagnostics: LanguageResolutionDiagnostics = {
      previousConfirmedLanguage: knownLanguage,
      suspectedSwitch: false,
    };
    // REVERTED (2026-09-11): a same-day "always compare both languages, every turn" redesign
    // lived here briefly to catch a mid-call switch immediately instead of within a turn or
    // two — confirmed working (verified via audit-log evidence: unambiguous turns correctly
    // skipped the judge and still took ~1.8s; ambiguous ones correctly paid for it at
    // ~3.4-4.3s) but the real per-turn latency cost was materially worse than estimated when
    // proposing it, and was reverted at the user's explicit request rather than accepted as a
    // permanent tradeoff. Back to: trust a single forced-language STT call once a language is
    // "known" (confirmed by an earlier turn this call), falling back to the full
    // dual-transcribe-and-judge path only for turn one or when the self-check below suspects a
    // switch. This reopens the same blind spot noted at the time (a switch that Cohere
    // mis-hears as fluent, correctly-scripted, but wrong-language text — e.g. a Latin
    // transliteration of Arabic audio, or a fabricated English sentence — isn't guaranteed to
    // be caught on the very next turn) — a conscious, reverted-back tradeoff, not an oversight.
    //
    // BUG FIX (2026-09-14, confirmed live): `languageUnderSuspicion` tracks whether we're
    // escalating to the dual path specifically BECAUSE the cheap self-check below found
    // concrete evidence against the currently confirmed language (as opposed to turn one, or
    // an empty attempt, where nothing concrete contradicts it) — passed to pickSpokenLanguage
    // so it can stop leaning toward that same language when judging. Confirmed live: an
    // English speaker's short ambiguous utterance got wrongly judged Arabic once, and every
    // later re-verification kept re-confirming Arabic — not because the customer's speech
    // stopped being evidence, but because the judge prompt itself said "lean toward the
    // already-confirmed language" every single time, turning one bad guess into a permanent
    // lock with no way out. That hint is genuinely useful for STABILITY when nothing actually
    // contradicts the confirmed language (don't let one weird utterance flip a call that's
    // otherwise fine) — it's actively counterproductive in the one case where the self-check
    // already found a real reason to doubt it.
    let languageUnderSuspicion = false;
    if (knownLanguage) {
      // AUDIT INSTRUMENTATION ONLY (2026-09-14 latency audit — no behavior change): same
      // queue-wait/call-duration breakdown as the dual path below, so the fast path's own
      // ~620ms average can be sanity-checked against real numbers too.
      const enqueuedAt = Date.now();
      const result = await this.gpuBoxQueue
        .run(async () => {
          const queueWaitMs = Date.now() - enqueuedAt;
          const callStartedAt = Date.now();
          const r = await this.stt.transcribe(audio, { language: knownLanguage });
          return { r, queueWaitMs, callMs: Date.now() - callStartedAt };
        })
        .catch((error) => {
          this.logger.warn(`${knownLanguage.toUpperCase()} STT attempt failed: ${error instanceof Error ? error.message : error}`);
          return null;
        });
      this.logger.log(
        `[LATENCY] fast-path STT breakdown: queueWait=${result?.queueWaitMs ?? 'n/a'}ms call=${result?.callMs ?? 'n/a'}ms`,
      );
      let text = result?.r.text ?? '';
      if (isKnownSttHallucination(text)) {
        this.logger.warn(`Fast STT path got a known stock-hallucination transcript (forced ${knownLanguage}) — discarding it as if empty`);
        text = '';
      }
      if (containsNonSpeechGarbage(text)) {
        this.logger.warn(`Fast STT path got a non-speech-garbage transcript (forced ${knownLanguage}): ${JSON.stringify(text)} — discarding it as if empty`);
        text = '';
      }

      // Cheap self-check for a genuine language switch mid-call, paid for on every turn
      // instead of a second full STT call: an English-forced result that's actually full of
      // Arabic script text is a strong sign the customer switched languages. An
      // Arabic-forced result with NO Arabic script in it at all is the same "fake Arabic"
      // pattern already known from pickSpokenLanguage below (Cohere sometimes just gives up
      // rendering Arabic and transcribes English text anyway even when forced into "ar")  —
      // in either case there's real signal something is wrong, so it's worth paying for the
      // full dual-transcribe+judge path just this once to re-confirm, rather than trusting a
      // possibly-stale language for the rest of the call.
      const arabicScript = /[؀-ۿ]/;
      const suspectedSwitch = knownLanguage === 'en' ? /[؀-ۿ]{2,}/.test(text) : text.trim().length > 0 && !arabicScript.test(text);
      diagnostics.suspectedSwitch = suspectedSwitch;
      diagnostics.fastPathText = text;

      if (!suspectedSwitch && text) {
        return { text, language: knownLanguage, path: 'fast-single', diagnostics: { ...diagnostics, finalLanguage: knownLanguage, switchDetected: false } };
      }

      if (!text) {
        // BUG FIX (2026-09-10, confirmed live): an empty first attempt used to trigger a
        // single retry in the OTHER language and then TRUST that result with no validation at
        // all — unlike every other path here, which checks for exactly the failure mode that
        // bit this one. Confirmed live, twice, on two different real calls with two different
        // English-speaking customers: Cohere's Arabic model doesn't fail on audio it can't
        // confidently transcribe, it returns a fluent-sounding stock hallucination — the
        // IDENTICAL Arabic sentence, verbatim, unprompted, in both calls, sent straight to the
        // customer as if it were real. Falling through to the shared dual-transcribe+judge path
        // below instead — the same one every other uncertain case here already uses — gets the
        // same "try both languages" resilience this retry was for, but through the LLM judge's
        // duration-based hallucination check instead of trusting a single unvalidated guess.
        this.logger.log(`Fast STT path got an empty ${knownLanguage} attempt — re-confirming with a full dual-transcribe instead of trusting an unvalidated retry`);
      } else {
        languageUnderSuspicion = true;
        this.logger.log(`Fast STT path suspects a language switch (forced ${knownLanguage} gave ${JSON.stringify(text)}) — re-confirming with a full dual-transcribe`);
      }
    }

    // Turn one of the call (nothing confirmed yet), or the fast path above suspected a
    // switch — transcribe with BOTH languages and let the LLM judge which one is actually
    // coherent. MUST run sequentially, not in parallel — the shared Flask STT service
    // handles one transcription at a time and returns HTTP 409 ("Another transcription is
    // already in progress") to a second concurrent request, confirmed live. Each attempt
    // also has its own fallback so one failing (409, timeout, etc.) doesn't waste the
    // other's result.
    // AUDIT INSTRUMENTATION ONLY (2026-09-14 latency audit — no behavior change): breaks down
    // where the slow path's time actually goes — time spent WAITING for the shared GPU-box
    // mutex (queued behind other STT/TTS work) vs. the STT call's own real duration — since
    // "the slow path takes ~4.5s" could mean either "Cohere itself is slow" or "this request
    // sat behind unrelated work," and those have completely different fixes.
    const enEnqueuedAt = Date.now();
    const enResult = await this.gpuBoxQueue
      .run(async () => {
        const queueWaitMs = Date.now() - enEnqueuedAt;
        const callStartedAt = Date.now();
        const r = await this.stt.transcribe(audio, { language: 'en' });
        return { r, queueWaitMs, callMs: Date.now() - callStartedAt };
      })
      .catch((error) => {
        this.logger.warn(`English STT attempt failed: ${error instanceof Error ? error.message : error}`);
        return null;
      });
    const arEnqueuedAt = Date.now();
    const arResult = await this.gpuBoxQueue
      .run(async () => {
        const queueWaitMs = Date.now() - arEnqueuedAt;
        const callStartedAt = Date.now();
        const r = await this.stt.transcribe(audio, { language: 'ar' });
        return { r, queueWaitMs, callMs: Date.now() - callStartedAt };
      })
      .catch((error) => {
        this.logger.warn(`Arabic STT attempt failed: ${error instanceof Error ? error.message : error}`);
        return null;
      });
    this.logger.log(
      `[LATENCY] dual-STT breakdown: en(queueWait=${enResult?.queueWaitMs ?? 'n/a'}ms call=${enResult?.callMs ?? 'n/a'}ms) ` +
        `ar(queueWait=${arResult?.queueWaitMs ?? 'n/a'}ms call=${arResult?.callMs ?? 'n/a'}ms)`,
    );
    if (!enResult && !arResult) {
      throw new ServiceUnavailableException('The speech-to-text service is temporarily unavailable.');
    }
    let enText = enResult?.r.text ?? '';
    let arText = arResult?.r.text ?? '';
    if (isKnownSttHallucination(enText)) {
      this.logger.warn('English-forced STT attempt got a known stock-hallucination transcript — discarding it as if empty');
      enText = '';
    }
    if (isKnownSttHallucination(arText)) {
      this.logger.warn('Arabic-forced STT attempt got a known stock-hallucination transcript — discarding it as if empty');
      arText = '';
    }
    if (containsNonSpeechGarbage(enText)) {
      this.logger.warn(`English-forced STT attempt got a non-speech-garbage transcript: ${JSON.stringify(enText)} — discarding it as if empty`);
      enText = '';
    }
    if (containsNonSpeechGarbage(arText)) {
      this.logger.warn(`Arabic-forced STT attempt got a non-speech-garbage transcript: ${JSON.stringify(arText)} — discarding it as if empty`);
      arText = '';
    }
    diagnostics.enText = enText;
    diagnostics.arText = arText;
    if (!enText && !arText) {
      const finalLanguage = knownLanguage ?? 'en';
      return {
        text: '',
        language: finalLanguage,
        path: 'dual-transcribe+judge',
        diagnostics: { ...diagnostics, decisionPath: 'both-attempts-empty', finalLanguage, switchDetected: false },
      };
    }

    // call.language always has a real value from the moment the call starts (an explicit
    // choice, or the customer's own profile language as the default — see startCall) — even
    // on the very first turn, before anything is actually confirmed, it's a genuinely useful
    // tie-breaker, not a guess to be distrusted. Withholding it specifically on turn one
    // (an earlier version of this code did, out of over-caution about repeating the original
    // forced-language bug) turned out to matter a lot in practice: confirmed live, first
    // utterances are more often short/fragmentary (less pre-roll buffered before the VAD
    // catches speech-start right as a call connects), which is exactly when both STT attempts
    // are weak generic guesses and the judge needs a tie-breaker most.
    const audioDurationMs = getWavDurationMs(audio);
    // Three cases: (1) a language IS confirmed from an earlier turn and nothing contradicts
    // it — lean toward that, same as always. (2) nothing is confirmed yet (turn one) — lean
    // toward the account's own profile default instead of giving no hint at all (see
    // accountDefaultLanguage's doc comment; this is what actually fixes a short, genuinely
    // ambiguous turn-one greeting like "Hello" vs "ألو"). (3) the fast path's own self-check
    // just found concrete evidence AGAINST the confirmed language — handing that same language
    // to the judge as "lean toward this" would defeat the entire point of escalating (see
    // languageUnderSuspicion's doc comment), so withhold any hint and judge purely on
    // content/duration.
    const priorLanguageForJudge = languageUnderSuspicion ? null : knownLanguage ?? accountDefaultLanguage;
    const picked = await this.pickSpokenLanguage(enText, arText, priorLanguageForJudge, hasPriorTurn, audioDurationMs, callId, requestId);
    return {
      text: picked.text,
      language: picked.language,
      path: 'dual-transcribe+judge',
      diagnostics: {
        ...diagnostics,
        decisionPath: picked.decisionPath,
        judgeReasoning: picked.judgeReasoning,
        finalLanguage: picked.language,
        switchDetected: knownLanguage !== null && picked.language !== knownLanguage,
      },
    };
  }

  /**
   * Decides which of two same-audio STT attempts (one forced English, one forced Arabic) is
   * the real transcription, using the LLM as a coherence judge — a wrong-language attempt
   * doesn't come back empty or obviously broken, it comes back as a plausible-sounding
   * sentence in the wrong language, so a simple heuristic can't tell them apart reliably.
   */
  private async pickSpokenLanguage(
    enText: string,
    arText: string,
    priorLanguage: 'en' | 'ar' | null,
    confirmedThisCall: boolean,
    audioDurationMs: number | null,
    callId?: string,
    requestId?: string,
  ): Promise<{ text: string; language: 'en' | 'ar'; decisionPath: string; judgeReasoning?: string }> {
    const arabicScript = /[؀-ۿ]/;
    if (!enText) return { text: arText, language: 'ar', decisionPath: 'english-attempt-empty' };
    if (!arText) return { text: enText, language: 'en', decisionPath: 'arabic-attempt-empty' };

    // BUG FIX (2026-09-17 turn-1 latency pass, customer-requested — MOVED HERE 2026-09-17 after
    // a real-call failure): a plain short greeting ("Hello" vs "ألو"/"هلو"/"مرحبا") is genuine
    // ACOUSTIC ambiguity, not something an LLM judge actually resolves by reasoning harder — both
    // are real, common, valid words in their own language, so the judge call was paying its real
    // cost (generation time AND the ~1-1.3s fixed per-call overhead measured earlier) to
    // adjudicate a case it has no real content signal to decide beyond what a cheap, deterministic
    // check of the two attempts themselves already tells us.
    //
    // MUST run BEFORE both-attempts-identical/arabic-attempt-has-no-arabic-script below, not
    // after (where it originally lived) — confirmed live: a real customer said "Hello" in
    // English, and Cohere's ENGLISH-forced attempt itself rendered it as "حلو" (Arabic script —
    // a genuine word meaning "sweet", and also just phonetically close to "hello"), with the
    // Arabic-forced attempt producing the exact same string. That hit both-attempts-identical
    // BEFORE reaching this check at its old position, and that shortcut's own logic — "if the
    // agreed text contains Arabic script, trust Arabic" — is correct for real Arabic content
    // (see its own 2026-09-11 fix note) but wrong for this: a short phonetic near-miss, not a
    // real Arabic sentence both sides independently confirmed. Running this check first means a
    // short (<=2 word) turn-1 utterance is judged on greeting-word evidence FIRST, regardless of
    // whether the two attempts happen to agree or whether the "Arabic" side has script in it —
    // longer utterances are completely unaffected (this block still only ever fires for <=2
    // words on BOTH sides), so both-attempts-identical's own original fix (a real multi-word
    // Arabic sentence both sides transcribe the same way) is untouched.
    //
    // Deliberately scoped to turn 1 ONLY (!confirmedThisCall — nothing confirmed yet this call)
    // — NOT applied once a mid-call switch is already suspected (see languageUnderSuspicion in
    // resolveTranscript, which passes priorLanguage as null for that case, so this never fires
    // there anyway): that's a genuinely different situation with real stakes and actual content
    // to weigh, not a bare greeting. This guard is unchanged since the first version of this fix
    // and the suspected-switch → full dual-STT → judge-without-prior-language path it protects
    // remains untouched.
    if (!confirmedThisCall && priorLanguage) {
      const enWordCount = enText.trim() ? enText.trim().split(/\s+/).length : 0;
      const arWordCount = arText.trim() ? arText.trim().split(/\s+/).length : 0;
      if (enWordCount <= 2 && arWordCount <= 2) {
        // GREETING_WORDS_EN/AR are deliberately small and literal — the same small set of words
        // this exact ambiguity has repeatedly come down to in real calls this session
        // ("Hello"/"Hi" vs "ألو"/"هلو"/"مرحبا"/"أهلا"/"السلام عليكم") — not a general-purpose
        // classifier. If only one side matches its own language's list, that's real (if modest)
        // evidence, so it wins. If both match, or neither matches (as with "حلو" above — it is
        // NOT in GREETING_WORDS_AR, being a different real word, not a recognized greeting
        // transliteration), there is genuinely nothing to decide on — the customer-requested
        // behavior is to fall back to English specifically in that case, not the account default.
        const enLooksLikeGreeting = GREETING_WORDS_EN.test(enText);
        const arLooksLikeGreeting = GREETING_WORDS_AR.test(arText);
        if (arLooksLikeGreeting && !enLooksLikeGreeting) {
          return { text: arText, language: 'ar', decisionPath: 'short-greeting-arabic-evidence' };
        }
        if (enLooksLikeGreeting && !arLooksLikeGreeting) {
          return { text: enText, language: 'en', decisionPath: 'short-greeting-english-evidence' };
        }
        return { text: enText, language: 'en', decisionPath: 'short-greeting-ambiguous-default-english' };
      }
    }

    if (enText.trim() === arText.trim()) {
      // BUG FIX (2026-09-11, confirmed live): this used to always label an exact match
      // "English" outright — reasonable for the case this was originally written for (Cohere's
      // Arabic-forced attempt gives up and echoes the English attempt back, so an agreeing pair
      // really is plain English), but backwards for the opposite, equally real case: clear
      // Arabic audio where BOTH forced-language attempts correctly transcribe the same real
      // Arabic sentence (the "language" hint is a bias, not an absolute constraint) — confirmed
      // live: a customer's "ما هو رصيد حسابي؟" ("what is my account balance") was transcribed
      // identically by both attempts and got stored/answered as English despite being
      // unambiguous Arabic text, purely because the two sides matched. Basing the label on the
      // actual script of the agreed-upon text instead of assuming English fixes both cases with
      // the same check.
      return { text: enText, language: arabicScript.test(enText) ? 'ar' : 'en', decisionPath: 'both-attempts-identical' };
    }

    // Confirmed live, repeatedly: forced into "language=ar", Cohere's STT sometimes just
    // gives up rendering Arabic and transcribes English text anyway — nearly identical to
    // the English attempt, just missing punctuation (e.g. en="What is my current account
    // balance?" ar="What is my current account balance"). The prior exact-match check above
    // requires perfect equality, so this near-duplicate was slipping through to the LLM judge,
    // which then sometimes picked the option merely LABELED "ar" even though its own content
    // is plain English — there's nothing Arabic to weigh against once the "Arabic" attempt has
    // no Arabic script in it at all, so don't bother asking.
    if (!arabicScript.test(arText)) {
      return { text: enText, language: 'en', decisionPath: 'arabic-attempt-has-no-arabic-script' };
    }

    const priorLabel = priorLanguage === 'en' ? 'English' : 'Arabic';
    const priorHint = !priorLanguage
      ? ''
      : confirmedThisCall
        ? `\nContext: earlier in this same call, the customer was actually confirmed speaking ` +
          `${priorLabel}. People usually keep speaking the same language for a while, so if it's a ` +
          'close call, lean toward that — but pick the other one instead if it is clearly the ' +
          'better match for what was actually said (customers do switch languages mid-call).'
        : `\nContext: this is the first thing the customer has said on this call, so nothing is ` +
          `confirmed yet, but their account is set to ${priorLabel} by default. If it's a close ` +
          `call, lean toward ${priorLabel} — but pick the other one instead if it is clearly the ` +
          'better match for what was actually said (this default is often right but not always).';

    // Confirmed live (2026-09-09): a customer said a short plain "Hello" and the judge picked
    // a fully-formed, on-topic, grammatically perfect Arabic sentence ("هدى أبغى أعرف رصيدي في
    // البنك الحالي" — "I want to know my current bank balance") over the correct short English
    // attempt — almost certainly because that Arabic candidate superficially resembles the
    // worked example below (a short leaked word + "...أبغى أعرف رصيدي في البنك الحالي"), so the
    // model pattern-matched the SHAPE of the known-good example instead of actually judging
    // this pair's content. Two fixes: (1) an objective, content-independent duration check — a
    // clip this short cannot physically contain a whole sentence's worth of real speech, no
    // matter how coherent the hallucination reads; (2) a SECOND worked example in the other
    // direction, so the model can't just learn "an Arabic balance question is usually the
    // right answer" as a shortcut.
    // BUG FIX (2026-09-15, confirmed live TWICE on real turn-1 calls): this hint used to only
    // warn about an attempt being TOO LONG for the clip — it never said what to do when NEITHER
    // attempt is too long, and the judge started misapplying the "short clip -> distrust the
    // longer attempt" logic even when the "longer" attempt was actually short too. Confirmed:
    // a 0.8s clip (expected ~1.6-2.4 words) containing the genuine 2-word Arabic greeting
    // "السلام عليكم" was rejected as "an elaborate multi-word Arabic greeting" implausible for
    // the clip — 2 words is NOT elaborate, and it fits the expected range exactly; the judge's
    // own arithmetic was simply wrong. Same failure on a 1.6s clip (expected ~3.2-4.8 words):
    // the genuine 4-word Arabic attempt "ما هو سيدي الحالي" was called "far too long" for the
    // clip despite matching the expected count precisely. Both times the judge picked a vague,
    // generic, fabricated English guess instead ("So, um...", "What are you seeing?"). Explicit
    // arithmetic + an explicit "these are close, length is NOT the deciding factor here"
    // instruction closes this — the model was extrapolating a false general rule ("short clip ->
    // English wins") from Example B below instead of actually computing the two word counts.
    const durationHint = audioDurationMs
      ? (() => {
          const seconds = audioDurationMs / 1000;
          const minWords = Math.max(1, Math.round(seconds * 2));
          const maxWords = Math.max(1, Math.round(seconds * 3));
          const enWords = enText.trim() ? enText.trim().split(/\s+/).length : 0;
          const arWords = arText.trim() ? arText.trim().split(/\s+/).length : 0;
          return (
            `\nThe audio clip is only about ${seconds.toFixed(1)} seconds long. A typical speaker says ` +
            `roughly 2-3 words per second, so this clip most likely contains somewhere around ${minWords}-` +
            `${maxWords} words of real speech. The English attempt has ${enWords} word(s); the Arabic ` +
            `attempt has ${arWords} word(s) (Arabic word-splitting on whitespace is approximate, treat this ` +
            `as a rough count, not exact). Compare BOTH of those counts against the ${minWords}-${maxWords} ` +
            'expected range yourself — do not assume either one is "too long" without actually checking: ' +
            'if ONE attempt is dramatically longer than the expected range (a full multi-clause sentence ' +
            'where only a couple of words fit), that is a strong sign IT is the fabrication, regardless of ' +
            'how fluent or on-topic it reads. But if BOTH attempts have word counts that roughly fit the ' +
            `expected ${minWords}-${maxWords} range (e.g. both are short), clip length does NOT distinguish ` +
            'them — do not reject a short, complete, ordinary phrase (a common greeting, "thank you", a ' +
            'short question) just because the OTHER attempt is also short; judge which one is a real, ' +
            "specific, complete utterance a person would actually say versus a vague or generic-sounding " +
            'guess (e.g. "So, um...", "What are you seeing?" — these are the kind of thing a wrong-language ' +
            'guess produces: short, grammatically fine, but vague and going nowhere) in that case instead.'
          );
        })()
      : '';

    const prompt =
      'A speech-to-text model transcribed the same short audio clip twice: once assuming ' +
      'English was spoken, once assuming Arabic. Exactly one is the real transcription — the ' +
      'other is a wrong-language guess. The wrong guess is often GRAMMATICALLY VALID and reads ' +
      "as a normal sentence — grammar alone doesn't decide this. Watch instead for: nonsense " +
      'or out-of-place words/names a real customer would never say (red flag for the wrong one), ' +
      'content unrelated to accounts/payments/balances/transactions on a bank support line (also ' +
      'a red flag), and — importantly — an attempt that is implausibly long or elaborate for how ' +
      'short the actual audio clip is (also a red flag; see below). A leaked stray word from the ' +
      'other language at the very start/end (e.g. an English "Hi" opening an otherwise Arabic ' +
      'sentence) is NORMAL bilingual speech, not a sign that attempt is wrong — but a fully-formed, ' +
      'unrelated sentence is a sign of fabrication, not a leaked word. Similarly, ONE odd or ' +
      'slightly-wrong-sounding word inside an otherwise coherent, on-topic sentence (e.g. a word ' +
      'that almost fits grammatically but not quite) is more likely a single mis-heard word — a ' +
      'normal speech-to-text accuracy slip, not evidence the whole attempt is fabricated — ' +
      'ESPECIALLY if fixing just that one word would make it a completely ordinary, sensible ' +
      'request. Reserve "fabrication" for an attempt that is vague/generic throughout, or where ' +
      'the topic itself (not just one word) does not fit.' +
      `${durationHint}` +
      `${priorHint}\n\n` +
      `English attempt: ${JSON.stringify(enText)}\n` +
      `Arabic attempt: ${JSON.stringify(arText)}\n\n` +
      'Example A: English attempt "Hi. Abba. I\'ve got a recipient for the bank." (grammatical, ' +
      'but "Abba" is a nonsense insertion, and it doesn\'t clearly relate to a real request) vs. ' +
      'Arabic attempt "Hi أبغى أعرف رصيدي في البنك الحالي" (a plain, ordinary request to check a ' +
      'balance, aside from the leaked "Hi") — for a clip several seconds long, the correct answer ' +
      'there is the Arabic one.\n' +
      'Example B (the OTHER direction — do not assume Arabic is usually right): English attempt ' +
      '"Hello." (a short, plain, complete greeting — nothing more, nothing less) vs. Arabic ' +
      'attempt "هدى أبغى أعرف رصيدي في البنك الحالي" (a full, specific, on-topic sentence asking ' +
      'to check a balance) — this LOOKS like the same pattern as Example A, but for a clip under ' +
      'one second long, a whole sentence like that cannot be real; the correct answer here is the ' +
      'short English greeting, and the elaborate Arabic sentence is a fabrication that only ' +
      'coincidentally sounds plausible.\n' +
      'Example C (do NOT over-apply Example B — a SHORT Arabic attempt is not automatically ' +
      'suspicious just because it is short): English attempt "So, um..." (vague, trails off, ' +
      'says nothing) vs. Arabic attempt "السلام عليكم" (a short, complete, extremely common ' +
      'greeting — "peace be upon you") — for a clip under one second, BOTH are short enough to ' +
      'fit, so clip length does not favor either one here; the correct answer is the Arabic ' +
      'greeting, because it is a specific, complete, ordinary thing a person actually says, while ' +
      'the English attempt is exactly the kind of vague filler a wrong-language guess produces. ' +
      'Do not default to English just because it is short too.\n\n' +
      // BUG FIX (2026-09-17 turn-1 latency pass): reordered "language" BEFORE "reasoning" —
      // confirmed live across real turn-1 calls that "one short sentence" alone did not reliably
      // constrain this: real judge replies measured 66-186 output tokens (a full hedging
      // paragraph, e.g. "...however per instructions to lean toward English when close unless
      // clearly better match and neither fits 8-13 word count reality making both implausible
      // as full real sentences but English being the account default makes it safer choice."),
      // and this call's own generation time (not STT, not GPU reload — loadDurationMs stayed
      // low) was the dominant cost of turn 1's ~6-7s TTFA. With "reasoning" first, a tighter
      // maxTokens cap (see below) risked cutting the response off before "language" was even
      // reached — losing the actual decision, not just the explanation, and falling back to the
      // cruder length-only heuristic. Putting the decision first means it's fully emitted within
      // the first ~10 tokens regardless of how verbose the model gets afterward — see the
      // parsing fallback below, which now recovers the decision even from a truncated reply.
      // Also added an explicit numeric cap ("15 words or fewer") — this project's own prior
      // fixes (e.g. the voice-response conciseness pass) found a vague "keep it short" alone
      // does not reliably hold this model; a concrete number does better.
      'Reply with ONLY a JSON object, no other text, in this exact key order: {"language": "en" ' +
      'or "ar", "reasoning": "<ONE short sentence, 15 words or fewer, comparing the two>"}';

    try {
      // maxTokens: a real JSON judge reply is well under a hundred tokens now that it only
      // needs a short reasoning sentence + a two-letter language code — capping it is what
      // fixes the 30-second stall confirmed live (see LlmGenerateOptions doc comment). This
      // used to also require the model to copy the whole winning transcript back out verbatim
      // ("text" field below), which on a longer candidate could run past the cap before the
      // closing quote/brace — confirmed live (2026-09-11): a truncated "Unterminated string in
      // JSON" forced the slow heuristic fallback on nearly every first turn, the actual source
      // of a latency regression. We already HAVE both candidate strings in enText/arText, so
      // there was never a need to make the model re-type one back to us — dropping "text" from
      // the requested shape removes the truncation risk at its root instead of just raising the
      // cap to paper over it.
      // AUDIT INSTRUMENTATION ONLY (2026-09-14 latency audit — no behavior change): isolates
      // the judge LLM call's own duration from the two STT calls that precede it, since this
      // call goes through the SAME shared Qwen instance the main reply uses — if Qwen is
      // contended, this is exactly where a slow-path turn would show it.
      //
      // BUG FIX (2026-09-17 diagnostic-only phase): this used to only reach a console log line
      // ("[LATENCY] language-judge LLM call: Xms") — Ollama's own loadDurationMs/promptEvalCount/
      // evalCount for THIS call (the exact fields this diagnostic phase needs to correlate a
      // reload spike with) were computed by QwenProvider but never persisted anywhere queryable.
      // Now logged the same way every other Qwen call in this app already is.
      // maxTokens lowered 200 -> 60 (2026-09-17 turn-1 latency pass): with "language" now first
      // in the requested key order (see above), the decision is safe from truncation regardless
      // of this cap — 60 tokens is generous for a compliant {"language":"ar","reasoning":"<=15
      // words"} reply (well under 40 tokens in practice) while still bounding the worst case
      // FAR tighter than 200, directly cutting the real generation time measured on real turn-1
      // calls (a 186-token ramble took ~2.9s of generation alone). Confirmed via the real-call
      // test matrix below that this doesn't change any decision, only how much prose surrounds it.
      const judgeStartedAt = Date.now();
      const response = await this.llm.generate([{ role: 'user', content: prompt }], [], { maxTokens: 60, label: 'language-judge' });
      if (callId) {
        this.logLatency(requestId, callId, 'latency.llm', Date.now() - judgeStartedAt, {
          requestType: 'language-judge',
          ...response.stats,
        }).catch(() => {});
      }
      const match = response.content?.match(/\{[\s\S]*\}/);
      let parsedLanguage: string | undefined;
      let parsedReasoning: string | undefined;
      try {
        const parsed = match ? JSON.parse(match[0]) : null;
        parsedLanguage = parsed?.language;
        parsedReasoning = parsed?.reasoning;
      } catch {
        // FALLBACK (2026-09-17 turn-1 latency pass): a well-formed reply is never cut short at
        // maxTokens=60 (see above), but this guards the rare/degenerate case anyway rather than
        // trusting that unconditionally — a full JSON.parse failing (e.g. no closing brace at
        // all, mid-string cutoff) doesn't mean the decision itself is unrecoverable, since
        // "language" is the FIRST field requested and is only ~10 tokens in. Pulling it directly
        // out of the raw text still gets the real decision instead of falling all the way back
        // to the cruder length-only heuristic on a technicality.
        const fallbackMatch = response.content?.match(/"language"\s*:\s*"(en|ar)"/);
        parsedLanguage = fallbackMatch?.[1];
      }
      if (parsedLanguage === 'en' || parsedLanguage === 'ar') {
        this.logger.log(`Language pick reasoning: ${parsedReasoning ?? '(none given)'}`);
        return parsedLanguage === 'en'
          ? { text: enText, language: 'en', decisionPath: 'llm-judge', judgeReasoning: parsedReasoning }
          : { text: arText, language: 'ar', decisionPath: 'llm-judge', judgeReasoning: parsedReasoning };
      }
      this.logger.warn(`Language disambiguation returned unparseable content, falling back to heuristic: ${response.content}`);
    } catch (error) {
      this.logger.warn(`Language disambiguation call failed, falling back to heuristic: ${error instanceof Error ? error.message : error}`);
    }
    // Fallback: prefer whichever attempt is longer — a wrong-language hallucination is
    // usually a short, generic guess rather than a fully-formed matching sentence.
    return enText.length >= arText.length
      ? { text: enText, language: 'en', decisionPath: 'judge-failed-length-fallback' }
      : { text: arText, language: 'ar', decisionPath: 'judge-failed-length-fallback' };
  }

  /** The backend half of barge-in: immediately abandon the in-flight turn and return to listening. */
  async interrupt(callId: string, requestId?: string) {
    const call = await this.getCallOrThrow(callId);
    if (call.conversationId) {
      // Abandon whatever the previous reply was still streaming right away — don't wait for
      // the next turn to start, since the gap in between is exactly when a stale trailing
      // chunk could otherwise land on the client after it's already moved on.
      this.bumpGeneration(call.conversationId);
      await this.conversations.updateState(call.conversationId, 'LISTENING');
    }
    await this.auditService.log({
      requestId,
      actorType: AuditActorType.CUSTOMER,
      actorId: call.customerId,
      action: 'call.barge_in',
      entityType: 'call',
      entityId: call.id,
      success: true,
    });
    return { interrupted: true };
  }

  async endCall(callId: string, options?: { abortAudio?: boolean }) {
    const call = await this.getCallOrThrow(callId);
    const durationSeconds = Math.max(0, Math.round((Date.now() - call.startTime.getTime()) / 1000));

    let finalState: string | undefined;
    if (call.conversationId) {
      const conversation = await this.prisma.conversation.findUnique({ where: { id: call.conversationId } });
      finalState = conversation?.state;
      await this.conversations.updateState(call.conversationId, 'CALL_ENDED');
      // Deliberately NOT deleting this conversation's streamGeneration entry here. When the
      // agent itself ends the call (the common case — see handleTurn's CALL_ENDED branch),
      // endCall() runs concurrently with that SAME turn's own fire-and-forget audio streaming
      // (streamChunksIncremental/streamRemainingChunks), which is still delivering the
      // goodbye message and checks this exact map to detect a superseding turn. Deleting the
      // entry here made every call-ending turn's own goodbye audio look "superseded" to
      // itself (map lookup returns undefined, which never matches a real generation number)
      // and abort silently. A small number of stale numeric entries per ended call is a
      // negligible, bounded memory cost — nowhere near worth risking the goodbye message.
      //
      // options.abortAudio (used by the manual POST /calls/:id/end route only — see
      // CallsController) DOES bump the generation, aborting any still-streaming TTS for this
      // conversation. Confirmed live: hanging up manually while a long reply was still
      // streaming left that synthesis running against the shared single-worker GPU box for up
      // to a minute afterward, needlessly queueing (via gpuBoxQueue) every OTHER call's own
      // STT/TTS behind audio nobody would ever hear — one real turn's STT was delayed 13s this
      // way. The auto-ended-by-the-AI path never passes this, since that case's own goodbye
      // audio is exactly what must NOT be aborted.
      if (options?.abortAudio) {
        this.bumpGeneration(call.conversationId);
      }
    }

    if (call.liveKitRoomName) {
      await this.liveKit.endSession(call.liveKitRoomName);
    }

    const outcome =
      finalState === 'ESCALATING' ? 'ESCALATED' : finalState === 'CALLBACK_REQUESTED' ? 'CALLBACK_REQUESTED' : 'RESOLVED';

    await this.finalizeLinkedRecords(call.id, outcome);

    return this.prisma.call.update({
      where: { id: call.id },
      data: { endTime: new Date(), durationSeconds, outcome },
    });
  }

  /** If this call was placed by the campaign scheduler or a callback, close out that record too. */
  private async finalizeLinkedRecords(callId: string, outcome: 'ESCALATED' | 'CALLBACK_REQUESTED' | 'RESOLVED') {
    const campaignCall = await this.prisma.campaignCall.findFirst({ where: { callId } });
    if (campaignCall) {
      await this.prisma.campaignCall.update({ where: { id: campaignCall.id }, data: { outcome } });
      await this.prisma.campaignContact.update({ where: { id: campaignCall.campaignContactId }, data: { status: 'DONE' } });
    }

    const callback = await this.prisma.callback.findUnique({ where: { callId } });
    if (callback) {
      await this.prisma.callback.update({ where: { id: callback.id }, data: { status: 'COMPLETED' } });
    }
  }

  findAll(params: { customerId?: string; take?: number; skip?: number }) {
    const { customerId, take = 50, skip = 0 } = params;
    return this.prisma.call.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: { customer: { select: { id: true, fullName: true } } },
    });
  }

  async findOne(id: string) {
    const call = await this.prisma.call.findUnique({
      where: { id },
      include: { customer: true, transcript: true, conversation: { include: { messages: true } } },
    });
    if (!call) throw new NotFoundException(`Call ${id} not found`);
    return call;
  }

  private async getCallOrThrow(id: string) {
    const call = await this.prisma.call.findUnique({ where: { id } });
    if (!call) throw new NotFoundException(`Call ${id} not found`);
    return call;
  }

  private async appendTranscript(callId: string, segments: TranscriptSegment[]) {
    const existing = await this.prisma.callTranscript.findUnique({ where: { callId } });
    const content = existing ? [...(existing.content as unknown as TranscriptSegment[]), ...segments] : segments;
    await this.prisma.callTranscript.upsert({
      where: { callId },
      create: { callId, content: content as unknown as Prisma.InputJsonValue },
      update: { content: content as unknown as Prisma.InputJsonValue },
    });
  }

  private async logLatency(
    requestId: string | undefined,
    callId: string,
    action: string,
    durationMs: number,
    extra?: Record<string, unknown>,
  ) {
    await this.auditService.log({
      requestId,
      actorType: AuditActorType.SYSTEM,
      action,
      entityType: 'call',
      entityId: callId,
      result: { durationMs, ...extra },
      success: true,
    });
  }
}

/**
 * Reads an audio clip's duration straight from its own standard 44-byte WAV header
 * (dataSize / byteRate) — used only as an objective sanity-check signal for the STT language
 * judge (see pickSpokenLanguage): a clip a fraction of a second long cannot physically contain
 * a whole sentence's worth of real speech, no matter how coherent a hallucinated transcription
 * of it reads. Not used for anything audio-related (playback, chunking) — just this one check.
 */
function getWavDurationMs(wav: Buffer): number | null {
  if (wav.length < 44) return null;
  try {
    const byteRate = wav.readUInt32LE(28);
    const dataSize = wav.readUInt32LE(40);
    if (!byteRate) return null;
    return Math.round((dataSize / byteRate) * 1000);
  } catch {
    return null;
  }
}

/**
 * Cohere Transcribe Arabic occasionally doesn't fail on audio it can't confidently transcribe —
 * it returns a fluent-sounding, on-topic STOCK hallucination instead. One specific instance is
 * now confirmed live, byte-for-byte identical, across SIX separate real calls at different
 * times (2026-09-11 audit): "التفريغ والتدقيق قصي البياتي ..عبد الناصر عاشور ..جواد الخفاجي".
 * Its recurrence — always the exact same sentence, regardless of what was actually said — is
 * what distinguishes it from a real (if unlikely) utterance: genuine speech doesn't repeat
 * verbatim across unrelated calls. Treating a match as "this STT attempt returned nothing
 * usable" (rather than a real transcript) reuses every existing empty-result safeguard
 * (resolveTranscript's dual-transcribe+judge fallback, pickSpokenLanguage's !enText/!arText
 * shortcuts) instead of adding new machinery. Deliberately a short, exact-match list, not a
 * fuzzy/heuristic filter — add another entry here only once a NEW stock phrase is similarly
 * confirmed recurring verbatim; a single one-off transcription oddity is not the same failure
 * mode and shouldn't be blocklisted on a guess.
 */
const KNOWN_STT_HALLUCINATIONS = new Set(['التفريغ والتدقيق قصي البياتي ..عبد الناصر عاشور ..جواد الخفاجي']);

/**
 * Small, literal, deliberately non-exhaustive word lists used ONLY by pickSpokenLanguage's
 * turn-1 short-greeting shortcut (see there) to tell "one attempt is a recognizable greeting in
 * its own language, the other is not" (real, if modest, evidence) apart from "both look like a
 * greeting" or "neither does" (genuinely ambiguous — see that shortcut for what happens in
 * each case). NOT a general-purpose language classifier — every word here is one this exact
 * "Hello" vs "ألو"/"هلو"/"مرحبا" ambiguity has actually produced in real calls this session.
 * Extend only with another confirmed real case, the same discipline as KNOWN_STT_HALLUCINATIONS
 * above — a broader/fuzzier list here would start guessing instead of recognizing.
 */
const GREETING_WORDS_EN = /\b(hello|hi|hey|allo|hallo)\b/i;
const GREETING_WORDS_AR = /(مرحبا|أهلا|اهلا|ألو|هلو|السلام عليكم)/;

function isKnownSttHallucination(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return KNOWN_STT_HALLUCINATIONS.has(normalized);
}

/**
 * Rejects an STT result that contains characters no genuine spoken-language transcription
 * would ever produce — confirmed live (2026-09-11): a real call's turn came back as "@@@فراغ"
 * (literal "@" characters plus one Arabic word), which got trusted as real Arabic and flipped
 * the whole call's confirmed language, which then self-reinforced (pickSpokenLanguage's own
 * "lean toward the already-confirmed language" hint) for the rest of the call even though the
 * customer kept speaking English throughout. Nobody's spoken words transcribe to a literal "@"
 * — this is Cohere producing garbage on audio it can't handle, the same underlying failure mode
 * as the known stock-hallucination phrase above, just a different, symbol-shaped symptom of it
 * rather than a fluent fabricated sentence. Deliberately narrow (a small, fixed set of symbols
 * that are never legitimate speech-to-text output in this domain) rather than a broad "does
 * this look like a real sentence" heuristic, which risks rejecting genuine short/unusual replies.
 */
const NON_SPEECH_SYMBOLS = /[@#$%^&*_~`]/;

function containsNonSpeechGarbage(text: string): boolean {
  return NON_SPEECH_SYMBOLS.test(text);
}

/** Strips common markdown artifacts before sending text to TTS — otherwise the agent would
 *  literally say "asterisk asterisk" for **bold**, "hash" for a heading, etc. Only used for
 *  what's actually spoken; the stored transcript and on-screen text keep the original
 *  markdown, since that's fine (even useful) to display. */
function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/(?<!\w)\*(\S.*?\S|\S)\*(?!\w)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .trim();
}

/**
 * Splits a reply into speakable chunks for streaming playback — sentence-sized where that's
 * long enough to be worth its own TTS call, merging short pieces together so a reply like
 * "Yes. Sure. Let me check." doesn't turn into three separate synthesis calls for almost no
 * benefit. A short reply (the common case) comes back as a single chunk, identical to
 * synthesizing the whole thing at once.
 *
 * Splits on newlines FIRST, then sentence-ending punctuation within each line — a
 * sentence-only split badly under-splits a reply formatted as a bullet list (very common for
 * things like a transaction listing), which often has no ".!?" at all until the very last
 * line, so the whole multi-hundred-character reply was coming back as a single unsplit chunk
 * (confirmed live: a 711-character transaction-listing reply produced hasMoreAudio: false).
 *
 * The FIRST chunk uses its own, smaller `firstChunkMinLength` threshold — only that chunk's
 * length is on the critical path for time-to-first-audio, so it's kept just long enough to be
 * one real clause/short sentence rather than a single stray word (20 chars). Every later
 * chunk uses `minChunkLength` (40, down from the original 60) since over-splitting THOSE would
 * make playback sound noticeably choppier without helping perceived latency at all — by the
 * time chunk 2+ is needed, chunk 1 is already playing.
 *
 * Note this mainly matters for the non-streaming fallback path (see CallsService.handleTurn):
 * VoxCPM2's real /speak_stream keeps time-to-first-BYTE roughly constant (~0.5s, measured
 * live) regardless of chunk text length, since it starts emitting audio before the whole
 * utterance is rendered — so with true streaming active, a shorter first chunk mostly buys a
 * shorter total render time for chunk 1 (letting chunk 2 start sooner) rather than a faster
 * time-to-first-BYTE, which was already fast. For the fallback /speak-based path, though,
 * synthesis is much closer to real-time speed, so a shorter first chunk directly cuts how long
 * the customer waits in silence before anything plays.
 */
/**
 * Incremental counterpart to splitIntoSpeechChunks, for text arriving piece-by-piece from
 * Qwen streaming rather than as one complete reply. Given the buffer accumulated so far,
 * returns ONE ready chunk (text up to and including the first sentence/line boundary found at
 * or past the size threshold) plus whatever's left over, or null if nothing is ready yet. Only
 * ever emits a chunk at a real boundary — never mid-sentence/mid-word — so a stream that
 * hasn't reached one yet just keeps accumulating until the next delta (or, at the very end of
 * the stream, the caller flushes whatever's left regardless of whether it found a boundary).
 */
function extractSpeakableChunk(
  buffer: string,
  isFirstChunk: boolean,
  minChunkLength = 40,
  firstChunkMinLength = 20,
): { chunk: string; remainder: string } | null {
  const threshold = isFirstChunk ? firstChunkMinLength : minChunkLength;
  if (buffer.length < threshold) return null;
  const rest = buffer.slice(threshold);
  const boundaryMatch = rest.match(/[.!?](?=\s|$)|\n/);
  if (!boundaryMatch || boundaryMatch.index === undefined) return null;
  const cutAt = threshold + boundaryMatch.index + boundaryMatch[0].length;
  return { chunk: buffer.slice(0, cutAt).trim(), remainder: buffer.slice(cutAt) };
}

function splitIntoSpeechChunks(text: string, minChunkLength = 40, firstChunkMinLength = 20): string[] {
  const pieces = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (pieces.length <= 1) return [text.trim()];

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    current = current ? `${current} ${piece}` : piece;
    const threshold = chunks.length === 0 ? firstChunkMinLength : minChunkLength;
    if (current.length >= threshold) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
