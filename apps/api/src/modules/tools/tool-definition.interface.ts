import { z } from 'zod';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { VerificationLevel } from './verification-level';

export interface ToolExecutionContext {
  requestId?: string;
  actor?: AuthPrincipal;
  customerId?: string;
  conversationId?: string;
  messageId?: string;
  callId?: string;
  /** Tool names the invoking AI agent's config allows — enforced by ToolRegistryService. */
  allowedTools: string[];
  /**
   * Computed fresh every turn by the orchestrator from VerificationService — never
   * supplied by, or inferable from, the LLM. Enforced generically in
   * ToolRegistryService.validateAndExecute against each tool's minVerificationLevel.
   */
  verificationLevel: VerificationLevel;
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
  /** Minimum authorization tier required to invoke this tool. Defaults to AUTHENTICATED. */
  minVerificationLevel?: VerificationLevel;
  /**
   * Argument keys that must never be persisted in plaintext (e.g. an OTP code) — redacted
   * to '[REDACTED]' before ToolRegistryService writes requestArgs into tool_executions.
   */
  sensitiveArgs?: string[];
  handler: (ctx: ToolExecutionContext, args: TArgs) => Promise<TResult>;
}
