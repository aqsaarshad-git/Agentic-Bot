import { Injectable } from '@nestjs/common';
import { Message } from '@prisma/client';
import { LlmMessage } from '../../ai/llm/llm-provider.interface';

@Injectable()
export class ContextBuilderService {
  /** Bounded conversation window handed to the LLM — never the full customer history. */
  private readonly MAX_TURNS = 12;

  build(messages: Message[], systemInstructions: string, extraContext: string[] = []): LlmMessage[] {
    const recent = messages.slice(-this.MAX_TURNS);
    const history: LlmMessage[] = recent.map((m) => ({
      role: m.sender === 'CUSTOMER' ? 'user' : m.sender === 'AI' ? 'assistant' : 'system',
      content: m.content,
    }));
    const contextMessages: LlmMessage[] = extraContext
      .filter(Boolean)
      .map((content) => ({ role: 'system', content }));
    return [{ role: 'system', content: systemInstructions }, ...contextMessages, ...history];
  }
}
