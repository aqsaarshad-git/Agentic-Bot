import { Injectable } from '@nestjs/common';
import { SttProvider, SttResult } from './stt-provider.interface';

/**
 * Stand-in for Cohere Transcribe Arabic. Since there's no real audio codec/ASR here,
 * the "audio" buffer is treated as the UTF-8 transcript text directly — a deliberate
 * dev/testing convenience (callers simulating a spoken turn send the words they want
 * transcribed as the buffer contents) so the STT -> orchestrator -> TTS pipeline is
 * exercisable end-to-end today. Swapping to CohereArabicSttProvider is a config change.
 */
@Injectable()
export class MockSttProvider implements SttProvider {
  async transcribe(audio: Buffer, opts?: { language?: string }): Promise<SttResult> {
    const text = audio.toString('utf-8').trim();
    return {
      text,
      language: opts?.language ?? 'ar',
      segments: text ? [{ text, startMs: 0, endMs: Math.max(500, text.length * 60) }] : [],
    };
  }
}
