export interface SttSegment {
  text: string;
  startMs?: number;
  endMs?: number;
}

export interface SttResult {
  text: string;
  language?: string;
  segments?: SttSegment[];
}

/**
 * Port for the speech-to-text engine (Cohere Transcribe Arabic in production).
 * Implemented in Phase 4 once the LiveKit/WebRTC voice transport exists.
 */
export interface SttProvider {
  transcribe(audio: Buffer, opts?: { language?: string }): Promise<SttResult>;
}

export const STT_PROVIDER = Symbol('STT_PROVIDER');
