import { Injectable } from '@nestjs/common';
import { TtsProvider, TtsResult, TtsStreamResult, TtsVoiceConfig } from './tts-provider.interface';

const MOCK_SAMPLE_RATE = 8000;

/**
 * Stand-in for VoxCPM2. Returns a short, technically-valid silent WAV clip rather than
 * real synthesized speech, so callers (the voice call pipeline, audio players) can
 * exercise the full plumbing today. Swapping to VoxCpm2TtsProvider is a config change.
 */
@Injectable()
export class MockTtsProvider implements TtsProvider {
  async synthesize(_text: string, _voiceConfig?: TtsVoiceConfig): Promise<TtsResult> {
    return { audio: buildSilentWav(300), format: 'wav' };
  }

  /** Also implements the streaming path (split into a couple of chunks with a small delay
   *  between them) so the true-incremental-playback pipeline can be exercised end-to-end
   *  without needing the real GPU box's credentials. */
  async synthesizeStream(_text: string, _voiceConfig?: TtsVoiceConfig): Promise<TtsStreamResult> {
    const pcm = buildSilentWav(300).subarray(44);
    const mid = Math.floor(pcm.length / 2 / 2) * 2; // split on a sample boundary
    async function* chunks(): AsyncIterable<Buffer> {
      yield pcm.subarray(0, mid);
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield pcm.subarray(mid);
    }
    return { format: { sampleRate: MOCK_SAMPLE_RATE, channels: 1, bitsPerSample: 16 }, chunks: chunks() };
  }
}

/** Builds a minimal valid mono 16-bit PCM WAV file of `durationMs` of silence at 8kHz. */
function buildSilentWav(durationMs: number): Buffer {
  const sampleRate = 8000;
  const numSamples = Math.round((sampleRate * durationMs) / 1000);
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  // remaining bytes are already zero-filled (silence)

  return buffer;
}
