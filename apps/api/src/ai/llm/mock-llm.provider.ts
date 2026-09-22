import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LlmMessage, LlmProvider, LlmResponse, LlmToolCall, LlmToolSchema } from './llm-provider.interface';

/**
 * Deterministic, rule-based stand-in for Qwen 3.5. Lets the full orchestrator loop
 * (intent -> tool call -> validation -> execution -> final response) be built and
 * demoed end-to-end before real Qwen credentials are available. Swapping this for
 * QwenProvider is a config change only (see ai/llm/llm.module.ts).
 */
@Injectable()
export class MockLlmProvider implements LlmProvider {
  private readonly logger = new Logger(MockLlmProvider.name);

  async generate(messages: LlmMessage[], tools: LlmToolSchema[]): Promise<LlmResponse> {
    const toolNames = new Set(tools.map((t) => t.name));
    const last = messages[messages.length - 1];

    if (last?.role === 'tool') {
      return { content: this.summarizeToolResult(last) };
    }

    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = (lastUser?.content ?? '').toLowerCase();

    const call = (name: string, args: Record<string, unknown>): LlmResponse => ({
      toolCalls: [{ id: randomUUID(), name, arguments: args } as LlmToolCall],
    });

    if (toolNames.has('transfer_to_human') && /\b(human|agent|representative|person)\b/.test(text)) {
      return call('transfer_to_human', { reason: 'Customer explicitly requested a human agent' });
    }

    if (toolNames.has('schedule_callback') && /call\s*(me|back)|callback/.test(text)) {
      const { date, time } = this.extractCallbackTiming(text);
      return call('schedule_callback', {
        requested_date: date,
        requested_time: time,
        reason: lastUser?.content ?? 'Customer requested a callback',
      });
    }

    if (toolNames.has('get_balance') && text.includes('balance')) {
      return call('get_balance', {});
    }

    if (toolNames.has('get_transactions') && /\b(transaction|payment|charge|paid|pay)\b/.test(text)) {
      return call('get_transactions', {});
    }

    if (toolNames.has('get_account') && text.includes('account')) {
      return call('get_account', {});
    }

    if (
      toolNames.has('create_ticket') &&
      /\b(ticket|complain|complaint|problem|issue|not working|refund)\b/.test(text)
    ) {
      return call('create_ticket', {
        category: 'general',
        priority: 'MEDIUM',
        description: lastUser?.content ?? 'Customer reported an issue.',
      });
    }

    this.logger.debug(`No rule matched, falling back to a clarifying response for: "${text}"`);
    return {
      content:
        "I'm here to help. Could you tell me a bit more — is this about a payment, your account balance, or something else?",
    };
  }

  /** Very light heuristic date/time extraction — good enough for a mock demo, not real NLU. */
  private extractCallbackTiming(text: string): { date: string; time: string } {
    const today = new Date();
    const target = new Date(today);
    if (!/\btoday\b/.test(text)) {
      target.setDate(target.getDate() + 1); // default: tomorrow, unless "today" is mentioned
    }
    const date = target.toISOString().slice(0, 10);

    const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    let time = '15:00';
    if (timeMatch) {
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ?? '00';
      const meridiem = timeMatch[3]?.toLowerCase();
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      if (hour >= 0 && hour <= 23) {
        time = `${String(hour).padStart(2, '0')}:${minute}`;
      }
    }
    return { date, time };
  }

  /** Mock-only behavior for the streaming pipeline's own dev-testing: a tool-call decision is
   *  returned immediately with no streamed text at all, while a genuine final-text reply is
   *  split into word-sized deltas so the incremental-TTS pipeline can be exercised end-to-end
   *  without needing live Qwen credentials.
   *
   *  CORRECTION (2026-09-15): this used to claim the real deployment matches this — confirmed
   *  LIVE that it does not. The real QwenProvider can stream genuine preamble text before a
   *  response resolves to a tool call (see OrchestratorService.HandleMessageParams.
   *  onToolPreambleSpoken); this mock deliberately does NOT reproduce that, since it's
   *  intermittent/non-deterministic in the real model, not something worth faking here — code
   *  exercised only against this mock should not assume onTextDelta is silent during a
   *  tool-calling iteration. */
  async generateStream(
    messages: LlmMessage[],
    tools: LlmToolSchema[],
    onTextDelta: (delta: string) => void,
  ): Promise<LlmResponse> {
    const response = await this.generate(messages, tools);
    if (response.toolCalls) return response;

    const text = response.content ?? '';
    const words = text.split(/(?<=\s)/); // keep trailing spaces attached to each word
    for (const word of words) {
      onTextDelta(word);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return response;
  }

  async summarize(messages: LlmMessage[]): Promise<string> {
    const customerLines = messages.filter((m) => m.role === 'user').map((m) => m.content);
    if (customerLines.length === 0) {
      return 'No customer messages yet.';
    }
    const first = customerLines[0].slice(0, 160);
    const last = customerLines[customerLines.length - 1].slice(0, 160);
    return customerLines.length === 1
      ? `Customer said: "${first}"`
      : `Customer initially said: "${first}". Most recent message: "${last}".`;
  }

  private summarizeToolResult(toolMessage: LlmMessage): string {
    let data: any = {};
    try {
      data = JSON.parse(toolMessage.content);
    } catch {
      // leave data as {}
    }

    switch (toolMessage.name) {
      case 'create_ticket':
        return `I've created ticket ${data.ticketNumber ?? ''} for you. Our team will follow up, and you can check its status anytime.`;
      case 'transfer_to_human':
        return "I'm connecting you with a human agent now — you won't need to repeat what you've told me.";
      case 'schedule_callback':
        return `Got it — I've scheduled a callback for ${data.requestedDate ?? 'the requested time'} at ${data.requestedTime ?? ''}.`;
      case 'get_balance':
        return `Your current balance is ${data.balance ?? 'unavailable'} ${data.currency ?? ''}.`.trim();
      case 'get_account':
        return `Your account ${data.accountNumber ?? ''} is a ${data.accountType?.toLowerCase() ?? ''} account, currently ${data.status?.toLowerCase() ?? 'unknown'}.`;
      case 'get_transactions': {
        const transactions = Array.isArray(data.transactions) ? data.transactions : [];
        const failed = transactions.find((t: any) => t.status === 'FAILED');
        if (failed) {
          return `I see a failed transaction: ${failed.id} on ${failed.date} for ${failed.amount} ${failed.currency} — reason: ${failed.reason ?? 'unknown'}. Would you like me to open a ticket about it?`;
        }
        const pending = transactions.find((t: any) => t.status === 'PENDING');
        if (pending) {
          return `Your most recent activity is transaction ${pending.id} on ${pending.date} for ${pending.amount} ${pending.currency}, which is still pending — it hasn't completed yet.`;
        }
        const latest = transactions[0];
        return latest
          ? `Your most recent transaction was ${latest.id} on ${latest.date} for ${latest.amount} ${latest.currency} (${latest.status?.toLowerCase()}).`
          : 'I could not find any recent transactions.';
      }
      case 'get_customer':
        return `I found your account: ${data.fullName ?? 'on file'}.`;
      case 'get_ticket':
        return `Ticket ${data.ticketNumber ?? ''} is currently "${data.status ?? 'unknown'}".`;
      case 'update_ticket':
        return `I've updated ticket ${data.ticketNumber ?? ''}.`;
      case 'escalate_ticket':
        return `I've escalated ticket ${data.ticketNumber ?? ''} to a specialist.`;
      case 'end_call':
        return 'Thanks for contacting us — ending the conversation now. Have a great day!';
      default:
        return `Here's what I found: ${toolMessage.content}`;
    }
  }
}
