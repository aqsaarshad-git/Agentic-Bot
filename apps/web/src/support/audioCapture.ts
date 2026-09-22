// Raw PCM capture via AudioWorklet, encoded to WAV manually — no MediaRecorder/WebM
// involved. A MediaRecorder-based first attempt at this exact problem (elsewhere)
// worked against injected test files but sometimes produced all-zero samples against
// a real microphone; capturing raw samples directly avoids that failure mode.

const RECORDER_WORKLET_CODE = `
  class RecorderProcessor extends AudioWorkletProcessor {
    process(inputs) {
      const input = inputs[0];
      if (input && input[0] && input[0].length) {
        this.port.postMessage(input[0].slice());
      }
      return true;
    }
  }
  registerProcessor('recorder-processor', RecorderProcessor);
`;

function encodeWav(sampleRate: number, channelData: Float32Array): Uint8Array {
  const bytesPerSample = 2;
  const dataSize = channelData.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < channelData.length; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

async function openMicWorklet(): Promise<{
  stream: MediaStream;
  audioCtx: AudioContext;
  workletNode: AudioWorkletNode;
  sourceNode: MediaStreamAudioSourceNode;
  silentGain: GainNode;
}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // echoCancellation is what keeps the agent's own TTS playback (played back through the
    // speakers, not WebRTC) from re-triggering the VAD as if the customer were talking —
    // it's not perfect on every device, but it's the best a browser can do without headphones.
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtx();
  // Chrome's autoplay policy can hand back an AudioContext that's born 'suspended' whenever
  // it's constructed after an intervening await (getUserMedia above, and — one level up — the
  // POST /calls network round-trip in VoiceCallWidget.startCall both happen first), even
  // though the whole chain started from a real click. A suspended context never runs its
  // AudioWorklet's process() callback at all — not an error, just silent — so the mic stream
  // exists (permission granted, the tab's recording indicator lights up) but no 'level' or
  // speech events are ever produced. Explicitly resuming closes that gap.
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  const workletUrl = URL.createObjectURL(new Blob([RECORDER_WORKLET_CODE], { type: 'application/javascript' }));
  await audioCtx.audioWorklet.addModule(workletUrl);

  const sourceNode = audioCtx.createMediaStreamSource(stream);
  const workletNode = new AudioWorkletNode(audioCtx, 'recorder-processor');
  sourceNode.connect(workletNode);

  // A worklet only runs if it's part of a graph reaching the destination — route through a
  // silent gain node so it keeps producing without audible feedback.
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  workletNode.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  return { stream, audioCtx, workletNode, sourceNode, silentGain };
}

export interface VadOptions {
  /** RMS (0..1) above which a window counts as "loud". Speech is typically 0.05+, room noise well under 0.02. */
  threshold?: number;
  /** Sustained loud time required before a window run is treated as the start of real speech, not a blip. */
  speechHoldMs?: number;
  /** Sustained quiet time required after speech before the utterance is considered finished and sent. */
  silenceHoldMs?: number;
  /** How much audio before the detected speech-start to keep, so the first syllable isn't clipped. */
  preRollMs?: number;
  /** Utterances shorter than this are dropped silently (mirrors the old "hold longer" guard, without a button). */
  minUtteranceMs?: number;
  /** Safety cap so a stuck-open mic can't buffer forever. */
  maxUtteranceMs?: number;
}

export type VadEvent =
  | { type: 'level'; rms: number }
  | { type: 'speech-start' }
  | { type: 'speech-end'; wav: Uint8Array; durationMs: number }
  /** A speech-start fired, but the sound died out before reaching minUtteranceMs (a cough, a
   *  click, background noise) — no utterance to send, but callers still need to know the
   *  "listening for you" attempt is over, or a UI driven purely off speech-start/speech-end
   *  gets stuck showing "hearing you" forever with nothing to ever move it on. */
  | { type: 'speech-abandoned' };

const DEFAULT_VAD_OPTIONS: Required<VadOptions> = {
  threshold: 0.02,
  speechHoldMs: 150,
  // Natural speech has real pauses mid-sentence (taking a breath, thinking of a word) that
  // can easily run past half a second — 800ms was cutting utterances off mid-thought the
  // moment someone paused briefly, well before they were actually done talking.
  silenceHoldMs: 1300,
  preRollMs: 300,
  minUtteranceMs: 400,
  maxUtteranceMs: 25_000,
};

const ANALYSIS_WINDOW_MS = 20;

/**
 * Continuous, hands-free call session: energy-based VAD (RMS over a hysteresis threshold,
 * with pre-roll buffering) adapted from the reference VoxCPM demo's own SimpleVAD, ported
 * to run client-side against the raw AudioWorklet PCM stream. The mic opens once per call
 * and stays open — no push-to-talk button — emitting a WAV clip each time it detects a
 * complete utterance (speech, held long enough to count, followed by enough silence).
 */
export class VadCallSession {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private silentGain: GainNode | null = null;

  private readonly opts: Required<VadOptions>;
  private onEvent: (e: VadEvent) => void = () => {};
  private active = false;
  private sampleRate = 48000;

  private pending: Float32Array[] = [];
  private pendingLength = 0;

  private preRoll: Float32Array[] = [];
  private preRollMsAccum = 0;

  private speaking = false;
  private speechBlocks: Float32Array[] = [];
  private speechMsAccum = 0;
  private silenceMsAccum = 0;
  private utteranceMsAccum = 0;

  constructor(options: VadOptions = {}) {
    this.opts = { ...DEFAULT_VAD_OPTIONS, ...options };
  }

  async start(onEvent: (e: VadEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    const { stream, audioCtx, workletNode, sourceNode, silentGain } = await openMicWorklet();
    this.stream = stream;
    this.audioCtx = audioCtx;
    this.workletNode = workletNode;
    this.sourceNode = sourceNode;
    this.silentGain = silentGain;
    this.sampleRate = audioCtx.sampleRate;
    this.active = true;
    workletNode.port.onmessage = (e) => this.onBlock(e.data as Float32Array);
  }

  /** Pauses/resumes VAD processing (e.g. for a mute button) without tearing the mic stream down. */
  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.resetSpeechState();
  }

  stop(): void {
    this.active = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.sourceNode?.disconnect();
    this.workletNode?.disconnect();
    this.silentGain?.disconnect();
    this.audioCtx?.close().catch(() => {});
    this.stream = null;
    this.audioCtx = null;
    this.workletNode = null;
    this.sourceNode = null;
    this.silentGain = null;
  }

  private resetSpeechState() {
    this.speaking = false;
    this.speechBlocks = [];
    this.speechMsAccum = 0;
    this.silenceMsAccum = 0;
    this.utteranceMsAccum = 0;
    this.preRoll = [];
    this.preRollMsAccum = 0;
    this.pending = [];
    this.pendingLength = 0;
  }

  private onBlock(block: Float32Array) {
    if (!this.active) return;
    this.pending.push(block);
    this.pendingLength += block.length;

    const windowSamples = (ANALYSIS_WINDOW_MS / 1000) * this.sampleRate;
    if (this.pendingLength < windowSamples) return;

    const merged = new Float32Array(this.pendingLength);
    let pos = 0;
    for (const b of this.pending) {
      merged.set(b, pos);
      pos += b.length;
    }
    this.pending = [];
    this.pendingLength = 0;

    const windowMs = (merged.length / this.sampleRate) * 1000;
    let sumSq = 0;
    for (let i = 0; i < merged.length; i++) sumSq += merged[i] * merged[i];
    const rms = Math.sqrt(sumSq / merged.length);
    this.onEvent({ type: 'level', rms });
    this.processWindow(merged, windowMs, rms >= this.opts.threshold);
  }

  private pushPreRoll(block: Float32Array, windowMs: number) {
    this.preRoll.push(block);
    this.preRollMsAccum += windowMs;
    while (this.preRollMsAccum > this.opts.preRollMs && this.preRoll.length > 1) {
      const removed = this.preRoll.shift()!;
      this.preRollMsAccum -= (removed.length / this.sampleRate) * 1000;
    }
  }

  private processWindow(block: Float32Array, windowMs: number, isLoud: boolean) {
    if (!this.speaking) {
      if (isLoud) {
        this.speechMsAccum += windowMs;
        this.pushPreRoll(block, windowMs);
        if (this.speechMsAccum >= this.opts.speechHoldMs) {
          this.speaking = true;
          this.speechBlocks = [...this.preRoll];
          this.utteranceMsAccum = this.preRollMsAccum;
          this.preRoll = [];
          this.preRollMsAccum = 0;
          this.silenceMsAccum = 0;
          this.onEvent({ type: 'speech-start' });
        }
      } else {
        this.speechMsAccum = 0;
        this.pushPreRoll(block, windowMs);
      }
      return;
    }

    this.speechBlocks.push(block);
    this.utteranceMsAccum += windowMs;
    this.silenceMsAccum = isLoud ? 0 : this.silenceMsAccum + windowMs;

    if (this.silenceMsAccum >= this.opts.silenceHoldMs || this.utteranceMsAccum >= this.opts.maxUtteranceMs) {
      this.finalizeUtterance();
    }
  }

  private finalizeUtterance() {
    const blocks = this.speechBlocks;
    const durationMs = this.utteranceMsAccum;
    const sampleRate = this.sampleRate;
    this.resetSpeechState();

    // Too short to be real speech (a cough, a click) — drop it and keep listening, rather
    // than sending a clip that would only make the ASR model hallucinate a short reply. Still
    // tell the caller the attempt is over (see VadEvent's speech-abandoned) so a UI state
    // machine driven off speech-start/speech-end doesn't get stuck.
    if (durationMs < this.opts.minUtteranceMs) {
      this.onEvent({ type: 'speech-abandoned' });
      return;
    }

    const totalLength = blocks.reduce((sum, b) => sum + b.length, 0);
    const merged = new Float32Array(totalLength);
    let pos = 0;
    for (const b of blocks) {
      merged.set(b, pos);
      pos += b.length;
    }
    const wav = encodeWav(sampleRate, merged);
    this.onEvent({ type: 'speech-end', wav, durationMs });
  }
}

/**
 * Concatenates multiple already-encoded 16-bit PCM WAV buffers (same sample rate/channels —
 * true here, since they all come from the same VadCallSession's encodeWav) into one. Used to
 * combine several utterances the customer said in quick succession — e.g. while a previous
 * turn's reply was still being generated — into a single follow-up turn instead of sending
 * each separately and making the customer wait through N full STT+LLM+TTS round-trips one
 * after another for what was really one continuous thought.
 */
export function concatWavBuffers(wavs: Uint8Array[]): Uint8Array {
  if (wavs.length === 1) return wavs[0];
  const HEADER_SIZE = 44;
  const dataChunks = wavs.map((w) => w.subarray(HEADER_SIZE));
  const totalDataSize = dataChunks.reduce((sum, d) => sum + d.length, 0);

  const out = new Uint8Array(HEADER_SIZE + totalDataSize);
  out.set(wavs[0].subarray(0, HEADER_SIZE), 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, 36 + totalDataSize, true);
  view.setUint32(40, totalDataSize, true);

  let offset = HEADER_SIZE;
  for (const chunk of dataChunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface PcmStreamFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/**
 * Schedules raw PCM16 chunks for gapless, low-latency playback via the Web Audio API — the
 * client-side half of VoxCPM2's true-streaming /speak_stream path (see
 * CallsService.streamChunksIncremental on the backend, which forwards each raw PCM chunk to
 * the call's socket room the instant VoxCPM2 produces it, instead of waiting for a whole
 * chunk's WAV to finish rendering). Playback is scheduled back-to-back using the
 * AudioContext's own clock (`nextStartTime`), not "as each chunk arrives" — the standard
 * technique for gapless Web Audio streaming, since network delivery timing is never perfectly
 * even.
 */
/** How long a barge-in/hangup fade-out takes before the source is actually stopped. Long
 *  enough to eliminate the audible click/pop of a hard AudioBufferSourceNode.stop() mid-buffer
 *  (confirmed live: that click was loud enough to leak into the mic and get transcribed as
 *  noise, corrupting the very first thing the customer said right after interrupting), short
 *  enough that it doesn't feel like a delay in cutting the agent off. */
const STOP_FADE_SECONDS = 0.02;

export class PcmStreamPlayer {
  private format: PcmStreamFormat | null = null;
  private nextStartTime = 0;
  private readonly activeSources = new Map<AudioBufferSourceNode, GainNode>();
  private ended = false;
  private onSettle: (() => void) | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly destination: AudioNode,
  ) {}

  /** Called once per turn, right before the first chunk arrives — resets scheduling state.
   *  `onSettle` fires once everything scheduled for this turn has finished playing AND
   *  finish() has been called (i.e. the server said no more chunks are coming). */
  begin(format: PcmStreamFormat, onSettle: () => void): void {
    this.format = format;
    this.nextStartTime = this.ctx.currentTime;
    this.ended = false;
    this.onSettle = onSettle;
  }

  /** Decodes one base64-encoded raw PCM16 chunk and schedules it immediately after whatever
   *  is already queued, so chunks play back-to-back regardless of exactly when each one
   *  arrives over the network. */
  push(pcmBase64: string): void {
    if (!this.format || this.format.bitsPerSample !== 16) return;
    const binary = atob(pcmBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes.length < 2) return;

    const { sampleRate, channels } = this.format;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frameCount = Math.floor(bytes.length / 2 / channels);
    if (frameCount <= 0) return;

    const buffer = this.ctx.createBuffer(channels, frameCount, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const channelData = buffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = view.getInt16((i * channels + ch) * 2, true) / 32768;
      }
    }

    // Each chunk gets its OWN gain node (rather than connecting straight to the shared
    // destination) purely so stop() can fade out just this source's still-playing buffer
    // without touching the shared volume-boost gain used by every other chunk/turn.
    const source = this.ctx.createBufferSource();
    const sourceGain = this.ctx.createGain();
    source.buffer = buffer;
    source.connect(sourceGain);
    sourceGain.connect(this.destination);
    const startAt = Math.max(this.nextStartTime, this.ctx.currentTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.activeSources.set(source, sourceGain);
    source.onended = () => {
      this.activeSources.delete(source);
      this.checkSettled();
    };
  }

  /** Marks that no more chunks are coming for this turn — once everything already scheduled
   *  finishes playing, onSettle fires. */
  finish(): void {
    this.ended = true;
    this.checkSettled();
  }

  private checkSettled(): void {
    if (this.ended && this.activeSources.size === 0) {
      const cb = this.onSettle;
      this.onSettle = null;
      cb?.();
    }
  }

  /** Stop for barge-in / hangup / a brand-new turn superseding this one — silences everything
   *  almost immediately (a short fade, not an instant cut) instead of letting already-scheduled
   *  buffers play out. A truly instant AudioBufferSourceNode.stop() cuts the waveform
   *  mid-sample, producing an audible click/pop — confirmed live to be loud enough to leak into
   *  the mic and get transcribed as noise, corrupting the very next thing the customer said. A
   *  short per-source gain ramp to zero avoids that discontinuity. */
  stop(): void {
    const now = this.ctx.currentTime;
    for (const [source, gain] of this.activeSources) {
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + STOP_FADE_SECONDS);
        source.onended = null;
        source.stop(now + STOP_FADE_SECONDS);
      } catch {
        // Already stopped/ended — fine.
      }
    }
    this.activeSources.clear();
    this.format = null;
    this.ended = false;
    this.onSettle = null;
  }

  get isPlaying(): boolean {
    return this.activeSources.size > 0;
  }
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}
