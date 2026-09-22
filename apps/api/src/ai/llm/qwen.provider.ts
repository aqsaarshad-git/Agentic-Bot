import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { LlmGenerateOptions, LlmMessage, LlmProvider, LlmResponse, LlmResponseStats, LlmToolSchema } from './llm-provider.interface';

/**
 * Adapter for Qwen 3.5, served by Ollama (confirmed live deployment — see
 * credentials_guidance memory). Uses Ollama's NATIVE `/api/chat` endpoint, not its
 * OpenAI-compatible `/v1/chat/completions` layer — verified directly that the two
 * behave very differently for this hybrid-reasoning model:
 *
 *   - `/v1/chat/completions` ignores a top-level `think` flag entirely; every call
 *     pays for a full internal "reasoning" pass regardless (measured ~16s for a
 *     trivial "2+2" prompt).
 *   - `/api/chat` with `"think": false` genuinely skips that pass (~1-2.5s for the
 *     same prompts, tool-calling included) — a straight ~10x latency win, and it's a
 *     request parameter, not a change to the GPU box itself.
 *
 * Also note the response shapes differ from OpenAI's: the message lives at
 * `json.message` (no `choices` array), and `tool_calls[].function.arguments` is
 * already a parsed object, not a JSON-encoded string.
 */
const QWEN_TIMEOUT_MS = 90_000;

// AUDIT INSTRUMENTATION ONLY (2026-09-14 Qwen-contention investigation — no behavior change).
// Module-level (not per-instance) since QwenProvider is a singleton for the whole process
// anyway, but this makes it explicit: every caller — classification, the main reply, the
// language judge, tool-iteration calls — shares ONE counter, because they share ONE real Qwen
// instance. The question this exists to answer: when a request is slow, was something ELSE
// (which label?) ALSO in flight against the same instance at the same time?
let qwenRequestSeq = 0;
const activeQwenRequests = new Map<number, { label: string; startedAt: number }>();

/** Ollama reports these in nanoseconds on every /api/chat response (non-streaming: on the
 *  single response body; streaming: on the final `done: true` NDJSON line) — see
 *  LlmResponseStats's doc comment for why this is captured on every call now. */
function extractStats(json: any): LlmResponseStats {
  const ns = (v: unknown) => (typeof v === 'number' ? Math.round(v / 1e6) : undefined);
  return {
    loadDurationMs: ns(json?.load_duration),
    promptEvalCount: typeof json?.prompt_eval_count === 'number' ? json.prompt_eval_count : undefined,
    promptEvalDurationMs: ns(json?.prompt_eval_duration),
    evalCount: typeof json?.eval_count === 'number' ? json.eval_count : undefined,
    evalDurationMs: ns(json?.eval_duration),
    totalDurationMs: ns(json?.total_duration),
  };
}

function beginQwenRequest(label: string): { id: number; concurrentAtStart: number; othersAtStart: string } {
  const id = ++qwenRequestSeq;
  const others = [...activeQwenRequests.entries()].map(([otherId, v]) => `#${otherId}:${v.label}`);
  activeQwenRequests.set(id, { label, startedAt: Date.now() });
  return { id, concurrentAtStart: others.length, othersAtStart: others.length ? others.join(',') : 'none' };
}

function endQwenRequest(id: number): { concurrentAtEnd: number; othersAtEnd: string } {
  activeQwenRequests.delete(id);
  const others = [...activeQwenRequests.entries()].map(([otherId, v]) => `#${otherId}:${v.label}`);
  return { concurrentAtEnd: others.length, othersAtEnd: others.length ? others.join(',') : 'none' };
}

@Injectable()
export class QwenProvider implements LlmProvider {
  private readonly logger = new Logger(QwenProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>('llm.qwenBaseUrl') ?? '';
    this.apiKey = this.config.get<string>('llm.qwenApiKey') ?? '';
    this.model = this.config.get<string>('llm.qwenModel') ?? 'qwen3.5';
  }

  async generate(messages: LlmMessage[], tools: LlmToolSchema[], options?: LlmGenerateOptions): Promise<LlmResponse> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException(
        'Qwen provider is selected but QWEN_BASE_URL is not configured.',
      );
    }
    const label = options?.label ?? 'unlabeled';
    const { id: qwenReqId, concurrentAtStart, othersAtStart } = beginQwenRequest(label);
    const qwenStartedAt = Date.now();
    this.logger.log(`[QWEN] #${qwenReqId} (${label}) start concurrentAtStart=${concurrentAtStart} others=[${othersAtStart}]`);

    try {
      const body = {
        model: this.model,
        think: false,
        stream: false,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.name ? { tool_name: m.name } : {}),
        })),
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        ...(options?.maxTokens ? { options: { num_predict: options.maxTokens } } : {}),
      };

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(QWEN_TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        this.logger.error(
          timedOut ? `Qwen request timed out after ${QWEN_TIMEOUT_MS}ms` : 'Qwen request failed',
          error instanceof Error ? error.stack : String(error),
        );
        throw new ServiceUnavailableException('The AI reasoning service is temporarily unavailable.');
      }

      if (!res.ok) {
        this.logger.error(`Qwen returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
        throw new ServiceUnavailableException('The AI reasoning service is temporarily unavailable.');
      }

      const json: any = await res.json();
      const message = json?.message;
      if (!message) {
        throw new ServiceUnavailableException('The AI reasoning service returned an unexpected response.');
      }

      // DIAGNOSTIC ONLY (2026-09-17, no behavior change): merged onto every returned stats
      // object below so both call sites (tool_calls and content) get it without duplicating —
      // see LlmResponseStats' own doc comments for what these mean.
      const diagStats = { concurrentAtStart, othersAtStart, model: json?.model };

      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        return {
          toolCalls: message.tool_calls.map((tc: any) => ({
            id: tc.id ?? randomUUID(),
            name: tc.function?.name,
            arguments: this.normalizeArgs(tc.function?.arguments),
          })),
          stats: { ...extractStats(json), ...diagStats },
        };
      }

      return { content: message.content ?? '', stats: { ...extractStats(json), ...diagStats } };
    } finally {
      const { concurrentAtEnd, othersAtEnd } = endQwenRequest(qwenReqId);
      this.logger.log(
        `[QWEN] #${qwenReqId} (${label}) end duration=${Date.now() - qwenStartedAt}ms concurrentAtEnd=${concurrentAtEnd} others=[${othersAtEnd}]`,
      );
    }
  }

  /**
   * Streaming variant of generate() — same request shape (`stream: true` instead of false),
   * same response semantics, but reads Ollama's native NDJSON stream and calls onTextDelta as
   * each piece of final-reply text arrives, instead of waiting for the whole response.
   *
   * Verified live against the real deployment (2026-09-10) before writing this:
   *   - Plain-text responses: one NDJSON line per token/word, each
   *     `{"message":{"content":"<delta>"},"done":false}`, ending in one
   *     `{"message":{"content":""},"done":true,...stats}` line.
   *   - Tool-call responses: `tool_calls` arrives as a COMPLETE, already-parsed object (never
   *     fragmented character-by-character) with `content` always empty on that same line — no
   *     text is ever leaked before a tool-call decision, confirmed with both single- and
   *     multi-tool-call prompts. A response with MULTIPLE tool calls sends ONE tool_calls
   *     entry per NDJSON line (each tagged with `function.index`), not one line with an array
   *     of all of them — hence the index-keyed accumulation below, needed to reassemble them
   *     into one list before returning.
   * Because of the above, onTextDelta only ever fires for genuine final customer-facing text
   * — the caller does not need its own logic to keep tool-call text out of it.
   */
  async generateStream(
    messages: LlmMessage[],
    tools: LlmToolSchema[],
    onTextDelta: (delta: string) => void,
    options?: LlmGenerateOptions,
  ): Promise<LlmResponse> {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException('Qwen provider is selected but QWEN_BASE_URL is not configured.');
    }
    const label = options?.label ?? 'unlabeled';
    const { id: qwenReqId, concurrentAtStart, othersAtStart } = beginQwenRequest(label);
    const qwenStartedAt = Date.now();
    let firstTokenAt: number | null = null;
    this.logger.log(`[QWEN] #${qwenReqId} (${label}) start concurrentAtStart=${concurrentAtStart} others=[${othersAtStart}]`);

    try {
    const body = {
      model: this.model,
      think: false,
      stream: true,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { tool_name: m.name } : {}),
      })),
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      // BUG FIX (2026-09-15 latency pass): generate() has honored options.maxTokens via
      // num_predict since it was added; this streaming variant silently never did, so any
      // caller setting maxTokens here (e.g. OrchestratorService's main-response calls) got no
      // actual bound on generation length — a real gap given generateStream is what every real
      // PSTN/browser call actually uses (generate() is only the fallback). Mirrors generate()'s
      // own line exactly.
      ...(options?.maxTokens ? { options: { num_predict: options.maxTokens } } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(QWEN_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      this.logger.error(
        timedOut ? `Qwen streaming request timed out after ${QWEN_TIMEOUT_MS}ms` : 'Qwen streaming request failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException('The AI reasoning service is temporarily unavailable.');
    }

    if (!res.ok || !res.body) {
      this.logger.error(`Qwen streaming returned HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      throw new ServiceUnavailableException('The AI reasoning service is temporarily unavailable.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';
    let fullContent = '';
    // Keyed by function.index — see the class doc comment above for why: a multi-tool-call
    // response sends one entry per NDJSON line, not one line with the whole array. Merging
    // (rather than overwriting) each field defensively handles a hypothetical future
    // deployment that DOES fragment a single call's own arguments across lines, even though
    // that was never observed for this one.
    const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: Record<string, unknown> }>();
    // The final NDJSON line (done: true) carries the same native stats as the non-streaming
    // response — see extractStats's doc comment. Captured here purely for the audit log the
    // caller attaches to LlmResponse.stats; no effect on delta delivery above.
    let finalStats: LlmResponseStats = {};

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lineBuffer += decoder.decode(value, { stream: true });
        let newlineAt: number;
        while ((newlineAt = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.slice(0, newlineAt).trim();
          lineBuffer = lineBuffer.slice(newlineAt + 1);
          if (!line) continue;

          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            this.logger.warn(`Qwen stream sent a malformed NDJSON line, skipping it: ${line.slice(0, 200)}`);
            continue;
          }

          if (parsed?.done === true) {
            // DIAGNOSTIC ONLY (2026-09-17, no behavior change): concurrentAtStart/othersAtStart
            // reflect the moment THIS request began (captured above, before the fetch), not
            // whatever else may be running by the time the stream finishes — that's the
            // question this whole phase needs answered, so it must be the start-time snapshot.
            finalStats = { ...extractStats(parsed), concurrentAtStart, othersAtStart, model: parsed?.model };
          }

          const message = parsed?.message;
          if (firstTokenAt === null && (message?.tool_calls?.length || message?.content?.length)) {
            firstTokenAt = Date.now();
            this.logger.log(`[QWEN] #${qwenReqId} (${label}) first token after ${firstTokenAt - qwenStartedAt}ms`);
          }
          if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
            for (const tc of message.tool_calls) {
              const index = typeof tc.function?.index === 'number' ? tc.function.index : toolCallsByIndex.size;
              const existing = toolCallsByIndex.get(index);
              toolCallsByIndex.set(index, {
                id: tc.id ?? existing?.id ?? randomUUID(),
                name: tc.function?.name ?? existing?.name ?? '',
                arguments: { ...(existing?.arguments ?? {}), ...this.normalizeArgs(tc.function?.arguments) },
              });
            }
          } else if (typeof message?.content === 'string' && message.content.length > 0) {
            fullContent += message.content;
            onTextDelta(message.content);
          }
        }
      }
    } catch (error) {
      // A drop mid-stream (as opposed to the connection never opening at all, handled by the
      // outer try/catch above) is handled by the caller (OrchestratorService) — it knows
      // whether any text was already streamed to the customer and decides accordingly whether
      // a fresh non-streaming retry would risk duplicate/contradictory audio.
      this.logger.error('Qwen stream was interrupted mid-response', error instanceof Error ? error.stack : String(error));
      throw error;
    }

    if (toolCallsByIndex.size > 0) {
      return { toolCalls: Array.from(toolCallsByIndex.values()), stats: finalStats };
    }
    return { content: fullContent, stats: finalStats };
    } finally {
      const { concurrentAtEnd, othersAtEnd } = endQwenRequest(qwenReqId);
      this.logger.log(
        `[QWEN] #${qwenReqId} (${label}) end duration=${Date.now() - qwenStartedAt}ms concurrentAtEnd=${concurrentAtEnd} others=[${othersAtEnd}]`,
      );
    }
  }

  async summarize(messages: LlmMessage[]): Promise<string> {
    const summaryPrompt: LlmMessage = {
      role: 'system',
      content:
        'Summarize this customer support conversation in 1-2 sentences for a human agent taking over. ' +
        'Focus on what the customer wants and what has already been tried.',
    };
    const result = await this.generate([summaryPrompt, ...messages], []);
    return result.content?.trim() || 'No summary available.';
  }

  /** Ollama's native API returns already-parsed argument objects; guard for a JSON string anyway. */
  private normalizeArgs(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    if (typeof raw !== 'string') return {};
    try {
      return JSON.parse(raw);
    } catch {
      this.logger.warn(`Qwen returned malformed tool arguments JSON: ${raw}`);
      return {};
    }
  }
}
