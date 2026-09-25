import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditActorType, VerificationPurpose, VerificationSession } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VerificationLevel } from '../tools/verification-level';

const OTP_TTL_MS = 5 * 60 * 1000;
const VERIFIED_VALIDITY_MS = 15 * 60 * 1000;
const LOCKOUT_DURATION_MS = 30 * 60 * 1000;
const LOCKOUT_THRESHOLD = 3;
const MAX_ATTEMPTS = 3;

export type VerificationStatusView =
  | 'IDENTIFIED'
  | 'VERIFICATION_IN_PROGRESS'
  | 'VERIFIED'
  | 'VERIFICATION_FAILED'
  | 'LOCKED';

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly auditService: AuditService,
  ) {}

  /** The authorization tier a turn should run with — computed fresh every time, never cached. */
  async computeLevel(customerId: string, conversationId: string | undefined): Promise<VerificationLevel> {
    if (!customerId) return VerificationLevel.PUBLIC;
    if (!conversationId) return VerificationLevel.AUTHENTICATED;

    const session = await this.prisma.verificationSession.findFirst({
      where: { customerId, conversationId, purpose: 'IDENTITY' },
      orderBy: { createdAt: 'desc' },
    });
    if (session?.status === 'VERIFIED' && session.verifiedAt && Date.now() - session.verifiedAt.getTime() < VERIFIED_VALIDITY_MS) {
      return VerificationLevel.VERIFIED;
    }
    return VerificationLevel.AUTHENTICATED;
  }

  async computeStatus(customerId: string, conversationId: string | undefined): Promise<VerificationStatusView> {
    const session = conversationId
      ? await this.prisma.verificationSession.findFirst({
          where: { customerId, conversationId, purpose: 'IDENTITY' },
          orderBy: { createdAt: 'desc' },
        })
      : null;

    if (!session) return 'IDENTIFIED';
    if (session.status === 'LOCKED') {
      const stillLocked = session.lockedAt && Date.now() - session.lockedAt.getTime() < LOCKOUT_DURATION_MS;
      return stillLocked ? 'LOCKED' : 'IDENTIFIED';
    }
    if (session.status === 'VERIFIED') {
      const stillFresh = session.verifiedAt && Date.now() - session.verifiedAt.getTime() < VERIFIED_VALIDITY_MS;
      return stillFresh ? 'VERIFIED' : 'IDENTIFIED';
    }
    if (session.status === 'VERIFICATION_IN_PROGRESS' && session.expiresAt.getTime() > Date.now()) {
      return 'VERIFICATION_IN_PROGRESS';
    }
    return 'VERIFICATION_FAILED';
  }

  /**
   * Purpose-agnostic — unlike computeStatus (IDENTITY-only, for the customer-facing
   * get_verification_status tool), this is the precondition check for the deterministic
   * "customer just typed a 6-digit code" forcing layer in orchestrator.service.ts. A real gap
   * this closes: computeStatus alone missed a PIN_RESET/PASSWORD_RESET-purpose session entirely
   * (it only ever looked at purpose: IDENTITY), so the forcing layer never fired for those and
   * Qwen's own discretion — including the exact "narrate a fake completion" failure mode this
   * whole layer exists to prevent — ran instead. Mirrors verifyPendingCode's own "whatever this
   * conversation currently has pending" lookup.
   */
  async hasPendingCode(customerId: string, conversationId: string | undefined): Promise<boolean> {
    const session = await this.prisma.verificationSession.findFirst({
      where: { customerId, conversationId: conversationId ?? null, status: 'VERIFICATION_IN_PROGRESS' },
      orderBy: { createdAt: 'desc' },
    });
    return Boolean(session && session.expiresAt.getTime() > Date.now());
  }

  /**
   * Starts (or restarts) an OTP challenge for the given purpose/scope. Returns the plaintext
   * code ONLY to the caller for this one call — never persisted, never returned again. Tool
   * wrappers (start_verification, initiate_pin_reset, ...) must discard `code` and never put
   * it in a tool result; the REST bootstrap endpoints (/auth/customer-identify) are the only
   * callers allowed to echo it back, and only outside production.
   */
  async createSession(params: {
    customerId: string;
    conversationId?: string;
    purpose: VerificationPurpose;
    targetRef?: string;
  }): Promise<{ session: VerificationSession; code: string }> {
    const { customerId, conversationId, purpose, targetRef } = params;

    const lockedUntil = await this.getActiveLockout(customerId, purpose);
    if (lockedUntil) {
      throw new BadRequestException(
        `Too many failed verification attempts. Please try again after ${lockedUntil.toISOString()}.`,
      );
    }

    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) {
      throw new BadRequestException('Customer not found');
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = await bcrypt.hash(code, 10);

    const session = await this.prisma.verificationSession.create({
      data: {
        customerId,
        conversationId,
        purpose,
        targetRef,
        method: customer.email ? 'OTP_EMAIL' : 'OTP_SMS',
        codeHash,
        status: 'VERIFICATION_IN_PROGRESS',
        maxAttempts: MAX_ATTEMPTS,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    await this.notifications.send({
      recipientType: 'CUSTOMER',
      recipientId: customerId,
      channel: customer.email ? 'EMAIL' : 'SMS',
      subject: 'Your verification code',
      content: `Your verification code is ${code}. It expires in 5 minutes.`,
      redactedContent: 'Your verification code is [REDACTED]. It expires in 5 minutes.',
    });

    await this.auditService.log({
      actorType: AuditActorType.CUSTOMER,
      actorId: customerId,
      action: 'verification.otp_sent',
      entityType: 'verification_session',
      entityId: session.id,
      result: { purpose, method: session.method },
      success: true,
    });

    return { session, code };
  }

  /** Tool-safe wrapper around createSession — never returns the plaintext code. */
  async startVerification(params: {
    customerId: string;
    conversationId?: string;
    purpose: VerificationPurpose;
    targetRef?: string;
  }): Promise<{ started: true; method: string; expiresInMinutes: number }> {
    const { session } = await this.createSession(params);
    return { started: true, method: session.method, expiresInMinutes: OTP_TTL_MS / 60_000 };
  }

  async verifyOtp(params: {
    customerId: string;
    conversationId?: string;
    purpose: VerificationPurpose;
    code: string;
  }): Promise<{ verified: true }> {
    const { customerId, conversationId, purpose, code } = params;
    const session = await this.prisma.verificationSession.findFirst({
      where: { customerId, conversationId: conversationId ?? null, purpose, status: 'VERIFICATION_IN_PROGRESS' },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) {
      throw new UnauthorizedException('No verification is currently in progress');
    }
    return this.verifySession(session, code);
  }

  /**
   * Purpose-agnostic entry point — resolves to whatever this conversation's most recent
   * in-progress session actually is (identity, PIN reset, or password reset), regardless of
   * which flow started it. This exists because a small model reliably confuses three separate
   * purpose-specific "verify" tools (confirmed live: it called the PIN-reset one for a code
   * that actually belonged to the general identity session) — the fix is the same "acts on
   * whatever this conversation currently has pending" pattern already used by confirm_transfer,
   * which needs no tool-selection judgment at all.
   */
  async verifyPendingCode(customerId: string, conversationId: string | undefined, code: string): Promise<{ verified: true }> {
    const session = await this.prisma.verificationSession.findFirst({
      where: { customerId, conversationId: conversationId ?? null, status: 'VERIFICATION_IN_PROGRESS' },
      orderBy: { createdAt: 'desc' },
    });
    if (!session) {
      throw new UnauthorizedException('No verification is currently in progress');
    }
    return this.verifySession(session, code);
  }

  private async verifySession(session: VerificationSession, code: string): Promise<{ verified: true }> {
    const customerId = session.customerId;
    const purpose = session.purpose;
    const devBypassCode = this.config.get<string>('auth.otpDevBypassCode');

    if (devBypassCode && code === devBypassCode) {
      await this.prisma.verificationSession.update({
        where: { id: session.id },
        data: { status: 'VERIFIED', verifiedAt: new Date() },
      });
      await this.auditService.log({
        actorType: AuditActorType.CUSTOMER,
        actorId: customerId,
        action: 'verification.dev_bypass_used',
        entityType: 'verification_session',
        entityId: session.id,
        success: true,
      });
      return { verified: true };
    }

    if (session.expiresAt.getTime() < Date.now()) {
      await this.failSession(session, 'expired');
      throw new UnauthorizedException('That verification code has expired. Please request a new one.');
    }

    const matches = session.codeHash ? await bcrypt.compare(code, session.codeHash) : false;
    if (!matches) {
      const attempts = session.attempts + 1;
      const exhausted = attempts >= session.maxAttempts;
      await this.prisma.verificationSession.update({
        where: { id: session.id },
        data: { attempts, status: exhausted ? 'VERIFICATION_FAILED' : 'VERIFICATION_IN_PROGRESS' },
      });
      await this.auditService.log({
        actorType: AuditActorType.CUSTOMER,
        actorId: customerId,
        action: 'verification.otp_failed_attempt',
        entityType: 'verification_session',
        entityId: session.id,
        result: { attempts, maxAttempts: session.maxAttempts },
        success: false,
      });
      if (exhausted) {
        await this.applyLockoutIfNeeded(customerId, purpose, session.id);
      }
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    await this.prisma.verificationSession.update({
      where: { id: session.id },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
    await this.auditService.log({
      actorType: AuditActorType.CUSTOMER,
      actorId: customerId,
      action: 'verification.verified',
      entityType: 'verification_session',
      entityId: session.id,
      result: { purpose, method: session.method },
      success: true,
    });
    return { verified: true };
  }

  /** The most recent VERIFIED, unconsumed session for a purpose — used by PIN/password completion steps. */
  async getVerifiedSession(
    customerId: string,
    conversationId: string | undefined,
    purpose: VerificationPurpose,
  ): Promise<VerificationSession | null> {
    const session = await this.prisma.verificationSession.findFirst({
      where: { customerId, conversationId: conversationId ?? null, purpose, status: 'VERIFIED', consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (session?.verifiedAt && Date.now() - session.verifiedAt.getTime() < VERIFIED_VALIDITY_MS) {
      return session;
    }
    return null;
  }

  async consumeSession(sessionId: string): Promise<void> {
    await this.prisma.verificationSession.update({ where: { id: sessionId }, data: { consumedAt: new Date() } });
  }

  private async failSession(session: VerificationSession, reason: string): Promise<void> {
    await this.prisma.verificationSession.update({
      where: { id: session.id },
      data: { status: 'VERIFICATION_FAILED' },
    });
    await this.auditService.log({
      actorType: AuditActorType.CUSTOMER,
      actorId: session.customerId,
      action: 'verification.otp_failed_attempt',
      entityType: 'verification_session',
      entityId: session.id,
      result: { reason },
      success: false,
    });
    await this.applyLockoutIfNeeded(session.customerId, session.purpose, session.id);
  }

  private async getActiveLockout(customerId: string, purpose: VerificationPurpose): Promise<Date | null> {
    const latest = await this.prisma.verificationSession.findFirst({
      where: { customerId, purpose, status: 'LOCKED' },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest?.lockedAt) return null;
    const unlockAt = new Date(latest.lockedAt.getTime() + LOCKOUT_DURATION_MS);
    return unlockAt.getTime() > Date.now() ? unlockAt : null;
  }

  /** After a session fails, checks whether the customer has now hit 3 consecutive failed sessions. */
  private async applyLockoutIfNeeded(customerId: string, purpose: VerificationPurpose, latestSessionId: string): Promise<void> {
    const recent = await this.prisma.verificationSession.findMany({
      where: { customerId, purpose },
      orderBy: { createdAt: 'desc' },
      take: LOCKOUT_THRESHOLD,
    });

    const allFailed = recent.length >= LOCKOUT_THRESHOLD && recent.every((s) => s.status === 'VERIFICATION_FAILED' || s.status === 'LOCKED');
    if (!allFailed) return;

    await this.prisma.verificationSession.update({
      where: { id: latestSessionId },
      data: { status: 'LOCKED', lockedAt: new Date() },
    });
    await this.auditService.log({
      actorType: AuditActorType.CUSTOMER,
      actorId: customerId,
      action: 'verification.locked',
      entityType: 'verification_session',
      entityId: latestSessionId,
      result: { purpose, lockedForMinutes: LOCKOUT_DURATION_MS / 60_000 },
      success: false,
    });
    this.logger.warn(`Customer ${customerId} locked out of ${purpose} verification for ${LOCKOUT_DURATION_MS / 60_000} minutes`);
  }
}
