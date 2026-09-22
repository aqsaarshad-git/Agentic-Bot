export interface TtsVoiceConfig {
  voiceId?: string;
  speakingRate?: number;
  pitch?: number;
  /** Natural-language style/emotion/pace description, e.g. "calm, empathetic, reassuring
   *  tone" — combined with the spoken text by the provider, per whatever convention that
   *  specific TTS engine actually supports (see VoxCpm2TtsProvider). */
  styleInstruction?: string;
}

export interface TtsResult {
  audio: Buffer;
  format: 'wav' | 'mp3' | 'pcm16';
}

export interface TtsStreamFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface TtsStreamResult {
  format: TtsStreamFormat;
  /** Raw PCM bytes only (the source WAV header, if any, is stripped before this point) —
   *  each yielded Buffer is byte-aligned to whole samples, safe to decode independently. */
  chunks: AsyncIterable<Buffer>;
}

/**
 * Port for the text-to-speech engine (VoxCPM2 in production).
 * Implemented in Phase 4 once the LiveKit/WebRTC voice transport exists.
 */
export interface TtsProvider {
  synthesize(text: string, voiceConfig?: TtsVoiceConfig): Promise<TtsResult>;
  /**
   * True incremental synthesis: resolves as soon as the engine's own stream header is
   * readable, with the remaining audio delivered as raw PCM chunks that arrive well before
   * synthesis of the whole utterance finishes — for engines that run near real-time speed,
   * this is what actually gets time-to-first-audio down instead of just moving the same
   * total wait earlier. Optional: a provider without a true streaming endpoint (e.g. the
   * mock in some configs, or a future provider) simply omits this, and callers fall back to
   * the non-streaming synthesize() above.
   *
   * `signal`, if given, aborts the underlying request/stream early — used when a caller
   * supersedes this synthesis (a barge-in, or a brand new turn) so the engine can be freed up
   * immediately instead of finishing audio nobody wants anymore. Implementations should treat
   * an abort as a normal early stop, not an error to log.
   */
  synthesizeStream?(text: string, voiceConfig?: TtsVoiceConfig, signal?: AbortSignal): Promise<TtsStreamResult>;
}

export const TTS_PROVIDER = Symbol('TTS_PROVIDER');
