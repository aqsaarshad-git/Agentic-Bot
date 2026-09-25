export type QwenGatePriority = 'high' | 'low';

/**
 * Single-concurrency gate for the shared Qwen/Ollama instance (one GPU, one loaded model, one
 * real KV-cache slot — see QwenProvider's own doc comment). Added for the 2026-09-24 normal-turn
 * latency investigation: a customer-facing main-response call and the per-turn emotion
 * classification call were both firing straight at Ollama with no ordering between them, so
 * whichever one lost the race got queued AND had its prompt's cached context evicted by the
 * other's unrelated prompt — on a real call, this alone accounted for ~4s of a ~6s "normal"
 * turn's first-token latency (see the investigation notes this fix responds to; no separate
 * write-up kept in this codebase, per the no-extra-docs convention — the numbers are in this
 * commit's PR description).
 *
 * This does NOT talk to Ollama itself — every actual request still goes through the exact same
 * fetch() calls in QwenProvider. It only decides WHEN each caller's request is allowed to start,
 * one at a time, so two Qwen requests are never in flight together against the same instance.
 *
 * Priority: 'high' (customer-facing — main response, language-judge) always goes before a
 * fresh 'low' (classification, summarization, the keep-alive ping) waiter. A 'low' waiter that's
 * been waiting past STARVATION_MS is promoted to eligible so it can never be starved forever by
 * a continuous stream of 'high' requests — see dequeueNext.
 */
export class QwenConcurrencyGate {
  private static readonly STARVATION_MS = 5000;

  private busy = false;
  private readonly waiters: Array<{
    priority: QwenGatePriority;
    enqueuedAt: number;
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  /** Resolves once this caller may proceed; call the returned function when the Qwen request
   *  (the WHOLE request — through the last streamed byte for generateStream, not just until
   *  headers arrive) is actually done, to let the next waiter in. `signal`, if given, only
   *  cancels the WAIT — an already-acquired gate is the caller's to release, this never aborts
   *  an in-flight Ollama request itself. */
  acquire(priority: QwenGatePriority, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted before acquiring Qwen gate', 'AbortError'));
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { priority, enqueuedAt: Date.now(), resolve: () => {}, reject };
      waiter.resolve = () => resolve(() => this.release());
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          reject(new DOMException('Aborted while waiting for Qwen gate', 'AbortError'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.busy = false;
    this.dequeueNext();
  }

  private dequeueNext(): void {
    if (this.busy || this.waiters.length === 0) return;
    const now = Date.now();

    // Eligible = high priority, or a low-priority waiter that's aged past the starvation cap.
    // Oldest eligible waiter wins (FIFO within/across the eligible set).
    let bestIdx = -1;
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      const starved = now - w.enqueuedAt >= QwenConcurrencyGate.STARVATION_MS;
      if (w.priority === 'low' && !starved) continue;
      if (bestIdx === -1 || w.enqueuedAt < this.waiters[bestIdx].enqueuedAt) bestIdx = i;
    }
    if (bestIdx === -1) {
      // Nothing high-priority or starved is waiting — only fresh low-priority work. Serve the
      // oldest of it rather than leaving the gate idle for no one.
      bestIdx = 0;
      for (let i = 1; i < this.waiters.length; i++) {
        if (this.waiters[i].enqueuedAt < this.waiters[bestIdx].enqueuedAt) bestIdx = i;
      }
    }

    const [winner] = this.waiters.splice(bestIdx, 1);
    if (winner.signal && winner.onAbort) winner.signal.removeEventListener('abort', winner.onAbort);
    this.busy = true;
    winner.resolve();
  }
}
