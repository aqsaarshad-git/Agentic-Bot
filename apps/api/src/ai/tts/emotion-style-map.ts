/**
 * Centralized customer-emotion -> agent-TTS-style mapping. The customer's detected emotion
 * is never mirrored back at them (an angry customer should hear a calm, de-escalating agent,
 * not an angry one) — this is the single place that decides the agent's spoken tone, so it
 * isn't duplicated/hardcoded across the orchestrator, calls service, and TTS adapter.
 *
 * Style instructions are combined with the spoken text as a SQUARE-BRACKET tag prepended to
 * the text (e.g. "[calm and reassuring] Hello there") — see VoxCpm2TtsProvider, the only
 * place that actually does the combining. This is NOT what VoxCPM2's own docs describe (they
 * document a parenthetical prefix instead) — that parenthetical convention was tried first and
 * confirmed BROKEN on this specific deployment (the audio literally spoke the parenthetical
 * text aloud, verified via STT round-trip). Square brackets were tried next and are confirmed
 * WORKING the same rigorous way: generated audio fed back through STT came back with the tag
 * text completely absent, for both single-word tags ([whisper]), multi-word free-form tags
 * ([professional broadcast tone]) and multiple tags in one long text — so this wrapper/model
 * combination strips ANY bracketed segment as a control signal, not just a fixed preset list.
 * If this ever needs re-verifying (e.g. after any change to the GPU-side deployment), use the
 * same method: synthesize, feed the output back through /transcribe, and check the tag text
 * doesn't appear in what comes back — do not rely on duration comparisons alone, they were
 * misleading for the parenthetical convention.
 */
export const CUSTOMER_EMOTIONS = [
  'neutral',
  'happy',
  'frustrated',
  'angry',
  'sad',
  'worried',
  'confused',
  'anxious',
  'relieved',
  'excited',
] as const;
export type CustomerEmotion = (typeof CUSTOMER_EMOTIONS)[number];

export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const URGENCIES = ['low', 'medium', 'high', 'critical'] as const;
export type Urgency = (typeof URGENCIES)[number];

// Empty string means "no tag" — neutral is the model's own default delivery, nothing to ask
// for. Every other value is wrapped in [brackets] by VoxCpm2TtsProvider, never here, so
// callers/tests can compare against the plain style words.
export const EMOTION_TTS_STYLE: Record<CustomerEmotion, string> = {
  angry: 'calm and de-escalating',
  frustrated: 'calm and reassuring',
  sad: 'gentle and warm',
  worried: 'calm and reassuring',
  anxious: 'calm and reassuring',
  confused: 'clear and patient',
  happy: 'warm and friendly',
  excited: 'warm and enthusiastic',
  relieved: 'warm and positive',
  neutral: '',
};

export function isCustomerEmotion(value: unknown): value is CustomerEmotion {
  return typeof value === 'string' && (CUSTOMER_EMOTIONS as readonly string[]).includes(value);
}

export function isSentiment(value: unknown): value is Sentiment {
  return typeof value === 'string' && (SENTIMENTS as readonly string[]).includes(value);
}

export function isUrgency(value: unknown): value is Urgency {
  return typeof value === 'string' && (URGENCIES as readonly string[]).includes(value);
}
