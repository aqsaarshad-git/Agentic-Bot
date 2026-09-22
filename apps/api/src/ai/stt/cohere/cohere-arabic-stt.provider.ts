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

    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(audio)]), 'audio.wav');
    form.append('language', opts?.language ?? 'ar');

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

    if (!res.ok) {
      this.logger.error(`Cohere STT returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      throw new ServiceUnavailableException('The speech-to-text service is temporarily unavailable.');
    }

    const json: any = await res.json();
    return { text: json.text ?? '', language: opts?.language };
  }
}
