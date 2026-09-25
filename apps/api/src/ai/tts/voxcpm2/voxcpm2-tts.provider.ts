import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TtsProvider, TtsResult, TtsStreamFormat, TtsStreamResult, TtsVoiceConfig } from '../tts-provider.interface';

/**
 * Adapter for VoxCPM2 as actually deployed for this project: a self-hosted Flask app
 * on a shared GPU box (the same box/app that also serves Cohere Transcribe Arabic —
 * see CohereArabicSttProvider), not the vLLM-Omni OpenAI-compatible path this adapter
 * originally assumed before the real deployment was confirmed.
 *
 * Verified live against the real endpoint:
 *   GET {baseUrl}/speak?text=<url-encoded text>&voice_id=<optional>
 *   -> 200, Content-Type: audio/wav, full WAV file bytes
 *
 * GET /speak_stream (used by synthesizeStream below) is real and genuinely streams —
 * verified live 2026-09-09 via curl: `Transfer-Encoding: chunked` (no Content-Length,
 * unlike /speak), time-to-first-byte ~0.5s regardless of text length vs. ~14-17s for
 * /speak's first (and only) byte on the same text. The body is a WAV stream with a
 * standard 44-byte header whose RIFF/data sizes are the streaming placeholder
 * 0xFFFFFFFF (length unknown up front) followed by raw little-endian PCM — confirmed
 * live: audioFormat=1 (PCM), and (at time of writing) mono/16-bit/48kHz, though
 * synthesizeStream reads these fields from the actual header rather than assuming
 * them, in case the deployment ever changes. GET /voices lists available cloned voices.
 *
 * Style/emotion control: VoxCPM2's own docs describe a parenthetical prefix for this
 * ("(calm, empathetic tone)Hello there") — **tried 2026-09-08 and confirmed BROKEN on this
 * specific deployment**: fed the generated audio back through STT and the transcript literally
 * included "Into calm, empathetic, reassuring tone." before the actual reply, i.e. it was read
 * aloud instead of treated as a control signal. Square-bracket tags instead
 * ("[calm and reassuring] Hello there") were tried next and confirmed WORKING the same way —
 * the transcript of the generated audio never contains the tag text, for single-word tags,
 * multi-word free-form tags, and multiple tags across one long text. This wrapper/model
 * combination apparently strips ANY bracketed segment, whether or not it's some documented
 * preset. If this ever needs re-verifying (e.g. after a change on the GPU side), use the same
 * method — synthesize, transcribe the result back, confirm the tag text is absent — duration
 * comparisons alone were misleading for the parenthetical convention and shouldn't be trusted.
 *
 * Reached over an SSH tunnel (bound to the GPU box's loopback only). Never modify
 * anything on that box — it's shared with another user's own services.
 */
// Generation runs at roughly real-time speed for the non-streaming /speak endpoint, so
// a long reply genuinely takes a while — bound it rather than inherit undici's
// ~5-minute default headers timeout on a stuck/contended request.
const TTS_TIMEOUT_MS = 90_000;

@Injectable()
export class VoxCpm2TtsProvider implements TtsProvider {
  private readonly logger = new Logger(VoxCpm2TtsProvider.name);
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('tts.voxcpm2BaseUrl') ?? '';
  }

  async synthesize(text: string, voiceConfig?: TtsVoiceConfig): Promise<TtsResult> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException('VoxCPM2 is selected but VOXCPM2_BASE_URL is not configured.');
    }

    // Combined only here, at the TTS integration layer — the orchestrator/calls service keep
    // the customer-facing response text and the style instruction as two separate values, so
    // neither the stored transcript nor the on-screen text ever picks up the style tag.
    const spokenText = voiceConfig?.styleInstruction ? `[${voiceConfig.styleInstruction}] ${text}` : text;
    const params = new URLSearchParams({ text: spokenText });
    if (voiceConfig?.voiceId) params.set('voice_id', voiceConfig.voiceId);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/speak?${params.toString()}`, {
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error('VoxCPM2 request failed', error instanceof Error ? error.stack : String(error));
      throw new ServiceUnavailableException('The text-to-speech service is temporarily unavailable.');
    }

    if (!res.ok) {
      // DEFENSIVE SIGNAL (2026-09-25 gpuBoxQueue split) — see synthesizeStream's identical
      // check below for what this is watching for.
      if (res.status === 409) {
        this.logger.error(
          '[GPU-QUEUE-COLLISION] TTS got HTTP 409 (VoxCPM2 /speak) despite ttsQueue serializing our own ' +
            'TTS calls — either ttsQueue has a bug, or the shared server changed its concurrency behavior again.',
        );
      }
      this.logger.error(`VoxCPM2 returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      throw new ServiceUnavailableException('The text-to-speech service is temporarily unavailable.');
    }

    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, format: 'wav' };
  }

  /** Standard 44-byte canonical PCM WAV header layout — see RIFF/WAVE spec. Read from the
   *  real bytes rather than hardcoded, so a future change to sample rate/channels on the
   *  GPU-side deployment doesn't silently desync playback. */
  private parseWavHeader(header: Buffer): TtsStreamFormat {
    return {
      channels: header.readUInt16LE(22),
      sampleRate: header.readUInt32LE(24),
      bitsPerSample: header.readUInt16LE(34),
    };
  }

  /**
   * True incremental synthesis via /speak_stream — resolves as soon as the WAV header is
   * readable (well before the full utterance finishes rendering), with the rest of the audio
   * delivered as raw PCM chunks over time. See the class doc comment above for how this was
   * verified against the real deployment.
   */
  async synthesizeStream(text: string, voiceConfig?: TtsVoiceConfig, signal?: AbortSignal): Promise<TtsStreamResult> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException('VoxCPM2 is selected but VOXCPM2_BASE_URL is not configured.');
    }

    const spokenText = voiceConfig?.styleInstruction ? `[${voiceConfig.styleInstruction}] ${text}` : text;
    const params = new URLSearchParams({ text: spokenText });
    if (voiceConfig?.voiceId) params.set('voice_id', voiceConfig.voiceId);

    const timeoutSignal = AbortSignal.timeout(TTS_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/speak_stream?${params.toString()}`, {
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error; // Superseded (barge-in/new turn) — not a real failure, let the caller handle it quietly.
      this.logger.error('VoxCPM2 streaming request failed', error instanceof Error ? error.stack : String(error));
      throw new ServiceUnavailableException('The text-to-speech service is temporarily unavailable.');
    }

    if (!res.ok || !res.body) {
      // DEFENSIVE SIGNAL (2026-09-25 gpuBoxQueue split): ttsQueue is supposed to make a 409 here
      // impossible from our own side (it already serializes every TTS call we make) — expected
      // only if ttsQueue itself has a bug, or the shared server's concurrency behavior changed
      // again (it already did once, unannounced, on 2026-09-25 — see calls.service.ts's
      // AsyncMutex doc comment). Tagged distinctly so that's easy to spot instead of reading as
      // a generic "TTS unavailable" blip. Not retried here — see the STT provider's identical
      // note for why.
      if (res.status === 409) {
        this.logger.error(
          '[GPU-QUEUE-COLLISION] TTS got HTTP 409 (VoxCPM2 /speak_stream) despite ttsQueue serializing our ' +
            'own TTS calls — either ttsQueue has a bug, or the shared server changed its concurrency behavior again.',
        );
      }
      this.logger.error(`VoxCPM2 stream returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      throw new ServiceUnavailableException('The text-to-speech service is temporarily unavailable.');
    }

    const reader = res.body.getReader();
    const HEADER_SIZE = 44;
    let headerBuf = Buffer.alloc(0);
    while (headerBuf.length < HEADER_SIZE) {
      const { done, value } = await reader.read();
      if (done) {
        throw new ServiceUnavailableException('The text-to-speech service returned an incomplete response.');
      }
      headerBuf = Buffer.concat([headerBuf, Buffer.from(value)]);
    }
    const format = this.parseWavHeader(headerBuf);
    const leftoverAfterHeader = headerBuf.subarray(HEADER_SIZE);

    // Network chunk boundaries don't respect 2-byte PCM16 sample boundaries — a byte held
    // back here is prefixed onto the next chunk so every yielded Buffer decodes cleanly as
    // whole samples, regardless of how the underlying TCP/HTTP chunking split the stream.
    async function* pcmChunks(): AsyncIterable<Buffer> {
      let carry = Buffer.alloc(0);
      // Bytes already in hand from the header read above must be yielded immediately, not
      // held until the next network read arrives — otherwise the first PCM chunk would wait
      // on an extra round-trip it doesn't need, undercutting the whole point of streaming.
      if (leftoverAfterHeader.length % 2 !== 0) {
        carry = leftoverAfterHeader.subarray(leftoverAfterHeader.length - 1);
        const aligned = leftoverAfterHeader.subarray(0, leftoverAfterHeader.length - 1);
        if (aligned.length > 0) yield aligned;
      } else if (leftoverAfterHeader.length > 0) {
        yield leftoverAfterHeader;
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (carry.length > 0) yield carry;
          return;
        }
        const buf = carry.length > 0 ? Buffer.concat([carry, Buffer.from(value)]) : Buffer.from(value);
        if (buf.length % 2 !== 0) {
          carry = buf.subarray(buf.length - 1);
          const aligned = buf.subarray(0, buf.length - 1);
          if (aligned.length > 0) yield aligned;
        } else {
          carry = Buffer.alloc(0);
          if (buf.length > 0) yield buf;
        }
      }
    }

    return { format, chunks: pcmChunks() };
  }
}
