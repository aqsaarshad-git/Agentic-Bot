import { ForbiddenException } from '@nestjs/common';

/**
 * Backend-owned authorization tier for a tool call. Computed once per turn by the
 * orchestrator from the database (VerificationService.computeLevel) — NEVER inferred
 * from the LLM, and never cached on the customer JWT (a JWT proves identity was
 * bootstrapped once; it says nothing about whether THIS conversation has since
 * completed a step-up verification).
 */
export enum VerificationLevel {
  PUBLIC = 0,
  AUTHENTICATED = 1,
  VERIFIED = 2,
}

export function meetsLevel(current: VerificationLevel, required: VerificationLevel): boolean {
  return current >= required;
}

export class InsufficientVerificationException extends ForbiddenException {
  constructor(
    public readonly requiredLevel: VerificationLevel,
    public readonly currentLevel: VerificationLevel,
  ) {
    super('This action requires additional identity verification.');
  }
}
