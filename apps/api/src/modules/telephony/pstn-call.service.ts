import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { CallDirection } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CallsService } from '../calls/calls.service';
import { ConversationsService } from '../conversations/conversations.service';
import { ChatGateway } from '../orchestrator/chat.gateway';
import { TTS_PROVIDER, TtsProvider } from '../../ai/tts/tts-provider.interface';

/** Spoken first, by the agent, before the caller says anything — see getGreetingAudio's own
 *  doc comment for why every real PSTN call now gets one of these instead of only a
 *  campaign-seeded script. Keyed by the Call's own already-resolved `language`, not re-derived. */
const DEFAULT_GREETING: Record<'ar' | 'en', string> = {
  en: 'Hello! How can I help you today?',
  ar: 'مرحبًا! كيف يمكنني مساعدتك اليوم؟',
};

const WORKER_REQUEST_TIMEOUT_MS = 15_000;
const STREAM_WAIT_TIMEOUT_MS = 45_000;
// How much audio to buffer before handing a segment to the worker for playback. This is the
// entire fix for the ~6s "wait for the whole TTS chunk to render" bug (see streamTurnForPstn's
// doc comment) — small enough that the customer hears the start of the reply shortly after
// VoxCPM2's own first-byte latency, large enough to keep the number of tiny playback/ESL round
// trips (and their per-segment overhead) reasonable. Not a tunable exposed anywhere else;
// change here only if a live test shows this specific value is wrong in either direction.
const PCM_SEGMENT_TARGET_MS = 250;
// VoxCPM2's raw output runs quiet (confirmed live, 2026-09-10 — a single sampled segment
// measured ~1.3-2.9% of full scale) — the same issue the browser call widget already works
// around with its own 2.4x client-side Web Audio gain stage (see TTS_GAIN_BOOST in
// VoiceCallWidget.tsx; same GPU box, same root cause, not something either side can fix
// upstream). FreeSWITCH has no equivalent built-in step for a plain `playback` of a static
// file, so the gain has to be applied to the PCM samples themselves before they're written
// into the WAV. This is a CEILING, not a flat multiplier: a fuller live measurement across a
// whole reply showed real speech has much wider dynamic range than that one quiet sample
// suggested (some ~250ms segments already 15-25% of full scale on their own) — applyGainToPcm
// caps each buffer to its own safe headroom so this number is only ever fully applied to
// genuinely quiet audio, never hard-clipping a loud one.
const PSTN_GAIN_BOOST = 4;

/**
 * The API-side half of real PSTN calling. All the actual FreeSWITCH/ESL/audio-file mechanics
 * (originate, record, playback, barge-in) live in a SEPARATE process — telephony-worker/worker.js
 * — deployed on the box that holds the live Connectel trunk (192.168.5.133), because FreeSWITCH's
 * ESL is firewalled to loopback-only there and the record/playback WAV files need to be on the
 * same filesystem FreeSWITCH itself writes/reads — neither holds for this Node process running
 * elsewhere. This service is the thin API-side counterpart: it owns the Call/Conversation DB
 * records (via the existing, unchanged CallsService) and talks to the worker over HTTP (normally
 * tunneled — see scripts/freeswitch-tunnel.sh) for the two things that actually need to happen
 * on that box: "originate this call" and "here's the seeded opening line to speak."
 *
 * The reverse direction — the worker telling THIS app about an inbound answer, or handing over a
 * recorded turn / hangup — arrives as ordinary HTTP calls into
 * telephony-worker.controller.ts, authenticated by the same shared secret
 * (TELEPHONY_WORKER_SECRET), and from there straight into the existing
 * CallsService.handleTurn()/endCall() — unchanged either way a call reaches this app.
 */
@Injectable()
export class PstnCallService {
  private readonly logger = new Logger(PstnCallService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly callsService: CallsService,
    private readonly conversations: ConversationsService,
    private readonly chatGateway: ChatGateway,
    @Inject(TTS_PROVIDER) private readonly tts: TtsProvider,
  ) {}

  /** Places a real outbound PSTN call. Used by POST /calls/dial-out and, when TELEPHONY_ENABLED,
   *  by the campaign/callback scheduler in place of the browser-only startCall(). */
  async dial(params: { customerId: string; phoneNumber: string; aiAgentId?: string }) {
    if (!this.config.get<boolean>('telephony.enabled')) {
      throw new BadRequestException('Telephony is not enabled (set TELEPHONY_ENABLED=true once the telephony worker is reachable)');
    }

    // Pinned as the FreeSWITCH channel UUID (origination_uuid) by the worker, so every ESL
    // event for this call is already correlated to it with no separate lookup table — same
    // trick the worker also relies on for barge-in/turn bookkeeping.
    const fsUuid = randomUUID();
    const fromNumber = this.config.get<string>('telephony.connectel.callerIdNumber') ?? '';

    const { call } = await this.callsService.startPstnCall({
      customerId: params.customerId,
      direction: 'OUTBOUND' as CallDirection,
      fromNumber,
      toNumber: params.phoneNumber,
      providerCallUuid: fsUuid,
      aiAgentId: params.aiAgentId,
    });

    try {
      await this.callWorker('/originate', {
        callId: call.id,
        fsUuid,
        phoneNumber: params.phoneNumber,
        callerIdNumber: fromNumber,
      });
    } catch (error) {
      this.logger.error(`Originate via worker failed: ${error instanceof Error ? error.message : error}`);
      await this.callsService.endCall(call.id).catch(() => undefined);
      throw error;
    }

    return { call };
  }

  /** Called by the worker (telephony-worker.controller.ts) when an inbound call — one it didn't
   *  originate itself — is answered on one of this project's DIDs. */
  async handleInboundAnswer(fromNumber: string, toNumber: string, providerCallUuid: string) {
    const customer = await this.findOrCreateCustomerByPhone(fromNumber);
    const { call } = await this.callsService.startPstnCall({
      customerId: customer.id,
      direction: 'INBOUND' as CallDirection,
      fromNumber,
      toNumber,
      providerCallUuid,
    });
    return { callId: call.id, conversationId: call.conversationId };
  }

  /** Called by the worker right after answer (both directions) to get a spoken opening line —
   *  every real PSTN call gets one, so the agent always speaks first and the caller answers into
   *  a greeting rather than dead air. If the conversation was already seeded before the call
   *  connected (the campaign scheduler does this via ConversationsService.addMessage — see
   *  campaign-scheduler.service.ts — right after dial() returns), that seeded script IS the
   *  greeting. Otherwise (a plain inbound support call, or a customer/admin-initiated dial-me/
   *  dial-out with no script) this seeds a standard greeting itself, in the call's own resolved
   *  language, so the transcript still starts with a real, persisted AI message either way. */
  async getGreetingAudio(callId: string): Promise<{ audioBase64: string | null; format?: string }> {
    const call = await this.prisma.call.findUnique({ where: { id: callId }, select: { conversationId: true, language: true } });
    if (!call?.conversationId) return { audioBase64: null };

    let greetingText = (
      await this.prisma.message.findFirst({
        where: { conversationId: call.conversationId, sender: 'AI' },
        orderBy: { createdAt: 'asc' },
      })
    )?.content;

    if (!greetingText) {
      greetingText = DEFAULT_GREETING[call.language === 'en' ? 'en' : 'ar'];
      await this.conversations.addMessage(call.conversationId, 'AI', greetingText);
      this.chatGateway.broadcast(call.conversationId, 'message', { sender: 'AI', content: greetingText });
    }

    try {
      const synthesized = await this.tts.synthesize(greetingText);
      const audio = synthesized.format === 'wav' ? applyGainToWav(synthesized.audio, PSTN_GAIN_BOOST) : synthesized.audio;
      return { audioBase64: audio.toString('base64'), format: synthesized.format };
    } catch (error) {
      this.logger.warn(`Greeting synthesis failed, call will proceed without one: ${error instanceof Error ? error.message : error}`);
      return { audioBase64: null };
    }
  }

  /**
   * Bridges CallsService.handleTurn() (unchanged) to the telephony worker as an NDJSON stream —
   * one line per event — instead of a single buffered response. Audio is delivered as small,
   * fixed-duration PCM SEGMENTS (~PCM_SEGMENT_TARGET_MS each), not one WAV per whole TTS
   * text-chunk — that was the actual latency bug a 2026-09-10 audit found: buffering an entire
   * chunk (its full multi-second render time, not just VoxCPM2's ~600ms first-byte latency)
   * before sending anything left the phone in dead air for ~6s per chunk even though audio was
   * trickling in the whole time. Flushing every ~250ms of accumulated PCM instead means the
   * worker gets — and starts playing — real audio within roughly VoxCPM2's own TTFB, the same
   * as a browser listener consuming the raw stream directly. This subscribes to the exact same
   * ChatGateway broadcasts a browser socket client receives (audio-stream-start/chunk/
   * chunk-end/end) — CallsService's streaming pipeline itself is completely unchanged, and nothing
   * here affects what a browser call receives.
   *
   * `onLine` is called once per event, in order: one `{type:'text', ...}` with the non-audio
   * turn result, zero or more `{type:'audio', chunkIndex, audioBase64}` as each ~250ms segment
   * becomes ready, then exactly one `{type:'done'}`. `chunkIndex` is a flat per-turn counter
   * across all segments (not tied to TTS text-chunk boundaries) — the worker's player just plays
   * whatever arrives, strictly in order, and doesn't need to know where one text-chunk's audio
   * ends and the next begins.
   */
  async streamTurnForPstn(callId: string, audio: Buffer, onLine: (line: Record<string, unknown>) => void): Promise<void> {
    // AUDIT INSTRUMENTATION ONLY (2026-09-10 latency audit — no behavior change).
    this.logger.log(`[LATENCY] worker turn request received (call:${callId}, audio:${audio.length}b) at ${Date.now()}`);
    const call = await this.prisma.call.findUnique({ where: { id: callId }, select: { conversationId: true } });
    if (!call?.conversationId) {
      const result = await this.callsService.handleTurn(callId, audio);
      emitResult(onLine, result);
      return;
    }
    const conversationId = call.conversationId;

    let format: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
    let segmentPcm: Buffer[] = [];
    let segmentBytes = 0;
    let segmentCounter = 0;
    let firstSegmentLogged = false;
    // Persists across every segment of THIS turn — see applySmoothedGain's doc comment for why
    // (2026-09-14 audio-quality fix): each segment used to be gain-normalized independently,
    // which could swing the applied gain sharply from one ~250ms segment to the next and was
    // the likely source of reported "pumping"/crackling. Starts at 0 (unset) so the very first
    // segment gets its own ideal gain immediately, with nothing yet to smooth from.
    let previousGain = 0;
    let resolveStreamEnd!: (hadError: boolean) => void;
    const streamEnd = new Promise<boolean>((resolve) => {
      resolveStreamEnd = resolve;
    });

    // Flushes whatever's accumulated as one small WAV, SAMPLE-ALIGNED (a boundary that splits a
    // 16-bit sample in half would click/distort at the seam) — any partial trailing sample is
    // carried over to the next segment rather than sent early. `force` (chunk-end / stream-end)
    // flushes even a sub-threshold remainder so no tail audio is ever silently dropped.
    const flushSegment = (force: boolean) => {
      if (!format || segmentBytes === 0) return;
      const targetBytes = segmentTargetBytes(format);
      if (!force && segmentBytes < targetBytes) return;

      const blockAlign = format.channels * (format.bitsPerSample / 8);
      const combined = segmentPcm.length === 1 ? segmentPcm[0] : Buffer.concat(segmentPcm, segmentBytes);
      const alignedLength = combined.length - (combined.length % blockAlign);
      if (alignedLength === 0) return; // not even one whole sample yet — wait for more, even if forced

      const toSend = alignedLength === combined.length ? combined : combined.subarray(0, alignedLength);
      const leftover = alignedLength === combined.length ? null : Buffer.from(combined.subarray(alignedLength));
      segmentPcm = leftover ? [leftover] : [];
      segmentBytes = leftover ? leftover.length : 0;

      const idx = segmentCounter++;
      const { buffer: gained, gainUsed } = applySmoothedGain(toSend, format.bitsPerSample, PSTN_GAIN_BOOST, previousGain);
      previousGain = gainUsed;
      const boosted = applyEdgeFade(gained, format.bitsPerSample, format.sampleRate);
      const wav = pcmToWav(boosted, format);
      const now = Date.now();
      if (!firstSegmentLogged) {
        firstSegmentLogged = true;
        // "first PCM sent to FreeSWITCH" — the number this whole fix exists to shrink.
        this.logger.log(`[LATENCY] first PCM segment sent to worker (call:${callId}, bytes:${toSend.length}) at ${now}`);
      }
      this.logger.log(`[LATENCY] relaying PCM segment ${idx} (${toSend.length}b) to worker (call:${callId}) at ${now}`);
      onLine({ type: 'audio', chunkIndex: idx, audioBase64: wav.toString('base64') });
    };

    const unsubscribe = this.chatGateway.onBroadcast(conversationId, (event, payload) => {
      const data = payload as Record<string, unknown>;
      if (event === 'audio-stream-start') {
        format = data.format as { sampleRate: number; channels: number; bitsPerSample: number };
      } else if (event === 'audio-stream-chunk') {
        const buf = Buffer.from(data.pcmBase64 as string, 'base64');
        segmentPcm.push(buf);
        segmentBytes += buf.length;
        flushSegment(false);
      } else if (event === 'audio-stream-chunk-end') {
        flushSegment(true); // send this text-chunk's tail remainder now rather than folding it into the next chunk's first segment
      } else if (event === 'audio-stream-end') {
        flushSegment(true);
        resolveStreamEnd(Boolean(data?.error));
      }
    });

    try {
      const result = await this.callsService.handleTurn(callId, audio);
      emitResult(onLine, result);
      if (!result.audioStreaming) return;

      const timedOut = Symbol('timeout');
      const timeout = new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), STREAM_WAIT_TIMEOUT_MS));
      const outcome = await Promise.race([streamEnd, timeout]);
      if (outcome === timedOut) {
        this.logger.warn(`Timed out waiting for streamed audio on call ${callId} — any segments already sent still play`);
      }
    } finally {
      unsubscribe();
      onLine({ type: 'done' });
    }
  }

  /**
   * Matches by the national significant number (last 10 digits) rather than exact string
   * equality — a seeded customer's phone and the ANI a SIP trunk actually presents on an
   * inbound call frequently differ in formatting only ("+923124439804" vs "923124439804" vs
   * "03124439804"), and an exact-match miss here means every real call from an already-known
   * customer would otherwise silently create a duplicate placeholder record instead of
   * resolving to their real profile (account data, prior history, preferred language, etc.).
   */
  private async findOrCreateCustomerByPhone(phone: string) {
    const normalized = normalizePhone(phone);
    if (normalized) {
      const candidates = await this.prisma.customer.findMany({ where: { phone: { not: null } } });
      const existing = candidates.find((c) => c.phone && normalizePhone(c.phone) === normalized);
      if (existing) return existing;
    }
    return this.prisma.customer.create({ data: { phone, fullName: `Caller ${phone}`, language: 'ar' } });
  }

  private async callWorker(path: string, body: unknown): Promise<void> {
    const workerUrl = this.config.get<string>('telephony.workerUrl');
    if (!workerUrl) {
      throw new ServiceUnavailableException('TELEPHONY_WORKER_URL is not configured');
    }
    const secret = this.config.get<string>('telephony.workerSecret') ?? '';

    let res: Response;
    try {
      res = await fetch(`${workerUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telephony-Worker-Secret': secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `Could not reach the telephony worker at ${workerUrl}: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ServiceUnavailableException(`Telephony worker request to ${path} failed (HTTP ${res.status}): ${text}`);
    }
  }
}

/** Emits the non-audio turn result as a 'text' line, plus — only for a provider that doesn't
 *  stream at all (synthesizeStream unimplemented, or the mock provider) — one 'audio' line
 *  inline, since in that case handleTurn() already put the complete clip in audioBase64 itself
 *  and there's nothing to wait for. The true-streaming case's audio lines are emitted
 *  separately, live, from streamTurnForPstn's own broadcast subscription above.
 *
 *  Known gap, not currently reachable: `hasMoreAudio` (CallsService's OTHER fallback —
 *  streamRemainingChunks/'audio-chunk' events, for a non-streaming provider with a long reply)
 *  isn't captured here, so only its first chunk would play. Inactive with the real deployed
 *  provider (VoxCpm2TtsProvider implements synthesizeStream), so left unhandled for now rather
 *  than adding more surface for a path nothing currently exercises. */
function emitResult(onLine: (line: Record<string, unknown>) => void, result: Record<string, unknown>): void {
  const { audioBase64, audioFormat, audioStreaming, hasMoreAudio, ...text } = result;
  onLine({ type: 'text', ...text });
  if (!audioStreaming && typeof audioBase64 === 'string') {
    onLine({ type: 'audio', chunkIndex: 0, audioBase64 });
  }
}

/** Last 10 digits only — stable across "+92xxx" / "0xxx" / "92xxx" formatting of the same
 *  Pakistani number; empty for anything without at least that many digits. */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/** Bytes of PCM corresponding to PCM_SEGMENT_TARGET_MS at the given format — the flush
 *  threshold streamTurnForPstn buffers up to before handing a segment to the worker. */
function segmentTargetBytes(format: { sampleRate: number; channels: number; bitsPerSample: number }): number {
  const bytesPerMs = (format.sampleRate * format.channels * (format.bitsPerSample / 8)) / 1000;
  return Math.max(1, Math.round(bytesPerMs * PCM_SEGMENT_TARGET_MS));
}

/** Builds a standard 44-byte-header PCM WAV file from raw samples — the format VoxCPM2's
 *  streaming endpoint yields (see TtsStreamResult) has no header of its own by design (each
 *  chunk is meant to be queued directly for real-time playback), so one has to be synthesized
 *  here to get a normal playable file for FreeSWITCH's `playback` app. */
function pcmToWav(pcm: Buffer, format: { sampleRate: number; channels: number; bitsPerSample: number }): Buffer {
  const { sampleRate, channels, bitsPerSample } = format;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Multiplies every 16-bit signed sample by up to `gain`, capping to whatever this specific
 *  buffer's own peak can take without clipping. A flat multiplier was tried first and measured
 *  live against a real reply: some ~250ms segments (quiet trailing syllables) really were only
 *  1-3% of full scale, but others (a stressed syllable, a vowel) were already 15-25% of full
 *  scale on their own — a flat 4x hard-clipped those, pegging up to ~15% of samples at full
 *  scale (confirmed live, 2026-09-10) and producing audible crackling, which is worse than the
 *  quiet-but-clean output it was meant to fix. Scaling each buffer by its own safe headroom
 *  instead means quiet segments still get the full requested boost while loud ones get less —
 *  never hard clipping, whatever `gain` is requested. Only 16-bit PCM is supported (the only
 *  bit depth VoxCPM2 actually produces) — anything else is returned unchanged rather than
 *  guessing at a byte layout. */
function applyGainToPcm(pcm: Buffer, bitsPerSample: number, gain: number): Buffer {
  if (bitsPerSample !== 16 || gain === 1) return pcm;
  const sampleCount = pcm.length - (pcm.length % 2);
  let peak = 0;
  for (let i = 0; i < sampleCount; i += 2) {
    const abs = Math.abs(pcm.readInt16LE(i));
    if (abs > peak) peak = abs;
  }
  if (peak === 0) return pcm;
  const safeGain = Math.min(gain, 32767 / peak);
  if (safeGain <= 1) return pcm;

  const out = Buffer.from(pcm);
  for (let i = 0; i < sampleCount; i += 2) {
    out.writeInt16LE(Math.round(pcm.readInt16LE(i) * safeGain), i);
  }
  return out;
}

// How much the applied gain may move, per segment, toward that segment's own ideal (safe) gain
// — caps the RATE of change rather than the gain itself, so loudness ramps smoothly across
// consecutive ~250ms segments instead of jumping. 0.5 reaches ~94% of a sustained new level
// within 5 segments (~1.25s) — fast enough that a genuine loud/quiet passage isn't stuck
// sounding wrong for long, slow enough that segment-to-segment jumps are no longer abrupt.
const GAIN_SMOOTHING_ALPHA = 0.5;
// A ~5ms linear ramp at 8kHz mono (VoxCPM2's real streaming rate) — long enough to remove an
// audible click/pop at a segment boundary, short enough to lose no perceptible speech content
// (a fraction of a phoneme, not a syllable). Recomputed per segment from the actual sample rate
// rather than hardcoded, in case the deployed format ever changes.
const EDGE_FADE_MS = 5;

/**
 * Gain-boosts one segment of a longer PCM stream, same clipping safety as applyGainToPcm (never
 * exceeds THIS segment's own safe headroom, whatever `gain` asks for), but the applied gain is
 * smoothed toward that safe target across calls instead of jumping straight to it — pass back
 * `gainUsed` as the next call's `previousGain` to chain segments of the same turn together.
 *
 * BUG FIX (2026-09-14, confirmed live): applyGainToPcm alone, called independently per ~250ms
 * segment (the PSTN streaming design — see PCM_SEGMENT_TARGET_MS), computes its OWN safe gain
 * from only that segment's own peak — a quiet segment (a trailing consonant) gets boosted much
 * more than a loud, adjacent one (a stressed vowel), so consecutive segments of the very same
 * sentence could swing between very different loudness levels. Reported live as audio
 * "distortion"/"noise"/pumping. Smoothing the gain itself (not just the audio) fixes this
 * without touching the ~250ms segmentation or delivery timing at all — still exactly as
 * incremental, still exactly as fast to first audio.
 */
function applySmoothedGain(
  pcm: Buffer,
  bitsPerSample: number,
  gain: number,
  previousGain: number,
): { buffer: Buffer; gainUsed: number } {
  if (bitsPerSample !== 16 || gain === 1) return { buffer: pcm, gainUsed: 1 };
  const sampleCount = pcm.length - (pcm.length % 2);
  let peak = 0;
  for (let i = 0; i < sampleCount; i += 2) {
    const abs = Math.abs(pcm.readInt16LE(i));
    if (abs > peak) peak = abs;
  }
  if (peak === 0) return { buffer: pcm, gainUsed: previousGain || 1 }; // pure silence — keep whatever gain was already in effect, nothing to measure here
  const idealGain = Math.min(gain, 32767 / peak);
  // No prior segment to smooth from (the very first one this turn) — use the ideal gain
  // immediately rather than ramping up from silence, so the reply doesn't start too quiet.
  const smoothedGain = previousGain === 0 ? idealGain : previousGain + (idealGain - previousGain) * GAIN_SMOOTHING_ALPHA;
  // The smoothing above can only move gain TOWARD the ideal, but a sudden loud segment right
  // after quiet ones means the smoothed value could still exceed what THIS segment can safely
  // take — the safety cap is non-negotiable regardless of where smoothing landed.
  const safeGain = Math.min(smoothedGain, idealGain);
  if (safeGain <= 1) return { buffer: pcm, gainUsed: safeGain };

  const out = Buffer.from(pcm);
  for (let i = 0; i < sampleCount; i += 2) {
    out.writeInt16LE(Math.round(pcm.readInt16LE(i) * safeGain), i);
  }
  return { buffer: out, gainUsed: safeGain };
}

/** Linearly ramps the first/last EDGE_FADE_MS of a segment's PCM down to (and back up from)
 *  silence — softens the sample-value discontinuity at a segment boundary (independently
 *  gain-boosted neighboring segments, or simply two separately-rendered TTS segments, don't
 *  necessarily meet at a matching amplitude) into a smooth ramp instead of an abrupt jump,
 *  which is what a listener hears as a click/pop. Skips segments too short to fade both ends
 *  without overlapping (only ever the very last, sub-threshold tail segment of a reply). */
function applyEdgeFade(pcm: Buffer, bitsPerSample: number, sampleRate: number): Buffer {
  if (bitsPerSample !== 16) return pcm;
  const sampleCount = (pcm.length - (pcm.length % 2)) / 2;
  const fadeSamples = Math.round((EDGE_FADE_MS / 1000) * sampleRate);
  if (fadeSamples < 1 || sampleCount < fadeSamples * 2) return pcm;

  const out = Buffer.from(pcm);
  for (let i = 0; i < fadeSamples; i++) {
    const factor = i / fadeSamples;
    const inIdx = i * 2;
    out.writeInt16LE(Math.round(pcm.readInt16LE(inIdx) * factor), inIdx);
    const outIdx = (sampleCount - 1 - i) * 2;
    out.writeInt16LE(Math.round(pcm.readInt16LE(outIdx) * factor), outIdx);
  }
  return out;
}

/** Same gain boost as applyGainToPcm, but for an already-built standard 44-byte-header WAV
 *  buffer (used on the greeting path, which gets a whole WAV from TtsProvider.synthesize()
 *  rather than raw PCM segments). */
function applyGainToWav(wav: Buffer, gain: number): Buffer {
  if (wav.length <= 44) return wav;
  const bitsPerSample = wav.readUInt16LE(34);
  const header = wav.subarray(0, 44);
  const pcm = applyGainToPcm(wav.subarray(44), bitsPerSample, gain);
  return Buffer.concat([header, pcm]);
}
