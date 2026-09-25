import { NotFoundException } from '@nestjs/common';
import { ToolExecutionContext } from '../tool-definition.interface';

export function requireCustomerId(ctx: ToolExecutionContext): string {
  if (!ctx.customerId) {
    throw new NotFoundException('No customer associated with this conversation');
  }
  return ctx.customerId;
}

/**
 * True unless this is an EXPLICITLY staff-authenticated session (ctx.actor?.type === 'user')
 * — restricted-to-own-data is the safe default, not something a session has to opt into. Voice
 * calls never pass an `actor` at all (a call is inherently the customer's own), so only an
 * explicit staff actor (chat sent by an ADMIN/AGENT/SUPERVISOR) gets broader lookup access.
 */
export function isCustomerSession(ctx: ToolExecutionContext): boolean {
  return ctx.actor?.type !== 'user';
}

export function toJsonSchema(
  shape: Record<string, { type: string; description: string; enum?: string[] }>,
  required: string[],
) {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(shape).map(([key, val]) => [
        key,
        { type: val.type, description: val.description, ...(val.enum ? { enum: val.enum } : {}) },
      ]),
    ),
    required,
  };
}

/** Never expose a full account/card number to the LLM — only ever the last 4 digits. */
export function maskAccountNumber(accountNumber: string): string {
  return `****${accountNumber.slice(-4)}`;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const FAILURE_REASON_TEXT: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'insufficient funds',
  CARD_EXPIRED: 'a card expired',
  CARD_BLOCKED: 'a blocked card',
  ACCOUNT_SUSPENDED: 'an account suspension',
  LIMIT_EXCEEDED: 'exceeding a limit',
  INCORRECT_PIN: 'an incorrect PIN',
  ISSUER_DECLINED: 'the issuer declining it',
  NETWORK_ERROR: 'a network error',
  FRAUD_SUSPECTED: 'suspected fraud',
  OTHER: 'an unspecified issue',
};

export function humanizeFailureReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  return FAILURE_REASON_TEXT[reason] ?? reason.toLowerCase().replace(/_/g, ' ');
}
