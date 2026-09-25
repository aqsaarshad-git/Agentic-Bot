import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SttProvider, SttResult } from '../stt-provider.interface';

/**
 * Adapter for Cohere Transcribe Arabic as actually deployed for this project: a
 * self-hosted instance behind a small Flask wrapper (shared GPU box, CPU-only for
 * this model so it doesn't compete with VoxCPM2 for GPU memory), NOT the public
 * Cohere SaaS API — that's a different contract (see CohereArabicSttApiProvider-style
 * base-URL+API-key JSON version if that's ever needed instead).
 *
 * Verified live against the real endpoint:
 *   POST {baseUrl}/transcribe
 *   multipart/form-data: audio=<wav blob>, language=<"ar"|"en">
 *   -> 200 { "text": "..." }
 *
 * Reached over an SSH tunnel (the service is bound to the GPU box's loopback only) —
 * see apps/api/README-style notes in .env.example. Never modify anything on that box.
 */
// Normally sub-2s even over the tunnel, but it's CPU-bound on a shared box — bound it
// generously rather than inherit undici's ~5-minute default headers timeout.
const STT_TIMEOUT_MS = 60_000;

@Injectable()
export class CohereArabicSttProvider implements SttProvider {
  private readonly logger = new Logger(CohereArabicSttProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('stt.cohereBaseUrl') ?? '';
    this.apiKey = this.config.get<string>('stt.cohereApiKey') ?? '';
  }

  async transcribe(audio: Buffer, opts?: { language?: string }): Promise<SttResult> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException(
        'Cohere Transcribe Arabic is selected but COHERE_STT_BASE_URL is not configured.',
      );
    }

    // AUDIT INSTRUMENTATION ONLY (2026-09-25 STT latency investigation — no behavior change):
    // isolates local request-building/response-parsing time (expected near-zero — a FormData/
    // Blob wrap and a small JSON parse) from the network+Cohere-processing leg (expected to
    // dominate) so "STT is slow" can be attributed to the right side instead of assumed.
    const t0 = Date.now();
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(audio)]), 'audio.wav');
    form.append('language', opts?.language ?? 'ar');
    const t1 = Date.now();

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/transcribe`, {
        method: 'POST',
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error('Cohere STT request failed', error instanceof Error ? error.stack : String(error));
      throw new ServiceUnavailableException('The speech-to-text service is temporarily unavailable.');
    }
    const t2 = Date.now();

    if (!res.ok) {
      // DEFENSIVE SIGNAL (2026-09-25 gpuBoxQueue split): a 409 here specifically means the
      // shared server's own _stt_lock was already held by another STT call — expected only
      // when sttQueue itself has a bug, since sttQueue is supposed to make this impossible from
      // our side. Tagged distinctly so a regression (e.g. the shared server changing again to
      // reject a concurrent STT+TTS pair too) is easy to spot instead of reading as a generic
      // "STT unavailable" blip. Not retried here — see calls.service.ts's own doc comment on
      // why this whole investigation exists; retrying blindly would hide the very signal this
      // is for.
      if (res.status === 409) {
        this.logger.error(
          '[GPU-QUEUE-COLLISION] STT got HTTP 409 (Cohere) despite sttQueue serializing our own STT calls — ' +
            'either sttQueue has a bug, or the shared server changed its concurrency behavior again.',
        );
      }
      this.logger.error(`Cohere STT returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      throw new ServiceUnavailableException('The speech-to-text service is temporarily unavailable.');
    }

    const json: any = await res.json();
    const t3 = Date.now();
    this.logger.log(
      `[LATENCY] cohere-stt breakdown: build=${t1 - t0}ms network+processing=${t2 - t1}ms parse=${t3 - t2}ms ` +
        `total=${t3 - t0}ms audioBytes=${audio.length} language=${opts?.language ?? 'ar'}`,
    );
    return { text: json.text ?? '', language: opts?.language };
  }
}
