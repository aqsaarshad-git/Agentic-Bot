import { IsString, MinLength } from 'class-validator';

export class CallTurnDto {
  /**
   * Base64-encoded audio bytes in production. In mock mode (default, no real STT
   * configured), decode to UTF-8 text and that text is treated as the transcript —
   * e.g. `Buffer.from('what is my balance').toString('base64')` — so the pipeline is
   * testable without a real microphone/codec.
   */
  @IsString()
  @MinLength(1)
  audioBase64!: string;
}
