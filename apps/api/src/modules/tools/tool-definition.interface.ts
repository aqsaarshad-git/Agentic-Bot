import { z } from 'zod';
import { AuthPrincipal } from '../../common/types/auth-principal';

export interface ToolExecutionContext {
  requestId?: string;
  actor?: AuthPrincipal;
  customerId?: string;
  conversationId?: string;
  messageId?: string;
  callId?: string;
  /** Tool names the invoking AI agent's config allows — enforced by ToolRegistryService. */
  allowedTools: string[];
}

export interface ToolDefinition<TArgs = any, TResult = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TArgs>;
  /** JSON Schema handed to the LLM provider describing the tool's arguments. */
  parametersJsonSchema: Record<string, unknown>;
  /**
   * Read-only/side-effect-free tools (lookups) are safe to retry once on transient
   * failure. Tools with side effects (create_ticket, schedule_callback, ...) must
   * NOT be marked idempotent, since a blind retry could double the action.
   */
  idempotent?: boolean;
  handler: (ctx: ToolExecutionContext, args: TArgs) => Promise<TResult>;
}
