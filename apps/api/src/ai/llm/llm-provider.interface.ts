export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmMessage {
  role: LlmRole;
  content: string;
  /** Tool name — only set on role: 'tool' messages (the tool result being fed back). */
  name?: string;
  /** Correlates a 'tool' result message back to the tool call that produced it. */
  toolCallId?: string;
}

export interface LlmToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Native generation stats, when the provider exposes them (Ollama does, on every response —
 * see qwen.provider.ts). Diagnostic only, added for the 2026-09-14 latency investigation: real
 * production calls showed 7-13s first-token delays that an isolated, identical-payload
 * benchmark against the same Qwen instance could NOT reproduce, and a controlled idle-gap test
 * showed `loadDurationMs` spiking to 5-7s at random (non-monotonic) gaps — evidence of
 * intermittent contention on the shared GPU box, not anything in this app's own request
 * shape. Persisting these on every real call (see OrchestratorService's 'latency.llm' /
 * 'latency.classification' audit logs) means the NEXT occurrence is diagnosed from a DB query
 * instead of another ad-hoc reproduction attempt.
 */
export interface LlmResponseStats {
  /** Ollama's own reported time to (re)load the model for this request. Near-zero when
   *  already resident; a multi-second value here means a real reload happened mid-conversation
   *  despite an effectively-infinite keep_alive — the clearest signal of GPU contention. */
  loadDurationMs?: number;
  promptEvalCount?: number;
  promptEvalDurationMs?: number;
  evalCount?: number;
  evalDurationMs?: number;
  totalDurationMs?: number;
  /** DIAGNOSTIC ONLY (2026-09-17, no behavior change) — added for a diagnostic-only phase
   *  correlating loadDurationMs spikes with concurrency. How many OTHER Qwen requests (from
   *  this same process — classification, language-judge, another turn's main-response, etc.)
   *  were already in flight the instant this one started, and which ones (by label). This was
   *  previously computed (see qwen.provider.ts's beginQwenRequest) but only ever reached a
   *  console log line — never persisted, so it couldn't be queried after the fact. */
  concurrentAtStart?: number;
  othersAtStart?: string;
  /** How long this request sat waiting for the QwenConcurrencyGate before Ollama's fetch() was
   *  even issued (2026-09-24, normal-turn latency fix) — near-zero when the gate was free,
   *  otherwise the time another request (by priority/label — see othersAtStart) held it. This is
   *  the piece concurrentAtStart/othersAtStart alone couldn't show: THAT another request was
   *  also in flight, not how much it actually cost this one to wait its turn. */
  gateWaitMs?: number;
  /** The priority this request was actually queued with (see LlmGenerateOptions.priority). */
  gatePriority?: 'high' | 'low';
  /** DIAGNOSTIC ONLY (2026-09-17) — the model name Ollama itself reports serving this request
   *  (its `model` field, e.g. "qwen3.5:4b") — lets a runner-identity mismatch (an unexpected
   *  model/quantization actually answering) show up in the same log instead of being assumed. */
  model?: string;
}

export interface LlmResponse {
  /** Final natural-language reply. Present when the model is not requesting a tool. */
  content?: string;
  /** One or more tool calls the orchestrator must validate and execute. */
  toolCalls?: LlmToolCall[];
  /** Diagnostic only — populated by providers that expose native generation stats (Ollama).
   *  Absent entirely for providers that don't have this data (e.g. the mock provider). */
  stats?: LlmResponseStats;
}

/**
 * Port for the reasoning engine (Qwen 3.5 in production). The orchestrator is the only
 * caller of this interface — it never lets the LLM touch the database or external APIs
 * directly, only structured tool-call requests that the orchestrator validates.
 */
export interface LlmGenerateOptions {
  /** Caps the model's own generated-token budget for this one call (Ollama's `num_predict`).
   *  Added after a live incident (2026-09-10): a short, tightly-scoped judge/classifier prompt
   *  (see CallsService.pickSpokenLanguage, OrchestratorService.classifyMessage) went into a
   *  degenerate/repetitive generation with no natural stopping point, taking 30+ seconds and
   *  returning malformed JSON — an unbounded call has no ceiling on how badly that can go.
   *
   *  UPDATED (2026-09-15 latency pass): the main conversational reply is now ALSO capped (see
   *  OrchestratorService's main-response calls), at a value generous enough that no real reply
   *  in this domain gets anywhere near it (the largest observed — a full default-5 transaction
   *  listing — is well under half of it) — this is a safety net against a runaway/rambling
   *  generation costing real seconds, not a hard limit meant to ever actually bind. Also only
   *  just started being honored for generateStream() at all — see QwenProvider's own fix note. */
  maxTokens?: number;
  /** Purely diagnostic (2026-09-14 Qwen-contention audit) — identifies WHICH concurrent caller
   *  this request is (e.g. 'main-response', 'classification', 'language-judge') so the shared
   *  Qwen instance's own request log can show whether two DIFFERENT call sites' requests were
   *  ever genuinely in flight at the same time, not just that the model was slow in general.
   *  No effect on the request sent to Qwen itself. */
  label?: string;
  /** Ordering against the QwenConcurrencyGate (2026-09-24, normal-turn latency fix) — the shared
   *  Qwen instance only ever serves one request at a time, so this decides who goes first when
   *  more than one caller wants it. 'high' (the default when omitted) is for anything
   *  customer-facing/blocking on the critical path (the main reply, the language judge). 'low'
   *  is for background work that must never make a customer wait or evict the main reply's
   *  cached prompt context mid-flight (classification, summarization). See
   *  qwen-concurrency-gate.ts for exactly how priority is arbitrated. */
  priority?: 'high' | 'low';
}

export interface LlmProvider {
  generate(messages: LlmMessage[], tools: LlmToolSchema[], options?: LlmGenerateOptions): Promise<LlmResponse>;
  /** Produces a short human-readable summary of a transcript, e.g. for human handoff. */
  summarize(messages: LlmMessage[]): Promise<string>;
  /**
   * Streaming variant — same contract/return value as generate(), but invokes onTextDelta for
   * each piece of text as it's generated.
   *
   * CORRECTION (2026-09-15): this used to claim "a tool-calling decision arrives as a complete,
   * non-streamed tool_calls object with no content ever leaked beforehand, so onTextDelta only
   * ever fires for genuine final customer-facing text." Confirmed LIVE that this is false for
   * the real Qwen deployment (QwenProvider): the model can stream a few words of natural-
   * language preamble via normal content deltas BEFORE the same response's tool_calls appear
   * on a later line of the same stream — onTextDelta fires for those words like any other
   * delta, and the implementation has no way to know in advance that the response will turn
   * out to be a tool call. Callers that turn deltas into spoken audio (or persist them anywhere
   * before the final `LlmResponse` resolves) must be prepared for onTextDelta to fire during an
   * iteration that ultimately returns `{toolCalls}` rather than `{content}` — see
   * OrchestratorService.HandleMessageParams.onToolPreambleSpoken for how that case is now
   * surfaced back to callers instead of silently discarded. Optional: a provider without real
   * token-level streaming (e.g. the mock, or a future provider) can omit this; callers fall
   * back to generate() whenever it's absent, and should also fall back to it if a call to it
   * throws.
   */
  generateStream?(
    messages: LlmMessage[],
    tools: LlmToolSchema[],
    onTextDelta: (delta: string) => void,
    options?: LlmGenerateOptions,
  ): Promise<LlmResponse>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
